# Headless extraction execution record

Owner: Thomas Main. Implementation: Codex. Started 2026-11-16.

Authorization: create a new local repository from Tom-R-Main/siftable, reuse any ExecuFunction source, implement the extraction plan and prove the core headless flow with schema modularity. Do not publish or push. Local dependency installation and isolated synthetic PostgreSQL testing are within this implementation scope.

Source: ExecuFunction fb762fd2be4ec62e8ebd8048d75721fbb05ad5c6. Governing plan: docs/extraction-plan.md.

Current milestone: steps 0–5, bounded core vertical slice. Deliver foundation, selectable projects/context/work/extensions, basic planning if core gates permit, real CLI and stdio MCP, durable verification and local operator review. Optional code-memory/collaboration, full hosted-client compatibility, production data import and public release remain subsequent milestones.

Architecture: TypeScript/Node + Express + PostgreSQL; npm workspaces; one service; explicit module SQL ownership and registered operations. No browser or model/provider credentials needed. Synthetic local credentials remain opaque and outside tracked files.

Status: implementation started. Next dependency: fresh-schema bootstrap and scoped work operations; acceptance evidence pending. This record will carry exact test outcomes and remaining limitations.

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

Remaining work, deliberately not claimed complete:

- Full CRUD/archive/repository identity APIs, work edit/block/fail/requeue and dependency edits, wider planning commands, artifact persistence/inspection, and all old public-contract parity.
- Code-memory and collaboration modules; managed execution remains outside this slice.
- Schema record updates, configurable relationship cardinality, extension search integration, module reference removal/uninstall, module upgrade sequencing beyond version 1, and breaking schema migrations.
- Backup/restore/export/import, full workload/performance qualification and broader host/platform checks.
- Root public license selection, independent release review, public publication and outside adoption.

Next implementation dependency: backup/restore with module/evidence integrity checks, then complete the bounded CRUD/work lifecycle before expanding optional domains. Keep the current registry and acceptance journey as the compatibility oracle. Future schema changes require new migrations rather than modifying a baseline already installed by users.

Final receipt: `docs/validation/receipt.json`, with passing TAP reports alongside it. All 15 runtime TypeScript source files were hashed inside the tested image and matched to this checkout. Final acceptance uses nine scenarios/ten Node tests including the parent, with zero failures/skips. Three unit tests also pass. Owned temporary acceptance containers/networks were removed; the local Compose instance is stopped with its volume and protected credentials retained. Resume with `docker compose start`.
