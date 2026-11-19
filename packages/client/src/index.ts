import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, link, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { operations, SiftError, type Operation, type OperationInput } from '@siftable/contracts';
const configSchema = z
  .object({
    apiUrl: z.url(),
    token: z.string().min(32),
    principalId: z.uuid(),
    ownerId: z.uuid(),
    scopeId: z.uuid().nullable(),
  })
  .strict();
export type Credentials = z.infer<typeof configSchema>;
export async function readCredentials(path: string): Promise<Credentials> {
  const stat = await lstat(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw new Error('Credential file must be a regular file with mode 0600');
  return configSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const leaseSchema = z.object({
  claimSecret: z.string().min(32),
  epoch: z.number().int().positive().optional(),
});
type Lease = z.infer<typeof leaseSchema>;
const claimId = (secret: string) => hash(`siftable-lease:${hash(secret)}`);
const missing = (e: unknown) => e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT';
async function ensureLeaseDir(dir: string): Promise<void> {
  try {
    const stat = await lstat(dir);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0)
      throw new Error('Lease directory must be a private directory with mode 0700');
    return;
  } catch (e) {
    if (!missing(e)) throw e;
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0)
    throw new Error('Lease directory must be a private directory with mode 0700');
}
function resolveLeaseDir(path: string, leaseDir?: string): string {
  const explicit = leaseDir?.trim();
  if (explicit) return resolve(explicit);
  const envDir = process.env.SIFT_LEASE_DIR?.trim();
  if (envDir) return resolve(envDir);
  return join(dirname(path), 'leases');
}
async function savedLease(path: string): Promise<Lease> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.mode & 0o077)
    throw new Error('Lease custody must be a private regular file');
  return leaseSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
async function publishLease(path: string, value: Lease): Promise<Lease> {
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  try {
    try {
      await link(temp, path);
    } catch (e) {
      if (!(e && typeof e === 'object' && 'code' in e && e.code === 'EEXIST')) throw e;
    }
  } finally {
    await unlink(temp);
  }
  return savedLease(path);
}
export class SiftClient {
  constructor(
    private config: Credentials,
    private leaseDir: string,
  ) {
    const u = new URL(config.apiUrl);
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !(
        ['https:'].includes(u.protocol) ||
        (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
      )
    )
      throw new Error('Use HTTPS or a loopback HTTP endpoint without URL credentials');
  }
  static async fromFile(path: string, leaseDir?: string) {
    return new SiftClient(await readCredentials(path), resolveLeaseDir(path, leaseDir));
  }
  private async request(path: string, body?: unknown, key?: string): Promise<unknown> {
    const response = await fetch(new URL(path, this.config.apiUrl), {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = z
      .object({
        data: z.unknown().optional(),
        error: z.object({ code: z.string(), message: z.string() }).optional(),
      })
      .parse(await response.json());
    if (!response.ok)
      throw new SiftError(
        response.status,
        result.error?.code ?? 'http_error',
        result.error?.message ?? 'Request failed',
      );
    return result.data;
  }
  async catalog() {
    return z
      .array(z.object({ name: z.string(), module: z.string(), write: z.boolean() }))
      .parse(await this.request('/v1/catalog'));
  }
  async call<K extends Operation>(
    name: K,
    input: OperationInput<K>,
    key?: string,
  ): Promise<unknown> {
    return this.request(`/v1/operations/${name}`, input, key);
  }
  async invoke(name: Operation, args: Record<string, unknown>, key?: string): Promise<unknown> {
    if (operations[name].write && !key)
      throw new Error(
        'A stable request key is required for mutations (--key in CLI, requestKey in MCP)',
      );
    const input = { ...args };
    const leasePath = join(
      this.leaseDir,
      hash(`${this.config.apiUrl}:${this.config.principalId}:${String(args.id)}`) + '.json',
    );
    const candidatePath = (id: string) => `${leasePath}.${id}.candidate.json`;
    if (name === 'work.claim') {
      await ensureLeaseDir(this.leaseDir);
      // Existing attempt paths remain readable so historical keys retain their secret.
      const legacyAttempt = join(
        this.leaseDir,
        hash(`${this.config.principalId}:${args.id}:${key}`) + '.claim.json',
      );
      const attemptPath = join(
        this.leaseDir,
        hash(`${this.config.apiUrl}:${this.config.principalId}:${args.id}:${key}`) + '.claim.json',
      );
      let prepared: Lease;
      try {
        prepared = await savedLease(attemptPath);
      } catch (e) {
        if (!missing(e)) throw e;
        let legacy: Lease | undefined;
        try {
          legacy = await savedLease(legacyAttempt);
        } catch (e) {
          if (!missing(e)) throw e;
        }
        prepared = await publishLease(
          attemptPath,
          legacy ?? { claimSecret: randomBytes(32).toString('base64url') },
        );
      }
      // Immutable candidates exist even when a successful claim response is lost.
      await publishLease(candidatePath(claimId(prepared.claimSecret)), {
        claimSecret: prepared.claimSecret,
      });
      input.claimSecret = prepared.claimSecret;
      return this.request(`/v1/operations/${name}`, input, key);
    }
    if (
      [
        'work.start',
        'work.heartbeat',
        'work.release',
        'work.review',
        'work.evidence',
        'work.block',
        'work.fail',
        'work.artifacts.add',
      ].includes(name)
    ) {
      await ensureLeaseDir(this.leaseDir);
      const bindingPath = join(
        this.leaseDir,
        hash(`${this.config.apiUrl}:${this.config.principalId}:${args.id}:${name}:${key}`) +
          '.mutation.json',
      );
      let lease: Lease;
      try {
        lease = await savedLease(bindingPath);
      } catch (e) {
        if (!missing(e)) throw e;
        // Pre-upgrade mutations have no binding. Their last legacy lease may
        // still replay a successful receipt after release/expiry. Try it without
        // persisting a guess; only a definite stale_lease permits fresh resolution.
        let legacy: Lease | undefined;
        try {
          legacy = await savedLease(leasePath);
        } catch (e) {
          if (!missing(e)) throw e;
        }
        if (legacy?.epoch) {
          try {
            const result = await this.request(
              `/v1/operations/${name}`,
              { ...input, claimSecret: legacy.claimSecret, epoch: legacy.epoch },
              key,
            );
            await publishLease(bindingPath, legacy);
            return result;
          } catch (e) {
            if (!(e instanceof SiftError && e.code === 'stale_lease')) throw e;
          }
        }
        const current = z
          .object({
            epoch: z.number().int().positive(),
            claimId: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .parse(await this.request('/v1/operations/work.lease', { id: args.id }));
        let candidate: Lease;
        try {
          candidate = await savedLease(candidatePath(current.claimId));
        } catch (e) {
          if (!missing(e)) throw e;
          // Upgrade path for a pre-candidate-store active claim. Never trust its epoch.
          try {
            candidate = await savedLease(leasePath);
          } catch {
            throw new Error('No saved lease: claim this work with this credential first');
          }
        }
        if (claimId(candidate.claimSecret) !== current.claimId)
          throw new Error('No saved lease matches the current claim');
        // Bind before sending. Retries after release, expiry or response loss must
        // reach the original durable receipt with the original lease fields.
        lease = await publishLease(bindingPath, {
          claimSecret: candidate.claimSecret,
          epoch: current.epoch,
        });
      }
      input.claimSecret = lease.claimSecret;
      input.epoch = lease.epoch;
    }
    return this.request(`/v1/operations/${name}`, input, key);
  }
}
