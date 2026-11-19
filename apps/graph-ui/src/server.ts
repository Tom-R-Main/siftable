import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z, ZodError } from 'zod';
import { SiftClient, readCredentials, type Credentials } from '@siftable/client';
import { SiftError } from '@siftable/contracts';
import { DemoWorkStore, type HarnessSession } from './demoStore.js';
import { renderGraphUiHtml } from './uiHtml.js';

const harnessSessionDataSchema = z.object({
  harness: z.enum(['antigravity', 'codex', 't3-code', 'claude-code', 'cursor', 'cli', 'other']),
  workId: z.string().min(1).max(128),
  threadId: z.string().min(1).max(256),
  model: z.string().min(1).max(128).optional(),
  mode: z.enum(['discuss', 'build', 'review']).optional(),
  branch: z.string().min(1).max(256).optional(),
  worktreePath: z.string().min(1).max(1024).optional(),
  deepLink: z.string().min(1).max(2048).optional(),
});

function groupSessionsByWorkId(
  sessions: HarnessSession[],
  allowedWorkIds?: Set<string>,
): Record<string, HarnessSession[]> {
  const grouped: Record<string, HarnessSession[]> = {};
  for (const session of sessions) {
    if (allowedWorkIds && !allowedWorkIds.has(session.workId)) continue;
    (grouped[session.workId] ??= []).push(session);
  }
  return grouped;
}

async function fetchHarnessSessions(c: SiftClient): Promise<HarnessSession[]> {
  const sessions: HarnessSession[] = [];
  const pageSize = 100;
  const maxPages = 5;
  try {
    for (let page = 0; page < maxPages; page += 1) {
      const rows = await c.invoke('objects.list', {
        type: 'harness.session',
        limit: pageSize,
        offset: page * pageSize,
      });
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const record = row as { id?: unknown; data?: unknown };
        if (typeof record.id !== 'string' || !record.id) continue;
        const parsed = harnessSessionDataSchema.safeParse(record.data);
        if (parsed.success) {
          sessions.push({ id: record.id, ...parsed.data });
        }
      }
      if (rows.length < pageSize) break;
    }
  } catch {
    return [];
  }
  return sessions;
}

const createBody = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(100_000).default(''),
    projectId: z.uuid().optional(),
    dependencies: z
      .array(z.object({ id: z.uuid(), gate: z.enum(['done', 'commands_passed']).default('done') }))
      .max(100)
      .default([]),
    steps: z
      .array(
        z.object({
          key: z.string().min(1).max(128),
          title: z.string().trim().min(1).max(500),
          required: z.boolean().default(true),
        }),
      )
      .min(1)
      .max(50),
  })
  .strict();

const forkBody = z
  .object({
    revision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(500),
    gate: z.enum(['done', 'commands_passed']).default('done'),
    branches: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(500),
          description: z.string().max(100_000).default(''),
        }),
      )
      .min(1)
      .max(25),
  })
  .strict();

const acceptBody = z.object({ summary: z.string().trim().min(1).max(100_000) }).strict();
const reasonBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

export interface GraphUiOptions {
  port?: number;
  host?: string;
  configPath?: string;
  forceDemo?: boolean;
}

function defaultConfigPath(): string {
  if (process.env.SIFT_CONFIG) return resolve(process.env.SIFT_CONFIG);
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../../.local/owner.json');
}

export async function startGraphUiServer(options: GraphUiOptions = {}) {
  const host = options.host ?? '127.0.0.1';
  const port =
    options.port ??
    Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT ?? process.env.SIFT_UI_PORT ?? 7041);
  const configPath = options.configPath ?? defaultConfigPath();
  const forceDemo = options.forceDemo ?? process.env.SIFT_UI_DEMO === '1';

  const demo = new DemoWorkStore();
  let client: SiftClient | null = null;
  let liveCredentials: Credentials | null = null;
  let liveReady = false;
  const activeSseCleanups = new Set<() => void>();

  async function tryConnectLive(): Promise<boolean> {
    if (forceDemo) {
      liveReady = false;
      liveCredentials = null;
      return false;
    }
    if (!existsSync(configPath)) {
      liveReady = false;
      liveCredentials = null;
      return false;
    }
    try {
      const creds = await readCredentials(configPath);
      const nextClient = await SiftClient.fromFile(configPath);
      await nextClient.catalog();
      client = nextClient;
      liveCredentials = creds;
      liveReady = true;
      return true;
    } catch {
      client = null;
      liveCredentials = null;
      liveReady = false;
      return false;
    }
  }

  await tryConnectLive();

  async function withMode<T>(
    liveFn: (c: SiftClient) => Promise<T>,
    demoFn: () => T | Promise<T>,
  ): Promise<{ mode: 'live' | 'demo'; data: T }> {
    if (!liveReady && !forceDemo) await tryConnectLive();
    if (liveReady && client) {
      try {
        return { mode: 'live', data: await liveFn(client) };
      } catch (err) {
        if (err instanceof SiftError) throw err;
        liveReady = false;
        liveCredentials = null;
        client = null;
      }
    }
    return { mode: 'demo', data: await demoFn() };
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
    );
    next();
  });

  const html = renderGraphUiHtml();
  app.get('/', (_req, res) => {
    res.type('text/html; charset=utf-8').send(html);
  });
  app.get('/graph', (_req, res) => {
    res.type('text/html; charset=utf-8').send(html);
  });

  app.get('/api/health', async (_req, res) => {
    res.json({ status: 'ok', mode: liveReady ? 'live' : 'demo' });
  });

  app.post('/api/reconnect', async (_req, res) => {
    const ok = await tryConnectLive();
    res.json({ mode: ok ? 'live' : 'demo' });
  });

  app.get('/api/events', async (req, res) => {
    if (!liveReady && !forceDemo) await tryConnectLive();

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let closed = false;
    const abortController = new AbortController();
    let unsubscribeDemo: (() => void) | null = null;

    const heartbeat = setInterval(() => {
      if (closed || res.writableEnded) return;
      try {
        res.write(': heartbeat\n\n');
      } catch {
        cleanup();
      }
    }, 25_000);
    heartbeat.unref();

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      activeSseCleanups.delete(cleanup);
      if (unsubscribeDemo) {
        unsubscribeDemo();
        unsubscribeDemo = null;
      }
      abortController.abort();
      if (!res.writableEnded) {
        res.end();
      }
    };

    activeSseCleanups.add(cleanup);
    req.on('close', cleanup);
    res.on('close', cleanup);

    if (!liveReady || !liveCredentials) {
      res.write(': connected\n\n');
      unsubscribeDemo = demo.onUpdate((ev) => {
        if (closed || res.writableEnded) return;
        try {
          res.write(`event: update\ndata: ${JSON.stringify(ev)}\n\n`);
        } catch {
          cleanup();
        }
      });
      return;
    }

    const upstreamUrl = new URL('/v1/events', liveCredentials.apiUrl);
    const upstreamToken = liveCredentials.token;
    try {
      const upstream = await fetch(upstreamUrl, {
        headers: {
          Authorization: `Bearer ${upstreamToken}`,
          Accept: 'text/event-stream',
        },
        redirect: 'error',
        signal: abortController.signal,
      });
      if (!upstream.ok || !upstream.body) {
        cleanup();
        return;
      }
      if (closed || res.writableEnded) {
        cleanup();
        return;
      }
      res.write(': connected\n\n');

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        if (closed || res.writableEnded) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let sep = buffer.indexOf('\n\n');
        while (sep !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          sep = buffer.indexOf('\n\n');
          if (!block.trim()) continue;
          let eventName = '';
          const dataLines: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).trimStart());
            }
          }
          if (eventName === 'update' && dataLines.length > 0 && !closed && !res.writableEnded) {
            res.write(`event: update\ndata: ${dataLines.join('\n')}\n\n`);
          }
        }
      }
    } catch {
      // Upstream stream ended or aborted; let EventSource reconnect cleanly.
    } finally {
      cleanup();
    }
  });

  app.get('/api/graph', async (req, res) => {
    const rootId =
      typeof req.query.rootId === 'string' && req.query.rootId ? req.query.rootId : undefined;
    const projectId =
      typeof req.query.projectId === 'string' && req.query.projectId
        ? req.query.projectId
        : undefined;
    const result = await withMode(
      async (c) => {
        const graph = await c.invoke('work.graph', {
          ...(projectId ? { projectId } : {}),
          ...(rootId ? { rootId } : {}),
        });
        let projects: unknown[] = [];
        try {
          const list = await c.invoke('projects.list', { limit: 100, offset: 0 });
          if (Array.isArray(list)) projects = list;
        } catch {
          projects = [];
        }
        const graphNodes =
          graph && typeof graph === 'object' && 'nodes' in graph && Array.isArray(graph.nodes)
            ? (graph.nodes as { id?: unknown }[])
            : [];
        const allowedWorkIds = new Set(
          graphNodes
            .map((node) => (typeof node.id === 'string' ? node.id : null))
            .filter((id): id is string => id !== null),
        );
        const sessions = await fetchHarnessSessions(c);
        const sessionsByWorkId = groupSessionsByWorkId(sessions, allowedWorkIds);
        return { graph, projects, sessionsByWorkId };
      },
      () => {
        const graph = demo.graph(rootId);
        const allowedWorkIds = new Set(graph.nodes.map((node) => node.id));
        return {
          graph,
          projects: [],
          sessionsByWorkId: demo.sessionsByWorkId(allowedWorkIds),
        };
      },
    );
    res.json({
      mode: result.mode,
      data: result.data.graph,
      projects: result.data.projects,
      sessionsByWorkId: result.data.sessionsByWorkId,
    });
  });

  app.get('/api/work/:id', async (req, res) => {
    const workId = z.uuid().parse(req.params.id);
    const result = await withMode(
      async (c) => {
        const work = await c.invoke('work.get', { id: workId });
        const sessions = (await fetchHarnessSessions(c)).filter((s) => s.workId === workId);
        return { work, sessions };
      },
      () => {
        const found = demo.getWork(workId);
        if (!found) throw new SiftError(404, 'not_found', 'Work item not found');
        return { work: found, sessions: demo.sessionsForWork(workId) };
      },
    );
    res.json({
      mode: result.mode,
      data: result.data.work,
      sessions: result.data.sessions,
    });
  });

  app.get('/api/work/:id/artifacts/:artifactId', async (req, res) => {
    const workId = z.uuid().parse(req.params.id);
    const artifactId = z.uuid().parse(req.params.artifactId);
    const result = await withMode(
      (c) => c.invoke('work.artifacts.get', { id: workId, artifactId }),
      () => {
        const found = demo.getArtifact(workId, artifactId);
        if (!found) throw new SiftError(404, 'not_found', 'Artifact not found');
        return found;
      },
    );
    res.json(result);
  });

  app.post('/api/work/create', async (req, res) => {
    const body = createBody.parse(req.body);
    const key = `ui-create-${randomUUID()}`;
    const result = await withMode(
      (c) => c.invoke('work.create', body, key),
      () => demo.create(body),
    );
    res.json(result);
  });

  app.post('/api/work/:id/fork', async (req, res) => {
    const workId = z.uuid().parse(req.params.id);
    const body = forkBody.parse(req.body);
    const key = `ui-fork-${randomUUID()}`;
    const result = await withMode(
      (c) => c.invoke('work.fork', { id: workId, ...body }, key),
      () => demo.fork(workId, body),
    );
    res.json(result);
  });

  app.post('/api/work/:id/accept', async (req, res) => {
    const workId = z.uuid().parse(req.params.id);
    const body = acceptBody.parse(req.body);
    const key = `ui-accept-${randomUUID()}`;
    const result = await withMode(
      (c) => c.invoke('work.accept', { id: workId, summary: body.summary }, key),
      () => demo.accept(workId, body.summary),
    );
    res.json(result);
  });

  app.post('/api/work/:id/requeue', async (req, res) => {
    const workId = z.uuid().parse(req.params.id);
    const body = reasonBody.parse(req.body);
    const key = `ui-requeue-${randomUUID()}`;
    const result = await withMode(
      (c) => c.invoke('work.requeue', { id: workId, reason: body.reason }, key),
      () => demo.requeue(workId, body.reason),
    );
    res.json(result);
  });

  app.post('/api/work/:id/cancel', async (req, res) => {
    const workId = z.uuid().parse(req.params.id);
    const body = reasonBody.parse(req.body);
    const key = `ui-cancel-${randomUUID()}`;
    const result = await withMode(
      (c) => c.invoke('work.cancel', { id: workId, reason: body.reason }, key),
      () => demo.cancel(workId, body.reason),
    );
    res.json(result);
  });

  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof SiftError) {
        res.status(err.status).json({ error: { code: err.code, message: err.message } });
        return;
      }
      if (err instanceof ZodError) {
        res
          .status(400)
          .json({ error: { code: 'invalid_input', message: 'Invalid request input' } });
        return;
      }
      const message = err instanceof Error ? err.message : 'Operation failed';
      res.status(400).json({ error: { code: 'request_failed', message } });
    },
  );

  const server = await new Promise<ReturnType<typeof app.listen>>((resolveListen) => {
    const s = app.listen(port, host, () => resolveListen(s));
  });
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    server,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: async () => {
      for (const cleanup of [...activeSseCleanups]) {
        cleanup();
      }
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((e) => (e ? rejectClose(e) : resolveClose())),
      );
    },
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const runtime = await startGraphUiServer();
  process.stdout.write(
    JSON.stringify({ status: 'listening', url: runtime.url, port: runtime.port }) + '\n',
  );
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      void runtime.close().then(() => process.exit(0));
    });
  }
}
