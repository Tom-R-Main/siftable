#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { operations, moduleIds, type Operation } from '@siftable/contracts';
import {
  migrate,
  issueCredential,
  planModules,
  Pool,
  databaseUrlFromEnvironment,
} from '@siftable/core';
import { SiftClient } from '@siftable/client';
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean' },
    config: { type: 'string' },
    modules: { type: 'string' },
    output: { type: 'string' },
    url: { type: 'string' },
    'owner-id': { type: 'string' },
    'scope-id': { type: 'string' },
    role: { type: 'string' },
    permissions: { type: 'string' },
    json: { type: 'string' },
    file: { type: 'string' },
    key: { type: 'string' },
    id: { type: 'string' },
  },
});
const [command, ...rest] = positionals;
const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
async function main() {
  if (values.help || !command) {
    print({
      usage: 'sift <operation> --config <credential-file> --json <object> [--key <stable-key>]',
      administration: [
        'init --modules projects,context,work,planning,extensions --output <credential-file> --url http://127.0.0.1:8080',
        'modules-plan --modules context',
        'install --modules work',
        'credential --owner-id <id> --role agent --permissions work:read,work:write --output <file>',
        'revoke --id <principal-id>',
      ],
      adminEnvironment: 'SIFT_ADMIN_DATABASE_URL (read internally; never printed)',
      operations: Object.keys(operations),
      modules: moduleIds,
    });
    return;
  }
  if (command === 'modules-plan') {
    print(await planModules((values.modules ?? '').split(',').filter(Boolean)));
    return;
  }
  if (['init', 'install', 'credential', 'revoke'].includes(command)) {
    const db = await databaseUrlFromEnvironment(true);
    if (command === 'revoke') {
      if (!values.id) throw new Error('--id required');
      const pool = new Pool({ connectionString: db });
      try {
        const r = await pool.query('UPDATE foundation.principals SET revoked=true WHERE id=$1', [
          values.id,
        ]);
        print({ revoked: r.rowCount === 1 });
      } finally {
        await pool.end();
      }
      return;
    }
    if (command === 'init' || command === 'install') {
      const plan = await migrate(
        db,
        (values.modules ?? 'projects,context,work,planning,extensions').split(',').filter(Boolean),
      );
      if (command === 'install') {
        print({ installed: plan.map((m) => m.id) });
        return;
      }
    }
    if (!values.output) throw new Error('--output is required (new credential file, mode 0600)');
    if (command === 'credential' && !values['owner-id']) throw new Error('--owner-id required');
    if (values.role && !['owner', 'agent'].includes(values.role))
      throw new Error('--role must be owner or agent');
    print(
      await issueCredential(db, resolve(values.output), {
        apiUrl: values.url ?? 'http://127.0.0.1:8080',
        ownerId: values['owner-id'],
        scopeId: values['scope-id'] ?? null,
        role: values.role === 'agent' ? 'agent' : 'owner',
        permissions: (values.permissions ?? '').split(',').filter(Boolean),
      }),
    );
    return;
  }
  const name = [command, ...rest].join('.');
  const client = await SiftClient.fromFile(
    resolve(values.config ?? process.env.SIFT_CONFIG ?? '.local/owner.json'),
  );
  if (name === 'catalog') {
    print(await client.catalog());
    return;
  }
  if (!Object.hasOwn(operations, name)) throw new Error('Unknown operation; use --help');
  const input: unknown = JSON.parse(
    values.file ? await readFile(values.file, 'utf8') : (values.json ?? '{}'),
  );
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Input must be a JSON object');
  print(await client.invoke(name as Operation, input as Record<string, unknown>, values.key));
}
try {
  await main();
} catch (e) {
  // Never print database/transport internals, supplied input, or credentials.
  const known =
    e instanceof Error &&
    ('status' in e || !['init', 'install', 'credential', 'revoke'].includes(command ?? ''));
  process.stderr.write(
    JSON.stringify({
      error:
        known && e instanceof Error
          ? e.message
          : 'Local administration failed; check configuration and database readiness',
    }) + '\n',
  );
  process.exitCode = 1;
}
