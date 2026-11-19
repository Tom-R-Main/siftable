---
name: siftable-dag
description: >-
  Plan, fork, execute, and hand back dependency-ordered work graphs using local
  Siftable MCP tools and the Siftable Graph sidecar pane. Use when decomposing
  multi-step engineering work into a DAG, picking up the next claimable frontier
  items, running parallel subagents or swarm workers over dependent tasks, or
  recording handback summaries and verification evidence.
---

# Siftable Dependency-Ordered Work Graph (DAG)

Use Siftable as the durable, dependency-ordered source of truth for multi-step
and parallel agent work. Every mutation requires a stable `requestKey` (retry
identical input with the same key after a lost response; use a new key for
changed input).

## 1. Open the Graph Side Pane

When working on a Siftable DAG, surface the interactive Graph sidecar pill once
so the user can inspect dependencies, read handbacks, and accept `Needs you`
items directly inside Antigravity:

```markdown
[Siftable Graph](sidecar://siftable-graph/graph/)
```

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
   - Do **not** attempt to self-accept work; the user accepts via the Siftable
     Graph sidecar pane (`✓ Accept`) or owner CLI (`work.accept`).

## 4. Forking a Task into Parallel Branches

When a task splits into independent sub-questions or implementation branches:

1. If you currently hold the lease on the parent item, release it first via
   `work_block` (with a clear `reason`, e.g., `"Forking into sub-branches"`).
2. Call `work_fork` with the parent's `id`, current `revision`, `reason`,
   optional `gate` (`"done"` or `"commands_passed"`), and `branches` array.
3. `work_fork` atomically creates the child work items, wires them as
   predecessors on the parent, bumps the parent's plan version, and sets the
   parent back to `queued` (waiting until all child branches settle).

## 5. Parallel Frontier Execution in Antigravity

When `work_graph` shows multiple `ready` (`claimable: true`) leaves:

- **Single-chat fan-out:** Spawn parallel subagents (or a `run_workflow` script),
  assigning each worker a distinct `ready` work ID and isolated workspace
  (`share` or `branch`). Siftable's atomic `work_claim` prevents double-claiming.
- **Persistent team (`/teamwork`):** Workers pull `ready` items from `work_graph`
  in parallel, submit `work_review`, and pick up the next unblocked wave as soon
  as predecessors satisfy their gate.
