# Headless extraction execution record

Owner: Thomas Main. Implementation: Codex. Started 2026-11-16.

Authorization: create a new local repository from Tom-R-Main/siftable, reuse any ExecuFunction source, implement the extraction plan and prove the core headless flow with schema modularity. Do not publish or push. Local dependency installation and isolated synthetic PostgreSQL testing are within this implementation scope.

Source: ExecuFunction fb762fd2be4ec62e8ebd8048d75721fbb05ad5c6. Governing plan: docs/extraction-plan.md.

Current milestone: steps 0–5, bounded core vertical slice. Deliver foundation, selectable projects/context/work/extensions, basic planning if core gates permit, real CLI and stdio MCP, durable verification and local operator review. Optional code-memory/collaboration, full hosted-client compatibility, production data import and public release remain subsequent milestones.

Architecture: TypeScript/Node + Express + PostgreSQL; npm workspaces; one service; explicit module SQL ownership and registered operations. No browser or model/provider credentials needed. Synthetic local credentials remain opaque and outside tracked files.

Current status: the core extraction plus CRUD/work lifecycle and backup/restore are implemented and checked locally. The milestone sections below preserve chronology and acceptance evidence. Proposed next target: docs/GOAL.md.

## First extraction milestone: implemented and checked

Delivered six independently registered data modules: foundation, projects, context, work, planning, extensions. Thirty-three registry-backed operations are reachable through CLI and MCP over the local HTTP API. Fresh context-only/work-only/extensions-only schemas have been inspected in actual PostgreSQL, not simulated adapters. The selected scope is implemented in this repository; the rest of the larger plan remains pending.

Highest proven rung: **checked locally**, including built container artifacts. No push, publication, deployment to a remote service, production-data migration or external adoption occurred.

Implemented boundaries:

- Separate module-owned SQL schemas, checksummed baseline migrations, explicit Planning -> Projects dependency, fail-closed missing modules, reversible enable/disable, global cross-module reference tracking.
- Local owner/agent credentials, scoped permissions/revocation, personal and named scope isolation through transaction-local RLS, restricted serving role and private lease custody.
- Projects/instructions, planning tasks, Markdown notes/revisions/search, source-bound context packets with explicit character-budget omissions and freshness on reread.
- Work claims/epochs/expiry, dependencies at creation, durable idempotency, immutable plans/evidence/history, evidence failure/coverage distinction, separate operator acceptance bound to a plan version.
- Custom JSON Schema definitions/records and typed relationships through generic operations, additive optional-property schema evolution, absent/invalid/cross-scope reference refusal.
- Protected local bootstrap, Docker image/Compose packaging, README and isolated acceptance runner.

Verification:

- TypeScript build/type checking and formatting checks pass.
- Three pure tests pass, including the extracted coverage function's empty/failure controls and deterministic evidence ordering.
- Nine integration scenarios pass (Node test reports ten including the parent), using real PostgreSQL 17 and Node 22.23.3 with CLI/server/MCP subprocesses. The final pass executes CLI/server/MCP from the built image, not the host source tree.
- Scenarios cover fresh independent schemas; combined project/note/task/work flow; two-principal claim race; response discarded after committed claim and idempotent reconciliation; expiry and stale-owner rejection; agent A CLI -> agent B MCP -> operator acceptance; failed/stale/conflicting evidence; extension schemas/records/links; scope and direct SQL negative controls; credential revocation; module disable/re-enable and adding a module; restart persistence.
- Docker acceptance runs on an internal network with no external route. Normal Compose uses a private database network plus a host-facing server network; it is not an egress sandbox.
- The local startup command reached loopback HTTP readiness and the host CLI read all six installed module states through the packaged service.
- npm install/audit reported zero dependency vulnerabilities at installation time. This is not an independent security review.

Corrections and failed observations preserved:

1. Initial host typecheck found missing explicit Node types, a broad operation cast, and CLI catalog narrowing. Repaired before acceptance.
2. Initial Compose server listened internally but failed host readiness because Docker did not publish the port on an internal-only network. Added the server's host-facing network and reran successfully.
3. Inspection found sub-millisecond evidence timestamps could tie after conversion to JS Date. Added a monotonic database sequence tie-breaker and a negative unit test.
4. Inspection found module references must be enforced across credential scopes and declaration-only relationships, not just visible record links. Added a global module-reference ledger and exercised module addition/declaration refusal.
5. The first generated Compose database contained zero projects, notes or work items when the baseline was finalized. Only that owned synthetic database volume and its generated bootstrap credential were recreated for the final smoke test; the source repository and all pre-existing services/data were preserved.

Remaining work after the first milestone (historical; see the next milestone for resolved items):

- Full CRUD/archive/repository identity APIs, work edit/block/fail/requeue and dependency edits, wider planning commands, artifact persistence/inspection, and all old public-contract parity.
- Code-memory and collaboration modules; managed execution remains outside this slice.
- Schema record updates, configurable relationship cardinality, extension search integration, module reference removal/uninstall, module upgrade sequencing beyond version 1, and breaking schema migrations.
- Backup/restore/export/import, full workload/performance qualification and broader host/platform checks.
- Root public license selection, independent release review, public publication and outside adoption.

Next implementation dependency: backup/restore with module/evidence integrity checks, then complete the bounded CRUD/work lifecycle before expanding optional domains. Keep the current registry and acceptance journey as the compatibility oracle. Future schema changes require new migrations rather than modifying a baseline already installed by users.

Final receipt: `docs/validation/receipt.json`, with passing TAP reports alongside it. All 15 runtime TypeScript source files were hashed inside the tested image and matched to this checkout. Final acceptance uses nine scenarios/ten Node tests including the parent, with zero failures/skips. Three unit tests also pass. Owned temporary acceptance containers/networks were removed; the local Compose instance is stopped with its volume and protected credentials retained. Resume with `docker compose start`.


## Second milestone: CRUD, lifecycle and recovery

User authorization: “Keep going with the extraction. Add backup/restore and finish the remaining CRUD and work lifecycle operations, then prove those flows work too. Keep everything local for now.” No publication, push, cloud mutation or production-data import is authorized or performed. The conceptual end state and next proposed goal are in `GOAL.md`; they do not widen current authority.

Delivered **60 registry operations** across the same six modules:

- Projects, notes, human tasks and custom records now have create/read/list/update/delete/restore paths. Edits use optimistic revisions; owner-only deletion is reversible tombstoning, with reference checks. Note title/source/body changes and deletion/restoration advance immutable revision history. Human task completion remains distinct from work acceptance. Custom relationships have read/update/delete operations while definitions remain immutable.
- Work edit, dependency replacement with cycle checks, block/fail/requeue, terminal delete/restore, and bounded immutable text artifacts. Claim/start/heartbeat/release/review/accept/cancel and evidence remain covered. Requeue, changed intent and dependency edits start a new plan version; prior success cannot approve a retry or changed work. Accepted work cannot be requeued or have its accepted plan revised. Events record transition reasons and current plan versions.
- Every original `001.sql` remains unchanged. Six new `002.sql` migrations add lifecycle fields/artifacts. The runner verifies a per-version checksum ledger and upgrades installed modules transactionally, including disabled modules, while preserving their enablement state. Fresh module-only installations remain physically independent.
- Local admin CLI `backup`, `backup-verify`, and `restore`. Native PostgreSQL 17 snapshot archives include only installed module schemas, with protected files and a completion manifest. Restore requires a new database, verifies per-table row counts/content hashes, reapplies restricted grants, and invalidates active leases with history/epoch changes. Existing databases and serving configuration are never overwritten or switched automatically. Corrupt backups and incompatible module versions fail closed. Failed new targets remain quarantined for inspection, not automatically dropped.

Proof boundary: **checked locally**, through built Node 22 container CLI/server/MCP artifacts and PostgreSQL 17. Fifteen integration scenarios pass (16 Node tests including the parent), plus three pure tests, with zero failures/skips. TypeScript, formatting and diff whitespace checks pass. No independent reviewer, second host, external user or adoption outcome is claimed.

Added acceptance evidence includes:

- A seeded version-1 database upgrades without losing its project; rerunning install is safe; altered migration receipts are rejected.
- CRUD updates, stale edit rejection, list/search hiding, revision history, delete/restore ordering, invalid custom data, custom edge edits/removal and cross-scope refusal.
- Actual MCP worker retry/artifact/evidence flow; cycle rejection, blocked/failed transitions, heartbeat, owner review, fresh coverage after retry/edit, immutable accepted plan, and terminal tombstone inspection/restoration.
- Full-profile backup/recovery compares every table's hash before serving, then reads accepted work/evidence/custom schemas/notes and replays an existing receipt through the recovered API. New writes work after restoration. Active leases become queued with incremented epochs and recorded restore events.
- Context-only recovery retains only its two schemas and preserves disabled context state. Corrupt archive bytes and a deliberately false table hash are rejected. Existing-target restore is refused. A failed new target denies runtime CONNECT. Direct runtime SQL remains scoped and cannot read principal hashes after recovery.

Review correction: inspection found that editing released work with previously passing evidence could retain the old coverage. Work/dependency edits now create new plan versions, with a negative test that refuses acceptance without fresh evidence. Backup row hashing explicitly uses UTC; snapshot acquisition holds the migration lock before creating the snapshot. A final migration review also closed missing-ledger and inconsistent module-metadata cases; both now fail closed and have negative acceptance checks.

Retained local installation: saved a private pre-upgrade PostgreSQL archive at `.local/pre-upgrade-v1.dump`, upgraded all six modules to version 2, and verified loopback API/catalog access. Created and verified `.local/backup-v2-20261116/` (23 owned tables), then restored into `siftable_recovery_20261116` with verified integrity. Original and recovered databases are both retained; the service still points at the original `siftable` database. Credentials and backup contents were never emitted in chat or tracked. The retained Compose services are stopped after verification; resume with `docker compose start`.

Current limits and next dependency:

- This completes the bounded record CRUD/work lifecycle, not the full former SaaS contract. Repository checkout mapping, rich goals/planning, code memory, collaboration and managed execution remain deferred.
- Deletion preserves data and is not secure erasure. Module dependency metadata remains conservative; disabling/uninstalling a formerly linked module may need a future explicit migration. Relationship cardinality and breaking custom-schema migrations remain deferred.
- Backup requires PostgreSQL major 17 and the executable matching module schema versions; retain application artifacts alongside backups. It excludes plaintext credentials, database role passwords, external files and unrelated schemas. Only trusted native archives may be restored. Portable record interchange/import and retention scheduling remain future work.
- No throughput qualification, broad host compatibility proof, independent security/release review, root-license decision or public release.

Next proposed milestone: use one real local project for two agent handoffs and a recovery drill, record actual friction, then stabilize documentation/contracts and verify on a second host. Do not add optional domains merely to complete the old product inventory. Release remains a separate decision.

The updated machine-readable receipt and TAP reports are under `docs/validation/`. They identify the tested container and source hashes; local commit identity is separate from runtime verification.
