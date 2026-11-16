# Headless extraction execution record

Owner: Thomas Main. Implementation: Codex. Started 2026-11-16.

Authorization: create a new local repository from Tom-R-Main/siftable, reuse any ExecuFunction source, implement the extraction plan and prove the core headless flow with schema modularity. Do not publish or push. Local dependency installation and isolated synthetic PostgreSQL testing are within this implementation scope.

Source: ExecuFunction fb762fd2be4ec62e8ebd8048d75721fbb05ad5c6. Governing plan: docs/extraction-plan.md.

Current milestone: core extraction, CRUD/lifecycle/recovery, the first real local pilot, and automated clean-environment README onboarding are complete. The original steps 0–5 delivered selectable modules, CLI/MCP, durable verification and operator review; later sections record the completed pilot. Recommended next gate is an independent operator following the README and an independent security/recovery review. Optional code-memory/collaboration, full hosted-client compatibility, production data import and public release remain deferred.

Architecture: TypeScript/Node + Express + PostgreSQL; npm workspaces; one service; explicit module SQL ownership and registered operations. No browser or model/provider credentials needed. Synthetic local credentials remain opaque and outside tracked files.

Current status: the core extraction plus CRUD/work lifecycle and backup/restore are implemented, checked, and used locally for the extraction’s own two-agent-handoff recovery pilot. The milestone sections below preserve chronology and acceptance evidence. Proposed next target: docs/GOAL.md.

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

## First real-use pilot: completed locally

Authorization (2026-11-16): Thomas asked to use the extraction itself as the first real project, run two agent handoffs and a recovery drill through CLI/MCP, fix encountered friction, and keep everything local. The user started the retained service; leave that service available. Root owns coordination, recovery isolation, final evidence reconciliation and docs. Independently delegated agents will own discovery, repair, and recovered-state verification in sequence.

Proof obligation: actual separate agents must consume the persisted handoff records, not merely repeat a scripted synthetic journey. Source database `siftable` at loopback port 8088 remains authoritative. The restored database is a verification branch; reconcile its evidence back to source explicitly. Do not switch the source service or overwrite a database. The code repository and this execution record remain the implementation authority; the local project/work records carry executable handoff state.

Bounded job: discover and repair one concrete CLI/MCP usability problem while conducting the extraction's own handoff. Failure controls include the original unrepaired behavior, prior failed evidence retained, stale source lease refusal on recovery, and unchanged source serving state. No public release, cloud mutation, production import or claim of outside adoption. Agent verification and root operator acceptance are not Thomas's human acceptance.

The private operational receipt is `.local/pilot-20261116/run.json`; it stores IDs and credential paths, never credential values. Final non-secret findings and runtime evidence will be referenced here after the drill.


Pilot outcome: the extraction is now its own first real local project. Actual independent agents A → B → C performed two handoffs on work `b3cbe36c-07cd-44ae-ab26-cd76ed458668`. A used CLI, B consumed stored context through MCP, and C resumed the restored snapshot through MCP/CLI before explicitly appending its evidence back to the canonical source. Source project `cede87ab-2050-4760-8548-4d1b4877e697` and task `3bb2ec9a-2d80-4af2-a79c-a4e787d1097c` persist locally.

Observed friction and corrections:

- A could not discover required payload fields from operation help; proceeding required private assignment hints. B implemented credential-free, registry-backed CLI operation help and six subprocess tests, including all 60 operation schemas. A's failed attempt was retained, followed by B/C successful verification.
- C found MCP tool discovery incorrectly marked defaulted inputs required. Root switched it to input-mode JSON Schema; C independently verified fresh tool discovery and omitted-default calls. The original mismatch and correction remain separate immutable reports.
- C's artifact write required listing to discover its new ID. Root added `artifactId` to new mutation receipts/events. Follow-up work `9eaa6edb-7025-4e44-bc48-d6b63c628a8b` preserves that observation and C's independent direct-get, identical-key replay, and changed-input rejection checks. Previous receipts remain unchanged.

Recovery: the real mid-work snapshot verified 23 tables/96 rows and restored into `siftable_pilot_20261116`. B's active epoch 2 became queued epoch 3, with an invalidation event. Replaying B's exact claim returned its historical receipt, but a new heartbeat using that old lease was rejected. C freshly claimed at epoch 4 and continued useful work. Source remained the canonical database; the drill database was never promoted. After final regression checks, only the source API container was reloaded to deliver the artifact-receipt fix; the source database and records were preserved.

Acceptance: root reviewed the actual records/reports/digests and passing regression checks, then used the owner CLI to record delegated technical acceptance of main and follow-up work. Both are `done` with `commands_passed`; the human planning task is `done`. This is not Thomas's human acceptance or outside adoption. C's recovered verification branch remains `needs_review`, distinctly not promoted or operator-accepted.

Final validation: 9 unit/CLI tests, 15 packaged integration scenarios (16 Node tests including their parent), typecheck, formatting and diff checks pass. The actual MCP regression now checks optional defaults and artifact-ID direct retrieval/replay. Final tested runtime sources/artifacts/modules are hashed in the pilot receipt.

Cleanup: original service stays available at `http://127.0.0.1:8088`. The temporary recovery server was stopped and removed. Both databases and private backups remain. A/B/C temporary credentials were revoked in both databases and rejection was checked. A final verified checkpoint backup at `.local/pilot-20261116/backup-complete/` captures the accepted work and revocations (23 tables/163 rows); this is separate from the mid-work drill archive.

Evidence: `docs/pilot/2026-11-16.md`, `docs/pilot/receipt.json`, and test reports beside them. Highest proven boundary: **used locally on the real extraction job**, including independent agent continuation and recovery. Next unresolved dependency is unaided setup on a second clean host plus independent review; no additional domain expansion or publication was authorized.

## Clean-environment README gate: completed locally

Authorization (2026-11-16): prove setup from the README without existing configuration or private help, repair encountered gaps, and keep everything local. Root owns this gate. Test boundary: a fresh Linux container with a separate nested Docker daemon, empty application/image/database/npm state, a non-root user with Docker access, and only tracked source. No host Docker socket, home directory, existing `.local` files or private pilot helpers enter the environment. Dependency/image downloads are part of setup; no service is published.

Prediction: the README commands bootstrap a new installation, expose permitted CLI/MCP operations, and support a first context/work/evidence/review cycle. Negative controls include missing credentials and refused agent acceptance. Existing pilot service and database must remain unchanged. This is a reproducible automated clean-environment test, not an independent human usability study or a second physical machine. Preserve baseline failures and rerun the final README on fresh state after repairs. Next dependency: actual baseline result and any necessary onboarding corrections.


Outcome: the original README bootstrap exposed a Linux ownership defect: it reported ready, but the first CLI call failed because Docker wrote the mode-0600 owner credential as root. Compose administration now drops to the mounted private directory's UID/GID before writing credentials/backups. Added token-free `config.info`, a public runnable first CLI/MCP work example, and a repeatable `test:readme` gate. README now names prerequisites, port/fixed-project constraints, safe troubleshooting and the actual first useful journey.

Final clean proof: committed source `6d51c29a65377993d65d052411b708365caa550e` was copied into fresh Linux arm64 with Node 22.23.3, Docker 29.9.3, Compose 5.7.1 and non-root UID/GID 10001. No host socket/home/configuration, old monorepo, existing images/volumes/npm cache or private setup helper was supplied. The ordinary README setup worked without manual repair; credentials and backup directory belonged to that non-root user with private permissions. CLI create/claim, real stdio MCP note/context/evidence/review, forbidden agent acceptance, owner CLI acceptance, restart, and 23-table backup/restore with recovered work/note reads all passed. This was a scripted tutorial and technical acceptance, not an independent human or new delegated-agent pilot.

Regression: 10 unit/CLI tests, 15 integration scenarios (16 Node tests including parent), build/typecheck, formatting and whitespace checks passed with zero failures/skips. Evidence and baseline failure: `docs/onboarding/2026-11-16.md`, `receipt.json`, `readme.log`, `regression.tap`, `baseline.txt`. Later edits only record evidence and fix README code-block rendering; executable source matches the tested commit.

Cleanup/delivery: disposable cleanroom containers and their anonymous volumes were removed. Existing real pilot container ID/image/start time are unchanged and loopback health passed; no source database mutation occurred. The tested image was tagged locally for future Compose administration and its admin entrypoint checked with the read-only module planner. No push, publication, cloud action or production import. Highest boundary: **checked from a clean Linux environment**, in addition to the prior real local-use milestone. Independent human usability, broader host qualification and independent security/recovery review remain the next unresolved dependencies; do not expand optional domains to substitute for those checks.

## Independent security and recovery review: in progress

Authorization (2026-11-16): Thomas requested fresh agents review credential scopes, migrations and restore paths, fix findings, and keep everything local, using tometo-mode. Review baseline: `47511c14992c1404cef1d950c67a66bed1a5c7f3`. Root owns adjudication, implementation, regressions and final delivery; three fresh read-only contexts own credential scopes, migrations/runtime roles, and backup/restore. They inherit the session model; separate contexts do not establish model diversity.

Proof obligation: reproduce concrete boundary failures in disposable local PostgreSQL/CLI/MCP environments; preserve baseline failures, repair the mechanism, and obtain reviewer readback against final code. Existing pilot credentials, database and running server remain untouched. Local build/test artifacts and commits are authorized; no push, publication, cloud action, paid provider CLI or production import. The trust boundary includes the operator/admin and same OS user; native archives remain trusted inputs, while API credentials must retain owner/scope/role/permission boundaries.

Requirements: (1) narrower credentials cannot obtain unauthorized module data or operator actions; (2) installation/upgrade validates ledgers and runtime-role confinement without partial schema changes; (3) recovery preserves records while quarantining incomplete targets and invalidating active leases. Evidence will bind source/artifact identity to public entry points and durable side effects. Independent reviewer agreement alone is not runtime proof. Next dependency: scoped findings and bounded reproductions.


Review outcome as of 2026-11-16: all three fresh reviewers cleared their final scopes at `c915c694d9807ef334faece556d02e4b8fdedd54`. Root reproduced and fixed stale/reordered claim custody, disabled-prerequisite installation, and false restore quarantine after uncertain PostgreSQL effects. Review also caught and corrected a pre-upgrade lease retry regression. Tests: 23 main packaged scenarios plus four restore fault/prerequisite subtests and parent (28 Node tests), 10 unit/CLI tests, typecheck, formatting and whitespace pass. The tested image matches 53 runtime source/compiled/module/admin files. No baseline SQL migration changed. Details and reviewer receipts: `docs/security-review/`.

Additional clean-environment rerun reached bootstrap and CLI/MCP acceptance but failed during Docker networking restart with an I/O error. Docker Desktop then reported its metadata filesystem read-only, blocking owned-helper cleanup. Existing pilot container identity/image/start time are unchanged but health now returns 500; no pilot data/credentials were mutated by this review. Root cause remains unavailable. Helper `sift-readme-71dbb012` is the only remaining task-owned cleanup target from that run. Waiting on Thomas's decision about `docker desktop restart` before machine-level recovery; no broad pruning or unrelated resource deletion is authorized. Product security/recovery proof is checked locally; full repeat clean-environment proof and current pilot availability remain blocked by the runtime condition.
