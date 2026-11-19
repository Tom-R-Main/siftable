import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { normalizeGitRemoteUrl, normalizeRootPath } from '@siftable/contracts';

export { normalizeGitRemoteUrl, normalizeRootPath };

const execFileAsync = promisify(execFile);

export type GitCheckoutKind = 'main_worktree' | 'linked_worktree' | 'not_git';

export interface GitCheckoutInfo {
  kind: GitCheckoutKind;
  checkoutRoot: string | null;
  commonRoot: string | null;
  gitCommonDir: string | null;
  gitRemoteUrl: string | null;
  branch: string | null;
}

export interface ProjectBindingCandidate {
  id?: string;
  projectId: string;
  rootPath: string;
  gitRemoteUrl?: string | null;
  defaultBranch?: string | null;
}

export interface CheckoutMatchInput {
  checkoutPath?: string | null;
  checkoutRoot?: string | null;
  commonRoot?: string | null;
  gitRemoteUrl?: string | null;
}

export interface BindingMatchResult<T extends ProjectBindingCandidate = ProjectBindingCandidate> {
  matched: boolean;
  matchKind: 'root_path' | 'git_remote' | null;
  binding: T | null;
}

const NOT_GIT: GitCheckoutInfo = {
  kind: 'not_git',
  checkoutRoot: null,
  commonRoot: null,
  gitCommonDir: null,
  gitRemoteUrl: null,
  branch: null,
};

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
      maxBuffer: 256 * 1024,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function canonicalPath(baseDir: string, target: string): Promise<string> {
  const absolute = resolve(baseDir, target);
  try {
    return normalizeRootPath(await realpath(absolute));
  } catch {
    return normalizeRootPath(absolute);
  }
}

export async function inspectGitCheckout(targetPath = process.cwd()): Promise<GitCheckoutInfo> {
  const resolvedTarget = resolve(targetPath);
  let cwd = resolvedTarget;
  try {
    const info = await stat(resolvedTarget);
    if (info.isFile()) cwd = dirname(resolvedTarget);
  } catch {
    return { ...NOT_GIT };
  }

  const topLevel = await runReadOnlyGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!topLevel) return { ...NOT_GIT };

  const checkoutRoot = await canonicalPath(cwd, topLevel);
  const [rawGitDir, rawGitCommonDir, rawBranch, rawRemote] = await Promise.all([
    runReadOnlyGit(checkoutRoot, ['rev-parse', '--git-dir']),
    runReadOnlyGit(checkoutRoot, ['rev-parse', '--git-common-dir']),
    runReadOnlyGit(checkoutRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    runReadOnlyGit(checkoutRoot, ['config', '--get', 'remote.origin.url']),
  ]);

  if (!rawGitDir || !rawGitCommonDir) return { ...NOT_GIT };

  const [gitDir, gitCommonDir] = await Promise.all([
    canonicalPath(checkoutRoot, rawGitDir),
    canonicalPath(checkoutRoot, rawGitCommonDir),
  ]);

  const kind: GitCheckoutKind = gitDir === gitCommonDir ? 'main_worktree' : 'linked_worktree';
  const commonRoot =
    kind === 'main_worktree'
      ? checkoutRoot
      : basename(gitCommonDir) === '.git'
        ? normalizeRootPath(dirname(gitCommonDir))
        : null;

  let branch: string | null = null;
  if (rawBranch && rawBranch !== 'HEAD') {
    branch = rawBranch;
  } else if (!rawBranch) {
    branch = await runReadOnlyGit(checkoutRoot, ['symbolic-ref', '--short', 'HEAD']);
  }

  const gitRemoteUrl = rawRemote ? normalizeGitRemoteUrl(rawRemote) : null;

  return {
    kind,
    checkoutRoot,
    commonRoot,
    gitCommonDir,
    gitRemoteUrl,
    branch,
  };
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  if (!candidatePath || !rootPath) return false;
  if (candidatePath === rootPath) return true;
  if (rootPath === '/') return candidatePath.startsWith('/');
  return candidatePath.startsWith(`${rootPath}/`);
}

function matchLongestRoot<T extends ProjectBindingCandidate>(
  bindings: readonly T[],
  candidatePath: string,
): T | null {
  const normalizedCandidate = normalizeRootPath(candidatePath);
  if (!normalizedCandidate) return null;
  let best: T | null = null;
  let bestLength = -1;
  for (const binding of bindings) {
    const root = normalizeRootPath(binding.rootPath);
    if (isPathWithinRoot(normalizedCandidate, root) && root.length > bestLength) {
      bestLength = root.length;
      best = binding;
    }
  }
  return best;
}

export function matchBindingForCheckout<T extends ProjectBindingCandidate>(
  bindings: readonly T[],
  checkout: CheckoutMatchInput,
): BindingMatchResult<T> {
  const candidatePaths: string[] = [];
  for (const raw of [checkout.checkoutPath, checkout.checkoutRoot, checkout.commonRoot]) {
    if (!raw) continue;
    const normalized = normalizeRootPath(raw);
    if (normalized && !candidatePaths.includes(normalized)) {
      candidatePaths.push(normalized);
    }
  }

  for (const candidatePath of candidatePaths) {
    const matched = matchLongestRoot(bindings, candidatePath);
    if (matched) {
      return { matched: true, matchKind: 'root_path', binding: matched };
    }
  }

  if (checkout.gitRemoteUrl) {
    const normalizedRemote = normalizeGitRemoteUrl(checkout.gitRemoteUrl);
    if (normalizedRemote) {
      const matched = bindings.find(
        (b) => b.gitRemoteUrl && normalizeGitRemoteUrl(b.gitRemoteUrl) === normalizedRemote,
      );
      if (matched) {
        return { matched: true, matchKind: 'git_remote', binding: matched };
      }
    }
  }

  return { matched: false, matchKind: null, binding: null };
}
