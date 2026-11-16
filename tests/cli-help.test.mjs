import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { operations } from '../packages/contracts/dist/index.js';

const cli = fileURLToPath(new URL('../packages/cli/dist/index.js', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
const help = (...args) => {
  const result = run(...args, '--help', '--config', '/nonexistent/siftable-help-credential.json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
};

test('claim help discloses caller fields, optional defaults and bounds without credentials', () => {
  const result = help('work.claim');
  assert.equal(result.operation, 'work.claim');
  assert.deepEqual(result.inputSchema.required, ['id']);
  assert.equal(result.inputSchema.properties.id.format, 'uuid');
  assert.deepEqual(result.inputSchema.properties.leaseSeconds, {
    default: 300,
    type: 'integer',
    minimum: 1,
    maximum: 3600,
  });
  assert.match(result.requestKey, /Required: --key/);
  assert.match(result.leaseCustody, /generates and saves/);
});

test('artifact help describes complete public input and automatic lease custody', () => {
  const result = help('work', 'artifacts', 'add');
  assert.equal(result.operation, 'work.artifacts.add');
  assert.deepEqual(result.inputSchema.required, ['id', 'name', 'mediaType', 'content']);
  assert.equal(result.inputSchema.properties.content.maxLength, 64000);
  assert.equal(result.inputSchema.properties.mediaType.maxLength, 120);
  assert.match(result.leaseCustody, /active claim made with this credential/);
});

test('all registry operations expose input schemas without lease internals', () => {
  for (const [name, operation] of Object.entries(operations)) {
    const result = help(name);
    assert.equal(result.operation, name);
    assert.equal(result.inputSchema.additionalProperties, false);
    assert.equal(result.writes, operation.write);
    assert.equal(result.operatorRequired, operation.operator);
    assert.equal('requestKey' in result, operation.write);
    assert.equal('claimSecret' in result.inputSchema.properties, false);
    assert.equal('epoch' in result.inputSchema.properties, false);
    assert.equal(result.inputSchema.required.includes('claimSecret'), false);
    assert.equal(result.inputSchema.required.includes('epoch'), false);
  }
});

test('nested defaults are optional input and enums remain discoverable', () => {
  const create = help('work.create');
  assert.deepEqual(create.inputSchema.required, ['title', 'steps']);
  assert.deepEqual(create.inputSchema.properties.steps.items.required, ['key', 'title']);
  const evidence = help('work.evidence');
  assert.deepEqual(evidence.inputSchema.properties.outcome.enum, ['passed', 'failed', 'error']);
});

test('help skips payload and credential access, and global help points to operation help', () => {
  const result = help('work.claim', '--json', 'invalid-json', '--file', '/nonexistent/input.json');
  assert.equal(result.operation, 'work.claim');
  const global = help();
  assert.ok(global.operations.includes('work.claim'));
  assert.match(global.operationHelp, /sift <operation> --help/);
  assert.ok(help('backup').administration.length > 0);
});

test('unknown operation help fails clearly before reading any credential', () => {
  const result = run('work.not-real', '--help', '--config', '/nonexistent/credential.json');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'Unknown operation; use --help');
});
