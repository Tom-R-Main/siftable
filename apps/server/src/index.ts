import express from 'express';
import { ZodError } from 'zod';
import {
  Pool,
  assertRuntimeRole,
  authenticate,
  catalog,
  execute,
  databaseUrlFromEnvironment,
  isDomainEventVisibleToPrincipal,
  subscribeDomainEvents,
  type DomainEvent,
} from '@siftable/core';
import { SiftError, type Principal } from '@siftable/contracts';
export async function startServer(databaseUrl: string, port = 8080, host = '127.0.0.1') {
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  await assertRuntimeRole(pool);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  const token = (header: string | undefined) => {
    if (!header?.startsWith('Bearer '))
      throw new SiftError(401, 'unauthorized', 'Bearer credential required');
    return header.slice(7);
  };

  interface SseClient {
    principal: Principal;
    res: express.Response;
    close: () => void;
  }
  const sseClients = new Set<SseClient>();
  let unsubscribeEvents: (() => Promise<void>) | null = null;
  let subscribePromise: Promise<void> | null = null;
  let serverClosing = false;

  const broadcastDomainEvent = (ev: DomainEvent) => {
    const data = JSON.stringify({
      operation: ev.operation,
      module: ev.module,
      scopeId: ev.scopeId,
      timestamp: ev.timestamp,
    });
    const frame = `event: update\ndata: ${data}\n\n`;
    for (const client of sseClients) {
      if (!isDomainEventVisibleToPrincipal(ev, client.principal)) continue;
      if (!client.res.writableEnded) {
        try {
          client.res.write(frame);
        } catch {
          client.close();
        }
      }
    }
  };

  const ensureEventListener = async () => {
    if (unsubscribeEvents) return;
    if (!subscribePromise) {
      subscribePromise = subscribeDomainEvents(pool, broadcastDomainEvent)
        .then((unsub) => {
          if (serverClosing) {
            void unsub();
            return;
          }
          unsubscribeEvents = unsub;
        })
        .finally(() => {
          subscribePromise = null;
        });
    }
    await subscribePromise;
  };

  const stopEventListener = async () => {
    if (subscribePromise) {
      try {
        await subscribePromise;
      } catch {
        // Ignore failed subscribe during shutdown.
      }
    }
    const unsub = unsubscribeEvents;
    unsubscribeEvents = null;
    if (unsub) {
      await unsub();
    }
  };

  app.get('/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  });
  app.get('/v1/catalog', async (req, res) =>
    res.json({ data: await catalog(pool, token(req.headers.authorization)) }),
  );
  app.get('/v1/events', async (req, res) => {
    const principal = await authenticate(pool, token(req.headers.authorization));
    if (serverClosing) {
      res.status(503).end();
      return;
    }
    await ensureEventListener();

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(': connected\n\n');

    let closed = false;
    const heartbeat = setInterval(() => {
      if (closed || res.writableEnded) return;
      try {
        res.write(': heartbeat\n\n');
      } catch {
        client.close();
      }
    }, 25_000);
    heartbeat.unref();

    const client: SseClient = {
      principal,
      res,
      close: () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        sseClients.delete(client);
        if (!res.writableEnded) {
          res.end();
        }
      },
    };
    sseClients.add(client);

    req.on('close', client.close);
    res.on('close', client.close);
  });
  app.post('/v1/operations/:name', async (req, res) =>
    res.json({
      data: await execute(
        pool,
        token(req.headers.authorization),
        req.params.name,
        req.body,
        req.header('Idempotency-Key'),
      ),
    }),
  );
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof SiftError) {
        res.status(err.status).json({
          error: {
            code: err.code,
            message: err.message,
            ...(err.suggestions && err.suggestions.length > 0
              ? { suggestions: err.suggestions }
              : {}),
            ...(err.details ? { details: err.details } : {}),
          },
        });
        return;
      }
      if (err instanceof ZodError) {
        res.status(400).json({
          error: { code: 'invalid_input', message: 'Input does not match the operation schema' },
        });
        return;
      }
      const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
      if (['23505', '23514', '23503'].includes(code)) {
        res.status(409).json({
          error: {
            code: 'constraint_conflict',
            message: 'The operation conflicts with a stored invariant',
          },
        });
        return;
      }
      // Database errors can contain parameter values: never reflect or log them.
      res.status(500).json({ error: { code: 'internal_error', message: 'Operation failed' } });
    },
  );
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(port, host, () => resolve(s));
  });
  return {
    server,
    pool,
    close: async () => {
      serverClosing = true;
      for (const client of [...sseClients]) {
        client.close();
      }
      await stopEventListener();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await pool.end();
    },
  };
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const url = await databaseUrlFromEnvironment();
  const runtime = await startServer(
    url,
    Number(process.env.PORT ?? 8080),
    process.env.SIFT_HOST ?? '127.0.0.1',
  );
  process.stdout.write(
    JSON.stringify({ status: 'listening', address: runtime.server.address() }) + '\n',
  );
  for (const sig of ['SIGINT', 'SIGTERM'])
    process.once(sig, () => {
      void runtime.close().then(() => process.exit(0));
    });
}
