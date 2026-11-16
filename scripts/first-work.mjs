// A runnable README example. All application access goes through the public CLI or stdio MCP.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const runId = randomUUID();
const owner = '.local/owner.json';
const worker = `.local/first-work-${runId}.json`;
const cliPath = resolve('packages/cli/dist/index.js');
function command(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 120_000 });
  if (result.error || result.status !== 0)
    throw new Error(
      `Command failed: ${executable} ${args[0]}: ${result.stderr || result.error?.message}`,
    );
  return JSON.parse(result.stdout);
}
function cli(operation, input = {}, config = owner, key) {
  console.log(`CLI ${operation}`);
  return command(process.execPath, [
    cliPath,
    operation,
    '--config',
    config,
    '--json',
    JSON.stringify(input),
    ...(key ? ['--key', `${runId}:${key}`] : []),
  ]);
}
function admin(args) {
  return command('docker', ['compose', 'run', '--rm', '-T', 'admin', ...args]);
}
const catalog = cli('catalog');
for (const operation of [
  'projects.create',
  'notes.create',
  'context.packet',
  'work.create',
  'work.accept',
]) {
  assert.ok(
    catalog.some((entry) => entry.name === operation),
    `Example requires projects,context,work and an owner credential; missing ${operation}`,
  );
}
const identity = cli('config.info');
const principal = admin([
  'credential',
  '--owner-id',
  identity.ownerId,
  ...(identity.scopeId ? ['--scope-id', identity.scopeId] : []),
  '--role',
  'agent',
  '--permissions',
  'foundation:read,projects:read,context:read,context:write,work:read,work:write',
  '--output',
  `/run/sift/first-work-${runId}.json`,
  '--url',
  `http://127.0.0.1:${process.env.SIFT_PORT ?? '8088'}`,
]);
const mcp = new Client({ name: 'siftable-readme-example', version: '1.0.0' });
try {
  const project = cli(
    'projects.create',
    {
      title: 'My first headless project',
      instructions: 'Preserve source context; verify before acceptance.',
    },
    owner,
    'project',
  );
  const body =
    'Success means the MCP worker reads this exact note and hands verified work back to the CLI owner.';
  const note = cli(
    'notes.create',
    {
      title: 'First work acceptance',
      body,
      projectId: project.id,
      source: 'README.md#first-complete-workflow',
    },
    owner,
    'note',
  );
  const input = {
    title: 'Prove the first CLI/MCP workflow',
    projectId: project.id,
    contextIds: [note.id],
    steps: [{ key: 'read-context', title: 'MCP reads the exact source note' }],
  };
  const work = cli('work.create', input, owner, 'work');
  assert.equal(cli('work.create', input, owner, 'work').id, work.id);
  cli('work.claim', { id: work.id }, worker, 'claim');
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('packages/mcp/dist/index.js')],
      env: { SIFT_CONFIG: resolve(worker), SIFT_TOOLS: 'projects,context,work' },
      stderr: 'pipe',
    }),
  );
  const { tools } = await mcp.listTools();
  assert.ok(tools.some((tool) => tool.name === 'notes_get'));
  assert.ok(!tools.some((tool) => tool.name === 'work_accept'));
  async function call(name, args, key) {
    console.log(`MCP ${name}`);
    const response = await mcp.callTool({
      name,
      arguments: { ...args, ...(key ? { requestKey: `${runId}:${key}` } : {}) },
    });
    assert.notEqual(response.isError, true, `MCP ${name} failed`);
    return response.structuredContent.data;
  }
  await call('work_start', { id: work.id }, 'start');
  assert.equal((await call('notes_get', { id: note.id })).body, body);
  const packet = await call('context_packet', { noteIds: [note.id] }, 'packet');
  assert.equal(packet.manifest.items[0].revision, 1);
  const passed = await call(
    'work_evidence',
    {
      id: work.id,
      planVersion: work.plan_version,
      stepId: work.plan.steps[0].id,
      attemptId: 'read-source',
      outcome: 'passed',
      output: 'MCP returned the exact CLI-created note body and source revision 1.',
      provenance: 'scripts/first-work.mjs; Node strict equality assertions',
    },
    'evidence',
  );
  assert.equal(passed.coverage.state, 'commands_passed');
  await call(
    'work_review',
    {
      id: work.id,
      summary: 'README example assertions passed; ready for scripted owner acceptance.',
    },
    'review',
  );
  assert.equal(
    (
      await mcp.callTool({
        name: 'work_accept',
        arguments: {
          id: work.id,
          summary: 'Forbidden agent acceptance',
          requestKey: `${runId}:denied`,
        },
      })
    ).isError,
    true,
  );
  const denied = spawnSync(
    process.execPath,
    [
      cliPath,
      'work.accept',
      '--config',
      worker,
      '--key',
      `${runId}:denied-direct`,
      '--json',
      JSON.stringify({ id: work.id, summary: 'Forbidden CLI agent acceptance' }),
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /Credential does not authorize this operation/);
  const accepted = cli(
    'work.accept',
    {
      id: work.id,
      summary:
        'Scripted owner verified the example assertions. This is not independent human acceptance.',
    },
    owner,
    'accept',
  );
  assert.equal(accepted.status, 'done');
  assert.equal(accepted.accepted_by, identity.principalId);
  const receipt = {
    runId,
    projectId: project.id,
    noteId: note.id,
    workId: work.id,
    packetId: packet.id,
    status: accepted.status,
    coverage: accepted.coverage.state,
    agentAcceptanceRefused: true,
    credentialRevoked: false,
  };
  const revoked = admin(['revoke', '--id', principal.principalId]);
  assert.equal(revoked.revoked, true);
  receipt.credentialRevoked = true;
  await writeFile('.local/first-work.json', JSON.stringify(receipt, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await mcp.close();
  // Also revoke on a partial run. Records remain available for inspection.
  admin(['revoke', '--id', principal.principalId]);
}
