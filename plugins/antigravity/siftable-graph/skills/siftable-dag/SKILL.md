---
name: siftable-dag
description: >-
  Plan, fork, execute, and hand back dependency-ordered work graphs using local
  Siftable MCP tools and the Siftable Graph sidecar pane in Antigravity. Use
  when decomposing multi-step engineering work into a DAG, picking up the next
  claimable frontier items, running parallel subagents or swarm workers over
  dependent tasks, or recording handback summaries and verification evidence.
---

# Siftable Dependency-Ordered Work Graph (DAG)

Use Siftable as the durable, dependency-ordered source of truth for multi-step
and parallel agent work. Every mutation requires a stable `requestKey` (retry
identical input with the same key after a lost response; use a new key for
changed input).

This plugin skill mirrors the portable workflow in
`.agents/skills/siftable-dag/SKILL.md` and adds Antigravity-specific surface
guidance below.

## 1. Inspect the Frontier First

1. Call `work_graph` (optionally scoped by `projectId` or `rootId`) to retrieve:
   - `nodes`: each item's `uiState` (`ready`, `waiting`, `active`, `needs_you`,
     `done`, `failed`, `cancelled`), `waiting` ratio (`satisfied/total`), and
     transitive `unblocksCount`.
   - `next`: priority-ordered frontier IDs (`unblocksCount` descending,
     `needs_you` ahead of `ready`).
2. Pick from `ready` (`claimable: true`) nodes—preferring higher `unblocksCount`
   to open downstream branches sooner.
3. Before starting a non-leaf node (`predecessorIds.length > 0`), read its
   predecessors' handbacks (`work_get` + `work_artifacts_get`) so upstream
   decisions and results carry forward accurately.

## 2. Standard Execution & Handback Loop

For each claimed work item:

1. `work_claim` (with a stable `requestKey`) → `work_start`.
2. Execute the bounded task. Keep `work_heartbeat` fresh on long-running work.
3. Record a durable handback summary as an immutable artifact:
   - `work_artifacts_add` with `name: "handback-summary.md"`,
     `mediaType: "text/markdown"`, and a concise summary of decisions, changed
     files, and verification results.
4. Record verification results against the active plan steps:
   - `work_evidence` with `planVersion`, `stepId`, `attemptId`, `outcome`
     (`passed` | `failed` | `error`), bounded `output`, and `provenance`.
5. Submit for human review:
   - `work_review` with a concise `summary`.
   - Do **not** attempt to self-accept work; the human operator accepts via the
     Graph UI (`http://127.0.0.1:7041`), the Antigravity sidecar pane
     (`✓ Accept`), or the owner CLI (`work.accept`).

## 3. Forking a Task into Parallel Branches

When a task splits into independent sub-questions or implementation branches:

1. If you currently hold the lease on the parent item, release it first via
   `work_block` (with a clear `reason`, e.g., `"Forking into sub-branches"`).
2. Call `work_fork` with the parent's `id`, current `revision`, `reason`,
   optional `gate` (`"done"` or `"commands_passed"`), and `branches` array.
3. `work_fork` atomically creates the child work items, wires them as
   predecessors on the parent, bumps the parent's plan version, and sets the
   parent back to `queued` (waiting until all child branches settle).

## 4. Parallel Wave Execution

When `work_graph` shows multiple `ready` (`claimable: true`) leaves:

- Dispatch parallel workers, assigning each worker a distinct `ready` work ID
  and an isolated workspace or git worktree. Siftable's atomic `work_claim`
  prevents double-claiming.
- Workers submit `work_review` independently and pick up the next unblocked wave
  as soon as predecessors satisfy their gate.
- If a sandboxed CLI invocation cannot write lease custody next to its
  credential file, set `SIFT_LEASE_DIR` to a private (`0700`) writable
  directory.

## Antigravity-Specific Surface Notes

Apply these additions **only** inside Antigravity sessions (outside Antigravity,
use the standalone Graph UI at `http://127.0.0.1:7041` and never emit
`sidecar://` links):

- **Graph Sidecar Pane:** Surface the interactive sidecar pill once when helpful
  so the user can inspect dependencies, read handbacks, and accept `Needs you`
  items directly in Antigravity:

  ```markdown
  [Siftable Graph](sidecar://siftable-graph/graph/)
  ```

- **Parallel Dispatch:** Use Antigravity parallel subagents, `run_workflow`, or
  swarm workers with isolated `share` / `branch` workspaces for independent
  `ready` frontier items.
