import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { SiftError } from '../packages/contracts/dist/index.js';

function runCliAsync(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['packages/cli/dist/index.js', ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

async function startMockServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    close: () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

test('config.info exposes only identity metadata and respects protected-file checks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sift-config-test-'));
  try {
    const path = join(directory, 'owner.json');
    const metadata = { ownerId: randomUUID(), principalId: randomUUID(), scopeId: null };
    const token = 'test-only-opaque-credential-do-not-emit';
    await writeFile(path, JSON.stringify({ ...metadata, apiUrl: 'http://127.0.0.1:1', token }), {
      mode: 0o600,
    });
    const run = () =>
      spawnSync(process.execPath, ['packages/cli/dist/index.js', 'config.info', '--config', path], {
        encoding: 'utf8',
      });
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), metadata);
    assert.equal((result.stdout + result.stderr).includes(token), false);
    await chmod(path, 0o644);
    result = run();
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /mode 0600/);
    assert.equal(result.stderr.includes(token), false);
    const parsedErr = JSON.parse(result.stderr);
    assert.equal(parsedErr.code, 'insecure_config');
    assert.ok(Array.isArray(parsedErr.suggestions) && parsedErr.suggestions.length > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('doctor --help succeeds without credentials and help defaults to port 8088', () => {
  const result = spawnSync(
    process.execPath,
    ['packages/cli/dist/index.js', 'doctor', '--help', '--config', '/nonexistent/doctor.json'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const help = JSON.parse(result.stdout);
  assert.match(help.doctor, /sift doctor/);
  assert.ok(help.administration.some((line) => line.includes('http://127.0.0.1:8088')));
  assert.ok(!help.administration.some((line) => line.includes('http://127.0.0.1:8080')));
});

test('sift doctor reports missing config with actionable next steps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sift-doctor-missing-'));
  try {
    const missingPath = join(directory, 'does-not-exist.json');
    const result = await runCliAsync(['doctor', '--config', missingPath]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.configPath, missingPath);
    assert.equal(report.identity, null);
    assert.equal(report.apiUrl, null);
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0].name, 'config');
    assert.equal(report.checks[0].ok, false);
    assert.ok(Array.isArray(report.next) && report.next.length > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('sift doctor rejects mode 0644 config without ever leaking token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sift-doctor-perms-'));
  try {
    const path = join(directory, 'owner.json');
    const token = 'secret-token-0644-must-never-appear-in-output';
    await writeFile(
      path,
      JSON.stringify({
        ownerId: randomUUID(),
        principalId: randomUUID(),
        scopeId: null,
        apiUrl: 'http://127.0.0.1:8088',
        token,
      }),
      { mode: 0o600 },
    );
    await chmod(path, 0o644);
    const result = await runCliAsync(['doctor', '--config', path]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.equal((result.stdout + result.stderr).includes(token), false);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.identity, null);
    assert.equal(report.apiUrl, null);
    assert.equal(report.checks[0].name, 'config');
    assert.equal(report.checks[0].ok, false);
    assert.match(report.checks[0].detail, /mode 0600/);
    assert.match(report.checks[0].detail, /0644/);
    assert.ok(report.next.some((step) => step.includes('chmod 600')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('sift doctor rejects unsafe non-loopback HTTP URL and redacts embedded credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sift-doctor-url-'));
  try {
    const path = join(directory, 'owner.json');
    const token = 'secret-token-unsafe-url-never-emit-123456';
    const embeddedPassword = 'embedded-url-secret-password';
    await writeFile(
      path,
      JSON.stringify({
        ownerId: randomUUID(),
        principalId: randomUUID(),
        scopeId: null,
        apiUrl: `http://admin:${embeddedPassword}@example.com:8088`,
        token,
      }),
      { mode: 0o600 },
    );
    const result = await runCliAsync(['doctor', '--config', path]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.equal((result.stdout + result.stderr).includes(token), false);
    assert.equal((result.stdout + result.stderr).includes(embeddedPassword), false);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.apiUrl, 'http://example.com:8088');
    const urlCheck = report.checks.find((c) => c.name === 'api_url');
    assert.ok(urlCheck);
    assert.equal(urlCheck.ok, false);
    assert.ok(report.next.length > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('sift doctor reports unreachable loopback API URL with actionable next steps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sift-doctor-unreachable-'));
  // Bind and immediately close an ephemeral loopback port so connection is refused cleanly.
  const closedServer = await startMockServer((_req, res) => res.end());
  const unreachableUrl = closedServer.url;
  await closedServer.close();

  try {
    const path = join(directory, 'owner.json');
    const metadata = { ownerId: randomUUID(), principalId: randomUUID(), scopeId: null };
    const token = 'secret-token-unreachable-api-never-emit-99';
    await writeFile(path, JSON.stringify({ ...metadata, apiUrl: unreachableUrl, token }), {
      mode: 0o600,
    });
    const result = await runCliAsync(['doctor', '--config', path]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.equal((result.stdout + result.stderr).includes(token), false);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.deepEqual(report.identity, metadata);
    assert.equal(report.apiUrl, unreachableUrl);
    assert.equal(report.checks.find((c) => c.name === 'config')?.ok, true);
    assert.equal(report.checks.find((c) => c.name === 'api_url')?.ok, true);
    assert.equal(report.checks.find((c) => c.name === 'health')?.ok, false);
    assert.ok(report.next.some((step) => step.includes('8088')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('sift doctor succeeds against mock loopback server with /health, /v1/catalog, and modules.list without leaking token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sift-doctor-ok-'));
  const token = 'secret-token-healthy-mock-server-do-not-leak';
  const metadata = { ownerId: randomUUID(), principalId: randomUUID(), scopeId: null };
  let sawCatalogAuth = false;
  let sawModulesAuth = false;

  const mock = await startMockServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/catalog') {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'Invalid token' } }));
        return;
      }
      sawCatalogAuth = true;
      res.writeHead(200);
      res.end(
        JSON.stringify({
          data: [
            { name: 'modules.list', module: 'foundation', write: false },
            { name: 'work.list', module: 'work', write: false },
          ],
        }),
      );
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/operations/modules.list') {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'Invalid token' } }));
        return;
      }
      sawModulesAuth = true;
      res.writeHead(200);
      res.end(
        JSON.stringify({
          data: [
            { id: 'foundation', version: 2, enabled: true },
            { id: 'work', version: 2, enabled: true },
            { id: 'extensions', version: 2, enabled: false },
          ],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }));
  });

  try {
    const path = join(directory, 'owner.json');
    await writeFile(path, JSON.stringify({ ...metadata, apiUrl: mock.url, token }), {
      mode: 0o600,
    });
    const result = await runCliAsync(['doctor', '--config', path]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal((result.stdout + result.stderr).includes(token), false);
    assert.equal(sawCatalogAuth, true);
    assert.equal(sawModulesAuth, true);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.configPath, path);
    assert.deepEqual(report.identity, metadata);
    assert.equal(report.apiUrl, mock.url);
    assert.deepEqual(report.next, []);
    assert.deepEqual(
      report.checks.map((c) => [c.name, c.ok]),
      [
        ['config', true],
        ['api_url', true],
        ['health', true],
        ['catalog', true],
        ['modules', true],
      ],
    );
    const modulesCheck = report.checks.find((c) => c.name === 'modules');
    assert.match(modulesCheck.detail, /foundation, work/);
    assert.match(modulesCheck.detail, /disabled: extensions/);
  } finally {
    await mock.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('sift doctor succeeds for scoped credentials without modules.list permission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sift-doctor-scoped-'));
  const token = 'secret-token-scoped-agent-do-not-leak-0001';
  const metadata = { ownerId: randomUUID(), principalId: randomUUID(), scopeId: randomUUID() };
  let modulesListCalled = false;

  const mock = await startMockServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/catalog') {
      res.writeHead(200);
      res.end(JSON.stringify({ data: [{ name: 'work.list', module: 'work', write: false }] }));
      return;
    }
    if (req.url === '/v1/operations/modules.list') {
      modulesListCalled = true;
    }
    res.writeHead(403);
    res.end(JSON.stringify({ error: { code: 'forbidden', message: 'Forbidden' } }));
  });

  try {
    const path = join(directory, 'worker.json');
    await writeFile(path, JSON.stringify({ ...metadata, apiUrl: mock.url, token }), {
      mode: 0o600,
    });
    const result = await runCliAsync(['doctor', '--config', path]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal((result.stdout + result.stderr).includes(token), false);
    assert.equal(modulesListCalled, false);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.deepEqual(report.identity, metadata);
    const modulesCheck = report.checks.find((c) => c.name === 'modules');
    assert.equal(modulesCheck?.ok, true);
    assert.match(modulesCheck?.detail ?? '', /modules\.list not permitted/);
  } finally {
    await mock.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('sift doctor and CLI errors redact tokens and emit structured code/status/suggestions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sift-doctor-401-'));
  const token = 'secret-token-revoked-must-never-leak-401';
  const metadata = { ownerId: randomUUID(), principalId: randomUUID(), scopeId: null };

  const mock = await startMockServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(401);
    res.end(
      JSON.stringify({
        error: { code: 'unauthorized', message: `Rejected credential ${token}` },
      }),
    );
  });

  try {
    const path = join(directory, 'owner.json');
    await writeFile(path, JSON.stringify({ ...metadata, apiUrl: mock.url, token }), {
      mode: 0o600,
    });
    const doctorResult = await runCliAsync(['doctor', '--config', path]);
    assert.equal(doctorResult.status, 1);
    assert.equal(doctorResult.stderr, '');
    assert.equal((doctorResult.stdout + doctorResult.stderr).includes(token), false);
    const report = JSON.parse(doctorResult.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((c) => c.name === 'catalog')?.ok, false);
    assert.ok(report.next.length > 0);

    const catalogResult = await runCliAsync(['catalog', '--config', path]);
    assert.equal(catalogResult.status, 1);
    assert.equal(catalogResult.stdout, '');
    const errPayload = JSON.parse(catalogResult.stderr);
    assert.equal(typeof errPayload.error, 'string');
    assert.equal(errPayload.code, 'unauthorized');
    assert.equal(errPayload.status, 401);
    assert.ok(Array.isArray(errPayload.suggestions) && errPayload.suggestions.length > 0);

    // Verify SiftError optional suggestions parameter is backward-compatible.
    const legacyErr = new SiftError(409, 'revision_conflict', 'Stale revision');
    assert.equal(legacyErr.status, 409);
    assert.equal(legacyErr.code, 'revision_conflict');
    assert.equal(legacyErr.suggestions, undefined);
    const suggestedErr = new SiftError(409, 'revision_conflict', 'Stale revision', [
      'Re-read the latest revision before retrying.',
    ]);
    assert.deepEqual(suggestedErr.suggestions, ['Re-read the latest revision before retrying.']);
  } finally {
    await mock.close();
    await rm(directory, { recursive: true, force: true });
  }
});
