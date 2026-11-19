#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { operations, moduleIds, SiftError, type Operation } from '@siftable/contracts';
import {
  backupDatabase,
  restoreDatabase,
  verifyBackup,
  migrate,
  issueCredential,
  planModules,
  Pool,
  databaseUrlFromEnvironment,
} from '@siftable/core';
import { SiftClient, readCredentials, type Credentials } from '@siftable/client';
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean' },
    database: { type: 'string' },
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
const defaultPort = process.env.SIFT_PORT?.trim() || '8088';
const defaultApiUrl = `http://127.0.0.1:${defaultPort}`;
const adminCommands = [
  'init',
  'install',
  'credential',
  'revoke',
  'backup',
  'restore',
  'backup-verify',
];
const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

interface DoctorReport {
  ok: boolean;
  configPath: string;
  identity: {
    ownerId: string;
    principalId: string;
    scopeId: string | null;
  } | null;
  apiUrl: string | null;
  checks: DoctorCheck[];
  next: string[];
}

function redactToken(text: string, token?: string): string {
  if (!token) return text;
  return text.includes(token) ? text.split(token).join('[REDACTED]') : text;
}

function safeDisplayUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return '<invalid-url>';
  }
}

function checkApiUrl(raw: string): { ok: boolean; detail: string } {
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.search || u.hash) {
      return {
        ok: false,
        detail: 'API URL must not include embedded credentials, query parameters, or fragments',
      };
    }
    const isHttps = u.protocol === 'https:';
    const isLoopbackHttp =
      u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (!isHttps && !isLoopbackHttp) {
      return {
        ok: false,
        detail: 'Use HTTPS or a loopback HTTP endpoint (127.0.0.1, localhost, or [::1])',
      };
    }
    return {
      ok: true,
      detail: isHttps ? `HTTPS endpoint (${u.origin})` : `Loopback HTTP endpoint (${u.origin})`,
    };
  } catch {
    return { ok: false, detail: 'API URL is not a valid URL' };
  }
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'request timed out';
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string') {
      return cause.code;
    }
    return err.message;
  }
  return 'connection failed';
}

async function runDoctor(configPath: string): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const next: string[] = [];
  let credentials: Credentials | null = null;
  let identity: DoctorReport['identity'] = null;
  let apiUrl: string | null = null;

  try {
    credentials = await readCredentials(configPath);
    identity = {
      ownerId: credentials.ownerId,
      principalId: credentials.principalId,
      scopeId: credentials.scopeId,
    };
    apiUrl = safeDisplayUrl(credentials.apiUrl);
    checks.push({
      name: 'config',
      ok: true,
      detail: 'Credential file exists with mode 0600 and valid schema',
    });
  } catch (err) {
    const fsCode =
      err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
        ? err.code
        : undefined;
    if (fsCode === 'ENOENT') {
      checks.push({ name: 'config', ok: false, detail: 'Credential file does not exist' });
      next.push(
        'Initialize credentials with `sift init` (or `npm run local`), or pass `--config <file>` / set `SIFT_CONFIG`.',
      );
    } else if (err instanceof Error && err.message.includes('mode 0600')) {
      let detail = 'Credential file must be a regular file with mode 0600';
      try {
        const stat = await lstat(configPath);
        if (!stat.isFile()) {
          detail = 'Credential file must be a regular file with mode 0600 (found non-regular file)';
        } else {
          const mode = (stat.mode & 0o777).toString(8).padStart(4, '0');
          detail = `Credential file must be a regular file with mode 0600 (found ${mode})`;
        }
      } catch {
        // Keep generic mode 0600 message if lstat fails.
      }
      checks.push({ name: 'config', ok: false, detail });
      next.push(`Restrict credential file permissions: chmod 600 ${configPath}`);
    } else if (err instanceof SyntaxError) {
      checks.push({ name: 'config', ok: false, detail: 'Credential file is not valid JSON' });
      next.push('Re-issue or repair the credential file with `sift init` or `sift credential`.');
    } else if (err instanceof Error && err.name === 'ZodError') {
      checks.push({
        name: 'config',
        ok: false,
        detail:
          'Credential file does not match required schema (apiUrl, token, principalId, ownerId, scopeId)',
      });
      next.push('Re-issue the credential file with `sift init` or `sift credential`.');
    } else {
      checks.push({ name: 'config', ok: false, detail: 'Unable to read credential file' });
      next.push('Verify credential file readability and format, or re-issue with `sift init`.');
    }
    return { ok: false, configPath, identity, apiUrl, checks, next };
  }

  const urlCheck = checkApiUrl(credentials.apiUrl);
  checks.push({ name: 'api_url', ok: urlCheck.ok, detail: urlCheck.detail });
  if (!urlCheck.ok) {
    next.push(
      `Update apiUrl to an HTTPS URL or loopback HTTP URL (for example ${defaultApiUrl}) without embedded credentials.`,
    );
    return { ok: false, configPath, identity, apiUrl, checks, next };
  }

  let healthReachable = false;
  try {
    const response = await fetch(new URL('/health', credentials.apiUrl), {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      checks.push({
        name: 'health',
        ok: false,
        detail: `/health returned HTTP ${response.status}`,
      });
      next.push('Check Siftable server logs and PostgreSQL database health.');
    } else {
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const healthy =
        Boolean(body) &&
        typeof body === 'object' &&
        ((body as Record<string, unknown>).status === 'ok' ||
          (body as Record<string, unknown>).ok === true);
      if (healthy) {
        healthReachable = true;
        checks.push({ name: 'health', ok: true, detail: '/health responded ok (HTTP 200)' });
      } else {
        checks.push({
          name: 'health',
          ok: false,
          detail: '/health returned an unexpected response payload',
        });
        next.push(`Verify ${apiUrl} points to a Siftable API server.`);
      }
    }
  } catch (err) {
    const reason = redactToken(describeFetchError(err), credentials.token);
    checks.push({
      name: 'health',
      ok: false,
      detail: `Cannot reach /health (${reason})`,
    });
    next.push(
      `Start the Siftable server (\`docker compose up -d\` or \`npm run local\`) and confirm apiUrl matches the listening port (default ${defaultPort}).`,
    );
  }

  if (!healthReachable) {
    return {
      ok: false,
      configPath,
      identity,
      apiUrl,
      checks,
      next,
    };
  }

  try {
    const client = await SiftClient.fromFile(configPath);
    const entries = await client.catalog();
    const catalogModules = [...new Set(entries.map((entry) => entry.module))].sort();
    checks.push({
      name: 'catalog',
      ok: true,
      detail: `Authorized for ${entries.length} operations across modules: ${catalogModules.join(', ') || 'none'}`,
    });

    if (entries.some((entry) => entry.name === 'modules.list')) {
      try {
        const rawModules = await client.invoke('modules.list', {});
        const rows = Array.isArray(rawModules)
          ? rawModules.filter(
              (m): m is { id: string; enabled: boolean } =>
                Boolean(m) &&
                typeof m === 'object' &&
                typeof (m as Record<string, unknown>).id === 'string' &&
                typeof (m as Record<string, unknown>).enabled === 'boolean',
            )
          : [];
        const enabledModules = rows
          .filter((m) => m.enabled)
          .map((m) => m.id)
          .sort();
        const disabledModules = rows
          .filter((m) => !m.enabled)
          .map((m) => m.id)
          .sort();
        const detail =
          enabledModules.length > 0
            ? `Enabled modules: ${enabledModules.join(', ')}${disabledModules.length > 0 ? ` (disabled: ${disabledModules.join(', ')})` : ''}`
            : 'No modules enabled';
        checks.push({ name: 'modules', ok: true, detail });
      } catch (err) {
        const detail =
          err instanceof SiftError
            ? redactToken(
                `modules.list failed (HTTP ${err.status}, ${err.code}): ${err.message}`,
                credentials.token,
              )
            : 'Failed to inspect enabled modules via modules.list';
        checks.push({ name: 'modules', ok: false, detail });
        next.push('Verify foundation module state and server logs.');
      }
    } else {
      checks.push({
        name: 'modules',
        ok: true,
        detail: `Permitted modules from catalog: ${catalogModules.join(', ') || 'none'} (modules.list not permitted for this credential)`,
      });
    }
  } catch (err) {
    if (err instanceof SiftError) {
      const safeMessage = redactToken(err.message, credentials.token);
      if (err.status === 401) {
        checks.push({
          name: 'catalog',
          ok: false,
          detail: `Authorization failed (${err.code}): ${safeMessage}`,
        });
        next.push(
          'Credential was rejected or revoked. Re-issue credentials with `sift credential` or `sift init`.',
        );
      } else {
        checks.push({
          name: 'catalog',
          ok: false,
          detail: `/v1/catalog failed (HTTP ${err.status}, ${err.code}): ${safeMessage}`,
        });
        next.push('Check Siftable server logs and verify API compatibility.');
      }
    } else {
      checks.push({
        name: 'catalog',
        ok: false,
        detail: 'Failed to query /v1/catalog',
      });
      next.push('Verify the Siftable API server is returning valid JSON at /v1/catalog.');
    }
  }

  return {
    ok: checks.every((check) => check.ok),
    configPath,
    identity,
    apiUrl,
    checks,
    next,
  };
}

function defaultSuggestionsForCode(code: string | undefined): string[] | undefined {
  switch (code) {
    case 'unknown_operation':
      return [
        'Run `sift --help` to see available operations, or `sift catalog` to see operations permitted for your credential.',
      ];
    case 'insecure_config':
      return [
        'Restrict credential file permissions with `chmod 600 <credential-file>`.',
        'Run `sift doctor --config <credential-file>` to verify configuration.',
      ];
    case 'ENOENT':
      return ['Verify the file path or run `sift doctor` to check credential configuration.'];
    case 'unauthorized':
      return [
        'Run `sift doctor` to verify credentials and API URL.',
        'Re-issue credentials with `sift init` or `sift credential` if the token was revoked.',
      ];
    case 'forbidden':
      return ['Run `sift catalog` to inspect operations permitted for this credential.'];
    case 'idempotency_required':
      return ['Pass a stable `--key <stable-key>` for mutating operations.'];
    case 'idempotency_conflict':
      return [
        'Reuse identical input with the same `--key`, or pass a new `--key` for changed input.',
      ];
    case 'revision_conflict':
      return ['Re-read the latest item revision and retry with the updated revision.'];
    case 'stale_lease':
      return ['Re-claim the work item or inspect lease status before retrying.'];
    case 'missing_lease':
      return ['Claim the work item first with `sift work.claim` using the same credential.'];
    case 'invalid_input':
      return ['Run `sift <operation> --help` to inspect the required inputSchema.'];
    case 'invalid_api_url':
      return [
        `Use an HTTPS URL or loopback HTTP URL (e.g. ${defaultApiUrl}) without embedded credentials.`,
      ];
    case 'admin_error':
      return ['Run `sift doctor` or verify SIFT_ADMIN_DATABASE_URL and PostgreSQL readiness.'];
    default:
      return undefined;
  }
}

function inferErrorCode(message: string): string | undefined {
  if (message === 'Unknown operation; use --help') return 'unknown_operation';
  if (message.includes('mode 0600')) return 'insecure_config';
  if (message.includes('A stable request key is required')) return 'idempotency_required';
  if (message.includes('Input must be a JSON object')) return 'invalid_input';
  if (message.includes('Use HTTPS or a loopback HTTP endpoint')) return 'invalid_api_url';
  if (message.includes('No saved lease')) return 'missing_lease';
  return undefined;
}

function formatCliError(
  e: unknown,
  cmd: string | undefined,
): { error: string; code?: string; status?: number; suggestions?: string[] } {
  const known = e instanceof Error && ('status' in e || !adminCommands.includes(cmd ?? ''));
  const errorMessage =
    known && e instanceof Error
      ? e.message
      : 'Local administration failed; check configuration and database readiness';
  let code: string | undefined;
  let status: number | undefined;
  let suggestions: string[] | undefined;

  if (e instanceof SiftError) {
    code = e.code;
    status = e.status;
    if (e.suggestions && e.suggestions.length > 0) {
      suggestions = e.suggestions;
    }
  } else if (known && e instanceof Error) {
    if ('code' in e && typeof e.code === 'string') {
      code = e.code;
    } else {
      code = inferErrorCode(e.message);
    }
    if ('status' in e && typeof e.status === 'number') {
      status = e.status;
    }
    if (
      'suggestions' in e &&
      Array.isArray(e.suggestions) &&
      e.suggestions.every((s): s is string => typeof s === 'string') &&
      e.suggestions.length > 0
    ) {
      suggestions = e.suggestions;
    }
  } else {
    code = 'admin_error';
  }

  suggestions ??= defaultSuggestionsForCode(code);

  const payload: {
    error: string;
    code?: string;
    status?: number;
    suggestions?: string[];
  } = { error: errorMessage };
  if (code) payload.code = code;
  if (status !== undefined) payload.status = status;
  if (suggestions && suggestions.length > 0) payload.suggestions = suggestions;
  return payload;
}

async function main() {
  const name = [command, ...rest].filter(Boolean).join('.');
  if (values.help && Object.hasOwn(operations, name)) {
    const operation = operations[name as Operation];
    const inputSchema = operation.input.toJSONSchema({ io: 'input' }) as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    const managesLease = Object.hasOwn(inputSchema.properties, 'claimSecret');
    delete inputSchema.properties.claimSecret;
    delete inputSchema.properties.epoch;
    inputSchema.required = (inputSchema.required ?? []).filter(
      (field) => !['claimSecret', 'epoch'].includes(field),
    );
    print({
      operation: name,
      usage: `sift ${name} --config <credential-file> --json <object>${operation.write ? ' --key <stable-key>' : ''}`,
      input: '--json <object> or --file <path>; fields and constraints are in inputSchema',
      module: operation.module,
      writes: operation.write,
      operatorRequired: operation.operator,
      availability:
        'Local reference only. Use catalog with your credential to check enabled and permitted operations.',
      ...(operation.write
        ? {
            requestKey:
              'Required: --key <stable-key>. Retry identical input with the same key after a lost response; use a new key for changed input.',
          }
        : {}),
      ...(managesLease
        ? {
            leaseCustody:
              name === 'work.claim'
                ? 'The client generates and saves the lease in the credential directory. No caller-supplied lease fields are needed.'
                : 'Requires an active claim made with this credential. The client reads its saved lease automatically; no caller-supplied lease fields are needed.',
          }
        : {}),
      inputSchema,
    });
    return;
  }
  if (
    values.help &&
    command &&
    ![
      'catalog',
      'config.info',
      'doctor',
      'init',
      'install',
      'credential',
      'revoke',
      'backup',
      'restore',
      'backup-verify',
      'modules-plan',
    ].includes(name)
  ) {
    throw new Error('Unknown operation; use --help');
  }
  if (values.help || !command) {
    print({
      usage: 'sift <operation> --config <credential-file> --json <object> [--key <stable-key>]',
      operationHelp: 'sift <operation> --help (input schema; no credential or service required)',
      configInfo:
        'sift config.info --config <file> (local identity metadata only; no token or authority check)',
      doctor:
        'sift doctor [--config <file>] (secret-safe diagnostics for config, URL, /health, /v1/catalog, and modules)',
      administration: [
        'init --modules projects,context,work,planning,extensions --output <credential-file> --url http://127.0.0.1:8088',
        'modules-plan --modules context',
        'install --modules work',
        'credential --owner-id <id> --role agent --permissions work:read,work:write --output <file>',
        'revoke --id <principal-id>',
        'backup --output <new-private-directory>',
        'backup-verify --file <backup-directory>',
        'restore --file <backup-directory> --database <new-database-name>',
      ],
      adminEnvironment: 'SIFT_ADMIN_DATABASE_URL (read internally; never printed)',
      operations: Object.keys(operations),
      modules: moduleIds,
    });
    return;
  }
  if (command === 'backup-verify') {
    if (!values.file) throw new Error('--file required');
    const m = await verifyBackup(values.file);
    print({
      verified: true,
      sha256: m.archiveSha256,
      modules: m.modules.map((x) => x.id),
      tables: m.tables.length,
    });
    return;
  }
  if (command === 'backup' || command === 'restore') {
    const db = await databaseUrlFromEnvironment(true);
    if (command === 'backup') {
      if (!values.output) throw new Error('--output required');
      print(await backupDatabase(db, values.output));
    } else {
      if (!values.file || !values.database) throw new Error('--file and --database required');
      print(await restoreDatabase(db, values.file, values.database));
    }
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
        apiUrl: values.url ?? defaultApiUrl,
        ownerId: values['owner-id'],
        scopeId: values['scope-id'] ?? null,
        role: values.role === 'agent' ? 'agent' : 'owner',
        permissions: (values.permissions ?? '').split(',').filter(Boolean),
      }),
    );
    return;
  }
  const configPath = resolve(values.config ?? process.env.SIFT_CONFIG ?? '.local/owner.json');
  if (name === 'config.info') {
    const { ownerId, principalId, scopeId } = await readCredentials(configPath);
    print({ ownerId, principalId, scopeId });
    return;
  }
  if (name === 'doctor') {
    const report = await runDoctor(configPath);
    print(report);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  const client = await SiftClient.fromFile(configPath);
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
  process.stderr.write(JSON.stringify(formatCliError(e, command)) + '\n');
  process.exitCode = 1;
}
