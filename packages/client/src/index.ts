import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
interface Lease {
  claimSecret: string;
  epoch?: number;
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
  static async fromFile(path: string) {
    return new SiftClient(await readCredentials(path), join(dirname(path), 'leases'));
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
    if (name === 'work.claim') {
      await mkdir(this.leaseDir, { recursive: true, mode: 0o700 });
      const attemptPath = join(
        this.leaseDir,
        hash(`${this.config.principalId}:${args.id}:${key}`) + '.claim.json',
      );
      let prepared: Lease;
      try {
        prepared = JSON.parse(await readFile(attemptPath, 'utf8')) as Lease;
      } catch (e) {
        if (!(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT')) throw e;
        prepared = { claimSecret: randomBytes(32).toString('base64url') };
        try {
          await writeFile(attemptPath, JSON.stringify(prepared), { mode: 0o600, flag: 'wx' });
        } catch (e) {
          if (!(e && typeof e === 'object' && 'code' in e && e.code === 'EEXIST')) throw e;
          prepared = JSON.parse(await readFile(attemptPath, 'utf8')) as Lease;
        }
      }
      input.claimSecret = prepared.claimSecret;
      const result = await this.request(`/v1/operations/${name}`, input, key);
      const epoch = z
        .object({ epoch: z.number().int().positive() })
        .passthrough()
        .parse(result).epoch;
      const temp = leasePath + '.' + randomBytes(8).toString('hex');
      await writeFile(temp, JSON.stringify({ ...prepared, epoch }), { mode: 0o600, flag: 'wx' });
      await rename(temp, leasePath);
      return result;
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
      let lease: Lease;
      try {
        lease = JSON.parse(await readFile(leasePath, 'utf8')) as Lease;
      } catch {
        throw new Error('No saved lease: claim this work with this credential first');
      }
      input.claimSecret = lease.claimSecret;
      input.epoch = lease.epoch;
    }
    return this.request(`/v1/operations/${name}`, input, key);
  }
}
