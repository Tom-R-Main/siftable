---
name: siftable-dag
description: >-
  Plan, fork, execute, and hand back dependency-ordered work graphs using local
  Siftable stdio MCP tools (or the sift CLI) and the standalone Graph UI at
  http://127.0.0.1:7041. Use when decomposing multi-step engineering work into a
  DAG, picking up the next claimable frontier items, running parallel workers
  over dependent tasks, or recording handback summaries and verification
  evidence.
---

# Siftable Dependency-Ordered Work Graph (DAG)

Use Siftable as the durable, dependency-ordered source of truth for multi-step
and parallel agent work across any MCP-capable harness (Codex CLI, Claude Code,
Cursor, T3 Code, or CLI sessions). Prefer the local stdio MCP server as the
primary transport. Every mutation requires a stable `requestKey` (`--key` in the
CLI): retry identical input with the same key after a lost response, and use a
new key for changed input.

## 1. Standalone Local Graph UI

Direct human operators to the standalone local Graph UI (`npm run ui`, listening
on `http://127.0.0.1:7041`) to inspect the DAG, watch the priority-ordered
`Next` frontier queue, read `handback-summary.md` artifacts, fork work, and
accept or reopen `Needs you` items.

Avoid host- or IDE-specific custom URI schemes in portable sessions.

## 2. Inspect the Frontier First

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

## 3. Standard Execution & Handback Loop

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
     standalone Graph UI (`http://127.0.0.1:7041`) or the owner CLI
     (`work.accept`).

## 4. Forking a Task into Parallel Branches

When a task splits into independent sub-questions or implementation branches:

1. If you currently hold the lease on the parent item, release it first via
   `work_block` (with a clear `reason`, e.g., `"Forking into sub-branches"`).
2. Call `work_fork` with the parent's `id`, current `revision`, `reason`,
   optional `gate` (`"done"` or `"commands_passed"`), and `branches` array.
3. `work_fork` atomically creates the child work items, wires them as
   predecessors on the parent, bumps the parent's plan version, and sets the
   parent back to `queued` (waiting until all child branches settle).

## 5. Parallel Wave Execution

When `work_graph` shows multiple `ready` (`claimable: true`) leaves:

- Dispatch parallel workers or subagents, assigning each worker a distinct
  `ready` work ID and an isolated workspace or git worktree.
- Siftable's atomic `work_claim` prevents double-claiming.
- Each worker runs the execution and handback loop independently, submits
  `work_review`, and picks up the next unblocked wave once predecessors satisfy
  their gate.
- If a sandboxed CLI invocation cannot write lease custody next to its
  credential file, set `SIFT_LEASE_DIR` to a private (`0700`) writable
  directory.
