import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HEX_COMMIT_RE = /^[0-9a-f]{7,40}$/i;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

export interface CodeMemoryPathInspection {
  repoRoot: string;
  headCommit: string | null;
  paths: string[];
  pathCommits: Record<string, string | null>;
  fileHashes: Record<string, string | null>;
}

function normalizeRelativePath(raw: string): string {
  const trimmed = raw.trim().replaceAll('\\', '/');
  if (!trimmed || CONTROL_CHAR_RE.test(trimmed)) {
    throw new Error(`Invalid relative code memory path: ${raw}`);
  }
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) {
    throw new Error(`Code memory path must be repository-relative: ${raw}`);
  }
  const stripped = trimmed
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
  if (!stripped) {
    throw new Error(`Invalid relative code memory path: ${raw}`);
  }
  const segments = stripped.split('/');
  if (segments.some((seg) => !seg || seg === '.' || seg === '..')) {
    throw new Error(`Code memory path must not traverse directories: ${raw}`);
  }
  return segments.join('/');
}

async function runReadOnlyGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
      },
      timeout: 5_000,
      maxBuffer: 128 * 1024,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

async function hashFileIfPresent(root: string, relPath: string): Promise<string | null> {
  const fullPath = resolve(root, relPath);
  if (!isWithinRoot(root, fullPath)) {
    throw new Error(`Code memory path escapes repository root: ${relPath}`);
  }
  try {
    const linkInfo = await lstat(fullPath);
    if (linkInfo.isSymbolicLink()) {
      const targetReal = await realpath(fullPath);
      if (!isWithinRoot(root, targetReal)) return null;
      const targetInfo = await stat(targetReal);
      if (!targetInfo.isFile()) return null;
    } else if (!linkInfo.isFile()) {
      return null;
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(fullPath)) {
      hash.update(chunk);
    }
    return hash.digest('hex');
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
        ? err.code
        : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null;
    throw err;
  }
}

/**
 * Inspect local repository paths using read-only git and SHA-256 file hashes so callers
 * can pass real commit and file state directly into `memory.detect_stale`.
 */
export async function inspectCodeMemoryPaths(
  repoRoot: string,
  paths: readonly string[],
): Promise<CodeMemoryPathInspection> {
  const resolved = resolve(repoRoot);
  let canonicalRoot = resolved;
  try {
    canonicalRoot = await realpath(resolved);
  } catch {
    canonicalRoot = resolved;
  }

  const normalizedPaths = [...new Set(paths.map(normalizeRelativePath))].sort();
  const rawHead = await runReadOnlyGit(canonicalRoot, ['rev-parse', 'HEAD']);
  const headCommit = rawHead && HEX_COMMIT_RE.test(rawHead) ? rawHead.toLowerCase() : null;

  const pathCommits: Record<string, string | null> = {};
  const fileHashes: Record<string, string | null> = {};

  await Promise.all(
    normalizedPaths.map(async (relPath) => {
      const [rawCommit, fileHash] = await Promise.all([
        runReadOnlyGit(canonicalRoot, ['log', '-n', '1', '--format=%H', '--', relPath]),
        hashFileIfPresent(canonicalRoot, relPath),
      ]);
      pathCommits[relPath] =
        rawCommit && HEX_COMMIT_RE.test(rawCommit) ? rawCommit.toLowerCase() : null;
      fileHashes[relPath] = fileHash;
    }),
  );

  return {
    repoRoot: canonicalRoot,
    headCommit,
    paths: normalizedPaths,
    pathCommits,
    fileHashes,
  };
}
