import express from 'express';
import { ZodError } from 'zod';
import {
  Pool,
  assertRuntimeRole,
  catalog,
  execute,
  databaseUrlFromEnvironment,
} from '@siftable/core';
import { SiftError } from '@siftable/contracts';
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
  app.get('/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  });
  app.get('/v1/catalog', async (req, res) =>
    res.json({ data: await catalog(pool, token(req.headers.authorization)) }),
  );
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
        res.status(err.status).json({ error: { code: err.code, message: err.message } });
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
