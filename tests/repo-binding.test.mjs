import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { operations } from '../packages/contracts/dist/index.js';
import {
  inspectGitCheckout,
  matchBindingForCheckout,
  normalizeGitRemoteUrl,
  normalizeRootPath,
} from '../packages/client/dist/index.js';

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Siftable Test',
      GIT_AUTHOR_EMAIL: 'test@siftable.local',
      GIT_COMMITTER_NAME: 'Siftable Test',
      GIT_COMMITTER_EMAIL: 'test@siftable.local',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

test('normalizeRootPath trims whitespace and trailing slashes while preserving /', () => {
  assert.equal(
    normalizeRootPath('  /Users/me/projects/siftable///  '),
    '/Users/me/projects/siftable',
  );
  assert.equal(normalizeRootPath('/Users/me/repo/'), '/Users/me/repo');
  assert.equal(normalizeRootPath('/'), '/');
  assert.equal(normalizeRootPath('///'), '/');
  assert.equal(normalizeRootPath('   '), '');
});

test('normalizeGitRemoteUrl normalizes HTTPS, SSH, SCP, git, and file remotes and strips credentials', () => {
  assert.equal(
    normalizeGitRemoteUrl('https://github.com/Acme/Siftable.git'),
    'github.com/acme/siftable',
  );
  assert.equal(
    normalizeGitRemoteUrl('https://user:super_secret@github.com/Acme/Siftable.git/'),
    'github.com/acme/siftable',
  );
  assert.equal(
    normalizeGitRemoteUrl('https://ghp_token123@github.com/Acme/Siftable?ref=main#top'),
    'github.com/acme/siftable',
  );
  assert.equal(
    normalizeGitRemoteUrl('git@github.com:Acme/Siftable.git'),
    'github.com/acme/siftable',
  );
  assert.equal(
    normalizeGitRemoteUrl('ssh://git@github.com:22/Acme/Siftable.git'),
    'github.com/acme/siftable',
  );
  assert.equal(
    normalizeGitRemoteUrl('git://github.com/Acme/Siftable.git'),
    'github.com/acme/siftable',
  );
  assert.equal(
    normalizeGitRemoteUrl('ssh://git@gitlab.example.com:2222/Group/Sub/Repo.git'),
    'gitlab.example.com:2222/group/sub/repo',
  );
  assert.equal(
    normalizeGitRemoteUrl('gitlab.example.com:2222/Group/Sub/Repo.git'),
    'gitlab.example.com:2222/group/sub/repo',
  );
  assert.equal(
    normalizeGitRemoteUrl('https://gitlab.example.com:8443/Group/Sub/Repo.git'),
    'gitlab.example.com:8443/group/sub/repo',
  );
  assert.equal(normalizeGitRemoteUrl('file:///Users/Test/Origin.git'), 'file:///users/test/origin');
  assert.equal(normalizeGitRemoteUrl('   '), '');
});

test('inspectGitCheckout handles main repo, subdirectory, file, linked worktree, unborn repo, and non-git dir', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'siftable-repo-bind-'));
  try {
    const mainDir = join(scratch, 'main-repo');
    const subDir = join(mainDir, 'packages', 'nested');
    const filePath = join(subDir, 'README.md');
    const linkedDir = join(scratch, 'linked-wt');
    const linkedSubDir = join(linkedDir, 'packages', 'nested');
    const detachedDir = join(scratch, 'detached-wt');
    const unbornDir = join(scratch, 'unborn-repo');
    const plainDir = join(scratch, 'not-a-repo');

    await mkdir(subDir, { recursive: true });
    await mkdir(unbornDir, { recursive: true });
    await mkdir(plainDir, { recursive: true });
    await writeFile(filePath, '# demo\n');

    await git(mainDir, 'init', '-b', 'main');
    await git(
      mainDir,
      'remote',
      'add',
      'origin',
      'https://alice:top_secret_pw@github.com/Acme/Siftable.git',
    );
    await git(mainDir, 'add', '.');
    await git(mainDir, 'commit', '-m', 'initial');
    await git(mainDir, 'worktree', 'add', '-b', 'feat/worktree-test', linkedDir);
    await git(mainDir, 'worktree', 'add', '--detach', detachedDir);
    await git(unbornDir, 'init', '-b', 'trunk');

    const realMain = await realpath(mainDir);
    const realLinked = await realpath(linkedDir);
    const realDetached = await realpath(detachedDir);
    const realUnborn = await realpath(unbornDir);

    const fromRoot = await inspectGitCheckout(mainDir);
    assert.deepEqual(fromRoot, {
      kind: 'main_worktree',
      checkoutRoot: realMain,
      commonRoot: realMain,
      gitCommonDir: join(realMain, '.git'),
      gitRemoteUrl: 'github.com/acme/siftable',
      branch: 'main',
    });

    const fromSub = await inspectGitCheckout(subDir);
    assert.deepEqual(fromSub, fromRoot);

    const fromFile = await inspectGitCheckout(filePath);
    assert.deepEqual(fromFile, fromRoot);

    const fromLinked = await inspectGitCheckout(linkedDir);
    assert.deepEqual(fromLinked, {
      kind: 'linked_worktree',
      checkoutRoot: realLinked,
      commonRoot: realMain,
      gitCommonDir: join(realMain, '.git'),
      gitRemoteUrl: 'github.com/acme/siftable',
      branch: 'feat/worktree-test',
    });

    const fromLinkedSub = await inspectGitCheckout(linkedSubDir);
    assert.deepEqual(fromLinkedSub, fromLinked);

    const fromDetached = await inspectGitCheckout(detachedDir);
    assert.deepEqual(fromDetached, {
      kind: 'linked_worktree',
      checkoutRoot: realDetached,
      commonRoot: realMain,
      gitCommonDir: join(realMain, '.git'),
      gitRemoteUrl: 'github.com/acme/siftable',
      branch: null,
    });

    const fromUnborn = await inspectGitCheckout(unbornDir);
    assert.deepEqual(fromUnborn, {
      kind: 'main_worktree',
      checkoutRoot: realUnborn,
      commonRoot: realUnborn,
      gitCommonDir: join(realUnborn, '.git'),
      gitRemoteUrl: null,
      branch: 'trunk',
    });

    const fromPlain = await inspectGitCheckout(plainDir);
    assert.deepEqual(fromPlain, {
      kind: 'not_git',
      checkoutRoot: null,
      commonRoot: null,
      gitCommonDir: null,
      gitRemoteUrl: null,
      branch: null,
    });

    const fromMissing = await inspectGitCheckout(join(scratch, 'does-not-exist'));
    assert.equal(fromMissing.kind, 'not_git');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('matchBindingForCheckout enforces longest-prefix containment, path boundaries, commonRoot, and gitRemoteUrl fallback', () => {
  const bindings = [
    {
      id: 'b-mono',
      projectId: 'p-mono',
      rootPath: '/repos/monorepo/',
      gitRemoteUrl: 'https://github.com/Acme/Monorepo.git',
    },
    {
      id: 'b-web',
      projectId: 'p-web',
      rootPath: '/repos/monorepo/apps/web',
      gitRemoteUrl: 'https://github.com/Acme/Monorepo.git',
    },
    {
      id: 'b-local',
      projectId: 'p-local',
      rootPath: '/repos/local-only',
      gitRemoteUrl: null,
    },
    {
      id: 'b-other',
      projectId: 'p-other',
      rootPath: '/repos/other-clone',
      gitRemoteUrl: 'git@github.com:Acme/Service.git',
    },
  ];

  // Longest-prefix beats shorter parent binding.
  const nested = matchBindingForCheckout(bindings, {
    checkoutPath: '/repos/monorepo/apps/web/src/index.ts',
  });
  assert.equal(nested.matched, true);
  assert.equal(nested.matchKind, 'root_path');
  assert.equal(nested.binding?.projectId, 'p-web');

  // Sibling path outside nested binding matches parent binding.
  const api = matchBindingForCheckout(bindings, {
    checkoutPath: '/repos/monorepo/apps/api',
  });
  assert.equal(api.matched, true);
  assert.equal(api.matchKind, 'root_path');
  assert.equal(api.binding?.projectId, 'p-mono');

  // Path-boundary guard: /repos/local-only-2 must NOT match /repos/local-only.
  const sibling = matchBindingForCheckout(bindings, {
    checkoutPath: '/repos/local-only-2',
  });
  assert.deepEqual(sibling, { matched: false, matchKind: null, binding: null });

  // Linked worktree resolves via commonRoot even without a git remote.
  const localWorktree = matchBindingForCheckout(bindings, {
    checkoutRoot: '/worktrees/local-only-wt-1',
    commonRoot: '/repos/local-only',
    gitRemoteUrl: null,
  });
  assert.equal(localWorktree.matched, true);
  assert.equal(localWorktree.matchKind, 'root_path');
  assert.equal(localWorktree.binding?.projectId, 'p-local');

  // Out-of-tree clone / worktree falls back to normalized gitRemoteUrl (HTTPS <-> SSH).
  const remoteFallback = matchBindingForCheckout(bindings, {
    checkoutRoot: '/worktrees/t3-service-branch',
    commonRoot: '/repos/different-checkout-path',
    gitRemoteUrl: 'https://github.com/acme/service.git',
  });
  assert.equal(remoteFallback.matched, true);
  assert.equal(remoteFallback.matchKind, 'git_remote');
  assert.equal(remoteFallback.binding?.projectId, 'p-other');

  // Unmatched checkout returns clean null result.
  const unmatched = matchBindingForCheckout(bindings, {
    checkoutRoot: '/worktrees/unknown',
    gitRemoteUrl: 'https://github.com/acme/unknown.git',
  });
  assert.deepEqual(unmatched, { matched: false, matchKind: null, binding: null });
});

test('projects.bind and projects.resolve contract schemas enforce strict validation', () => {
  assert.equal(operations['projects.bind'].module, 'projects');
  assert.equal(operations['projects.bind'].write, true);
  assert.equal(operations['projects.bind'].operator, false);
  assert.equal(operations['projects.resolve'].module, 'projects');
  assert.equal(operations['projects.resolve'].write, false);
  assert.equal(operations['projects.resolve'].operator, false);

  assert.throws(() =>
    operations['projects.bind'].input.parse({
      projectId: '11111111-1111-4111-8111-111111111111',
      rootPath: '/repos/demo',
      extra: true,
    }),
  );
  assert.throws(() =>
    operations['projects.resolve'].input.parse({
      checkoutPath: '/repos/demo',
      extra: true,
    }),
  );
});
