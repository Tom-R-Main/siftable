# Changelog

All notable changes to Siftable are documented in this file.

## [0.2.0] - 2026-11-19

### Added
- **Multi-harness interoperability (`sift connect`)**:
  - `sift connect <antigravity|codex|t3-code|claude|cursor>` writes absolute-path MCP configurations (TOML/JSON merge preserving sibling entries), installs the portable `siftable-dag` skill, supports `--dry-run`, and enforces scoped-credential guards.
  - Portable harness-neutral skill at `.agents/skills/siftable-dag/SKILL.md` separated from Antigravity sidecar rules, plus `SIFT_LEASE_DIR` override in `@siftable/client`.
  - MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), compact text summaries for `work.graph` and `work.list` alongside canonical `structuredContent`, and structured error recovery payloads.
  - Runner-agnostic `examples/harness-session.json` extension schema, runner chips and **Linked Harness Sessions** drawer card, `?workId=` / `?rootId=` / `?projectId=` URL deep links, and **Copy Link** in `@siftable/graph-ui`.
- **Work lifecycle ergonomics and live Graph UI**:
  - Rich 8-state `claimability` diagnostics (`ready`, `waiting`, `dependency_failed`, `leased`, `lease_expired`, `blocked`, `in_review`, `terminal`) with `blockedBy` and `nextAction`, secret-free structured 409 `suggestions`/`details`, and atomic active-lease `work.fork`.
  - `work` module v3 (`modules/work/003.sql`): additive `rank`, `priority`, and `labels` columns, non-invalidating metadata updates in `work.update`, structured `{ changedFields, before, after, invalidatedEvidence }` event diffs, and agent read-side invisible/bidi stripping and secret redaction (`readSanitizer.ts`).
  - Post-commit PostgreSQL `NOTIFY` (`GET /v1/events` SSE with owner/scope isolation) powering `GET /api/events` live updates in `@siftable/graph-ui`, inline drawer action forms (no browser `window.prompt`), toolbar search and **Hide done** filters, `tasks` `workSummary` rollups, and bounded `links.graph` (`depth` 1..3).
- **Repo binding, unified search, and Code Memory**:
  - `projects` module v3 (`modules/projects/003.sql`): `projects.bind` and `projects.resolve` (longest-prefix `root_path` + normalized `git_remote_url` fallback) with read-only main checkout and linked git worktree inspection (`inspectGitCheckout`).
  - `context` module v3 (`modules/context/003.sql`): trigger-synced cross-domain `context.index` (preserving `context-only` physical independence), `context.search` with `ts_rank_cd` recency decay and safe `:*` prefix fallback, and typed `omissionType` + `scopedCandidateDigest` in `context.packet`.
  - Optional embedding-free `memory` module v1 (`modules/memory/001.sql`): 9 `memory.*` operations with lifecycle states (`unreviewed`, `confirmed`, `needs_review`, `rejected`, `superseded`), secret and raw-code-dump guardrails, agent provenance checks, `fact_hash` deduplication, atomic `supersedesId` lineage, FTS × path-proximity × lifecycle ranking, and real git/SHA-256 staleness detection (`memory.detect_stale` + `inspectCodeMemoryPaths`).
- **Diagnostics, CI, and documentation**:
  - Secret-safe `sift doctor` diagnostics, CLI default port aligned to `8088`, GitHub Actions CI workflow (`.github/workflows/ci.yml`), Apache-2.0 `LICENSE`, updated `README.md` with dark-mode Graph UI screenshot (`docs/assets/graph-ui.png`), `docs/OPERATIONS.md`, and `docs/BACKUP_AND_RECOVERY.md`.

### Fixed
- Pre-created `.local/validation` on the host before `docker run` in `scripts/acceptance.mjs` to avoid root-owned directory `EACCES` on Linux CI runners.
- Replaced webview-blocked `window.prompt` calls with inline forms in `@siftable/graph-ui` and fixed `coverage.passed`/`coverage.required` display on DAG cards.

## [0.1.0] - 2026-11-16

### Added
- Initial standalone local-first Siftable release with PostgreSQL 17 modular schemas (`foundation`, `projects`, `context`, `work`, `planning`, `extensions`), HTTP API, CLI, stdio MCP server, Graph UI (`work.graph` / `work.fork`), durable idempotency receipts, lease custody, and verified backup/restore.
