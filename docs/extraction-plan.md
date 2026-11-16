# Siftable headless open-source extraction

Date: 2026-11-16. Owner: Thomas Main. Status: proposed, source-inspected extraction plan.
Source checkout HEAD: `fb762fd2be4ec62e8ebd8048d75721fbb05ad5c6`.

## Intent and evidence boundary

Thomas wants a standalone, locally runnable, entirely headless open-source project for context, projects, and work-item management. Its schema should be extensible, and installations should include only the domains they need. Existing agents and scripts are the clients. Siftable hosting remains retired.

This document is the authoritative record for this planning task. It authorizes no publication, cloud restoration, dependency installation, or implementation by itself. The source map below is based on inspected services, callers, contracts, and migrations. Existing unrelated worktree changes were preserved. No database was started or populated. Nx could not resolve installed workspace modules, so there is no new build, test, or fresh-install evidence.

The promised rung for this task is **specified**. The first implementation milestone must reach **checked** through a real CLI/MCP journey. Public delivery and outside adoption are separate gates.

## Product and first supported scope

Run one local Siftable server, select data modules, and connect an agent through MCP or CLI. Persist useful context and work across clients, sessions, and restarts.

| Module | First-release behavior | Required modules |
|---|---|---|
| Foundation | Local owner and agent credentials, personal/named scopes, schema/module registry, migrations, transaction identity, idempotency, errors and audit | None; always present |
| Projects | Projects, goals, repository identities and links, bounded project brief | Foundation |
| Context | Markdown notes, revisions, provenance, lexical search, bounded context packets | Foundation; project linkage when Projects is installed |
| Work | Work items, agent aliases, leases, dependencies, immutable revisions, evidence plans/attempts, review and completion | Foundation; project/context links when installed |
| Planning | Human planning tasks, acceptance criteria, optional task-to-work links | Projects; integrates with Work when installed |
| Schema extensions | Namespaced custom object definitions, validated records, typed links, introspection | Foundation; integrates with Context when installed |
| Code memory | Curated repository facts, admission/rejection/supersession history, stale-source indication | Context and Projects |
| Collaboration | Participants, messages/events, acknowledgement and resumable cursors | Work |

Recommended preset: Foundation + Projects + Context + Work + Planning. Ship Schema extensions in the first public release to prove extensibility; it remains optional to install. Code memory and Collaboration follow after the minimal core journey passes, with a separate acceptance lane each. These are proposed module boundaries, not boundaries already present in the code.

Support at least three tested installation profiles: context-only, work-only, and the recommended preset. Work-only has a local scope and agent identities but requires no project or context tables. Where an optional association is requested without its module, reject explicitly; never silently discard it.

The initial audience is one owner running several agents on a workstation or private server. Preserve ownership and scope enforcement for later shared use; polished multi-user invitations and public Internet deployment are not first-release claims. Agents execute their own tasks and submit evidence. Siftable does not need to launch models or execute shell commands to manage work.

## Architecture choice

Keep TypeScript, Node, Express, and PostgreSQL as the initial implementation. Reuse the SQL transaction, claim, RLS, and evidence semantics. Start with one application process and one database, not a process per domain. Keep pgvector as an optional context capability, not a condition of core operation. Use npm workspaces and explicit dependency ordering; Nx may remain development tooling if a reduced graph is straightforward, but users must run prebuilt artifacts without Nx, Zig, Bun, or the source monorepo.

| Candidate | Advantage | Why not select it initially / reversal condition |
|---|---|---|
| Selected TypeScript + PostgreSQL modular service | Reuses actual transactional work and access contracts | Reconsider if measured resource/distribution costs fail the local acceptance budget |
| Trimmed existing full API | Fastest route to a prototype | Boot and SQL remain entangled with many unrelated domains; useful as a behavior oracle, not the distribution |
| SQLite embedded service | Smaller install and possible single-process operation | Requires porting locking, RLS, SQL functions and recovery behavior; reconsider if PostgreSQL is the demonstrated adoption blocker |
| Go/Rust standalone rewrite | Potential native packaging and resource benefits | Requires reconstructing the same contracts; no current performance measurement establishes that need |

Proposed benchmark envelope: 1 owner, 10 simultaneous clients, 100 projects, 10,000 work items and 10,000 notes, including a highly contended single queue. These are test fixtures, not measured capacity or limits. Record cold start, idle RSS, DB/application resource use, p50/p95 list/search/claim latency, and retry failures. Correctness under contention is a release gate; numerical performance budgets should be set after the first vertical slice produces a baseline.

Proposed repository layout:

```text
apps/server/                 minimal bootstrap, REST, HTTP MCP
packages/contracts/          runtime schemas, IDs, errors, receipts, manifests
packages/core/               foundation and built-in domain modules
packages/client/             typed HTTP client used by CLI and MCP
packages/cli/                headless operator and agent commands
packages/mcp/                stdio transport, tools, discovery, receipts
modules/                     module manifests and module-owned SQL migrations
examples/                    synthetic data and custom-schema example
tests/acceptance/             fresh installation and cross-client journeys
compose.yaml                 server + database + persistent volumes
```

Use directional dependencies: contracts <- core/client <- server/CLI/MCP. The server must not import its display types from the MCP executable package. The CLI must not obtain its HTTP client through an internal MCP path.

## Schema modularity and extensibility

The existing ontology is valuable: V240 describes namespaces, entity types, relationship types, value domains, projection sources, vertices, and dependency edges while retaining stronger domain tables. V246/V248 add custom records and typed relationships. Keep that hybrid principle: fixed relational state machines for work and verification; schema-validated JSON records for user-defined domains.

Implement four distinct controls:

1. **Installed modules:** own tables, migrations, schemas and dependencies. A fresh context-only database has no work, CRM, billing or calendar tables.
2. **Enabled modules:** register routes, search projectors and background activity. Disabling preserves stored data; it does not silently uninstall tables.
3. **Client tool profile:** expose a selected catalog to a particular MCP/CLI client. This is a presentation choice, never authorization.
4. **Principal permissions:** enforce owner/project/scope and operation permissions on every REST and MCP call, including direct calls to hidden tools.

Each module declares an ID, version, required modules/version ranges, optional integrations, owned schema objects, migration checksums, entity/relationship definitions, tool registrations, and config needs. Resolve and show the full dependency plan before applying migrations. A module may not reference an absent table through a foreign key, trigger, SQL function, view, import, or startup callback. Optional cross-module associations belong to explicit integration migrations loaded only when both modules exist.

Avoid a generic third-party code plugin host in v0.1. Built-in code modules are trusted application code. User extensions are declarative data definitions: namespaced type key, definition version, JSON Schema, display field, permitted relationships and reference targets. Disable remote schema resolution, reject executable code/SQL/templates, bound schema and record sizes, and validate records on every write. Reuse a maintained validator rather than building a new validation language.

Example outcome: an operator defines `research.paper`, with title, URL and publication date, then defines `research.supports` from a paper to a project or work item. Generic object create/get/list/update and relation tools support it without creating one MCP tool per type. If Projects is absent, a relation requiring a project is rejected at definition/install time. Context search can index the extension only when the Context integration is enabled.

The current source is a starting point, not proof of that contract:

- `exf-app/src/services/customObjectService.ts` stores `schema_json` and `data_json`; storage alone does not establish schema validation. `createCustomObject` currently upserts the schema, so introduce immutable schema versions and an explicit upgrade operation.
- `typedRelationshipService.ts` and V248 use a `lens_id`; replace the UI-owned namespace with a module/extension namespace, retaining original provenance on import.
- `packages/shared/src/types/entityGraphContract.ts` contains a static type enumeration. Move generic discovery/traversal to the installed registry; keep built-in exhaustive unions for built-in behavior.
- V240 projection definitions include SQL expressions and source table names. Only trusted built-in modules may supply those; declarative user definitions cannot become arbitrary SQL.
- Validate endpoint existence, scope, type and cardinality for relationships. Preserve cross-scope refusal even when both objects are known.

Support additive schema upgrades first. Breaking changes produce a dry-run impact report and require an explicit migration with backup. Disabling an extension freezes writes and retains read/export access through an administrative recovery surface; dependencies cannot continue writing invalid references. Uninstall/data deletion is a separate explicit operation. Module removal must refuse while dependents or live relationships exist unless an explicit migration resolves them.

## Source extraction map

All paths below are relative to this repository. Keep means preserve behavior and relevant tests, not copy the whole file unchanged. The companion `siftable-headless-source-inventory.json` records selected source files, hashes, imports and matching tests. It is an extraction seed, not a fully resolved compiler/SQL dependency graph.

| Source | Destination / treatment | Required cut or change |
|---|---|---|
| `exf-app/src/db.ts`, `errors.ts`; `services/mutationIdempotencyService.ts`; `controllers/lib/idempotentMutationRoute.ts` | Foundation | New minimal config; preserve borrowed-client transaction identity, rollback and idempotency behavior |
| `services/patService.ts`, `middleware/patAuth.ts` | Foundation auth | Extract token hashing/validation, scopes/revocation; replace hosted issuance and catalog dependencies with local bootstrap |
| `services/projectService.ts`, `projectAccessService.ts`; `controllers/projectController.ts` | Projects | Separate CRUD/goals/access from Resend, email invitations, people membership, calendar and planning recomputation |
| `services/repositoryIdentityService.ts`; `controllers/repositoryIdentityController.ts` | Projects | Keep durable repository IDs and checkout mapping; decouple from full code indexing and `code_repositories` where possible |
| `services/taskService.ts`; `routes/tasks.ts` | Planning | Retain basic planning/acceptance/status; remove email, recurrence, calendar coupling and AI breakdown; reject unsupported fields |
| `services/knowledgeNoteService.ts`; `controllers/knowledgeController.ts` | Context | Separate Markdown/text CRUD, revisions and lexical search from TipTap authoring, datasets, temporal facts, embeddings and document ingestion |
| `services/contextSearchService.ts`, `contextIndexService.ts` | Context | Keep full-text search; index only installed domains; remove unconditional people/calendar projectors |
| `services/contextCompilerService.ts`, `contextPacket/manifest.ts` | Context | Keep provenance, budget, omissions and manifests; remove chat/operator/assistant dependencies and provide a CLI/MCP entry point |
| `services/contextGraphService.ts` | Foundation registry + optional graph integrations | Split core reference/link helpers from datasets, custom object loaders and organization/CRM traversal |
| `services/agentWorkService.ts`, `agentWorkItemsRead.ts`, `agentWorkClaimDigest.ts`; `config/agentWorkContractPolicy.ts` | Work | Preserve claim/epoch/revision/dependency state machine; cut mobile, ingestion and resumable-study hooks; make project/task/context associations optional |
| `services/agentWorkVerificationPlanService.ts`, `agentWorkVerificationCoverage.ts` | Work evidence | Retain immutable plan/step/attempt identity and redaction; decouple optional managed execution-attempt binding |
| `controllers/workItemsController.ts`, `controllers/lib/workItemCreateSchema.ts` | Work HTTP routes | Remove mounted mobile, A2A, managed execution and runtime-request/control routers; remove coverage-shadow AI route and mobile notifications |
| `services/verifierRunService.ts` | Legacy import/read compatibility only | Already retires new hosted verifier runs. Do not expose a working `verify` dispatch or invent automatic `verified` promotion |
| `services/codeMemoryService.ts`, `codeMemoryCapture.ts`, `codeMemorySafety.ts` | Code memory | Separate lifecycle/provenance from embedding generation, old chunk indexes and broad user-memory storage |
| `services/agentWorkCollaborationService.ts`, `agentWorkCollaborationDelivery.ts`; `controllers/workItemCollaborationController.ts` | Collaboration | Retain authorized participants, immutable event stream, recipient checks and durable cursors; adapt workspace membership dependency |
| `services/customObjectService.ts`, `typedRelationshipService.ts`; `types/customObject.ts`, `types/typedRelationship.ts` | Schema extensions | Add enforced versioned definitions; replace Lens ownership; preserve bounded query and scope checks |
| `services/ontology/*` | Selective reference, not wholesale keep | Entity loaders and action runtimes span business domains; generic read/introspection is retained, arbitrary actions deferred |
| `packages/shared/src/types/{project,task,siftContext,contextSource,agentWorkContract,agentWorkVerification,agentWorkSecrets,agentWorkCollaboration}.ts` | Contracts | Trim domain imports; keep validators and explicit scope semantics; no hooks/UI barrel exports |
| `packages/exf-mcp-server/src/exfClient.ts`, `publicWorkDisplay.ts` | Client and Contracts | Split client by module; move public DTO/redaction functions out of transport package |
| `packages/exf-mcp-server/src/tools/{projects,tasks,notes,work,code,graph}/` | MCP | Select retained operations; remove unsupported recompute/coupling/actions; add extension CRUD and context-packet tools |
| MCP `factory.ts`, `tools/catalog.ts`, `tools/dispatch.ts`, `registry/*`, input validation and receipt helpers | MCP | Build catalog from enabled modules and token scope; remove Apps views, hosted OAuth elevation, Vault, AI and unrelated registries |
| `packages/exf-cli/src/commands/{context,projects,tasks,notes,agents,work,code/memory}/` | CLI | Keep selected commands below; rewrite auth/config; omit unsupported commands from help and discovery |
| CLI `lib/base-command.ts`, `work-action.ts`, `work-lease-session.ts`, workspace/repository helpers | CLI | Depend on standalone client; retain secure lease custody and explicit endpoint selection |
| Existing domain unit/PostgreSQL/CLI/MCP tests | Relevant new package | Use as behavior oracles; adapt fixtures deliberately and add real fresh-install acceptance |

Do not copy: `apps/mobile`, `apps/chrome-extension`, `apps/editorial-workbench`, `exf-app/web`, marketing `public`, legacy `server.js`, cloud build/Terraform configuration, retired runbooks, private research/evaluation records, CLI interactive TUI, terminal daemon, managed agent runtime, billing/model gateway, Vault, CRM/calendar connectors, GIS, document/media processing, Taster, or the whole shared/UI package. These may become future independent modules only after a concrete user need and a new extraction check.

## Public command and tool contract

Preserve useful existing command names and JSON shapes where semantics remain true. Version deliberate removals; do not claim old-client compatibility across the entire hosted surface.

- Projects: list/create/update/archive/context, repository registration/linking. Defer `planning-recompute` and the constraint-planning engine.
- Context: current, notes list/get/create/update/archive/search, packet build/get, source and revision inspection. Markdown is canonical for new notes; legacy TipTap imports require explicit conversion/fidelity reporting.
- Work: list/get/create/edit/revisions, claim/start/heartbeat/block/review/complete/fail/release/cancel/requeue, dependencies and policy, artifacts, verification plan/history/revise/evidence. A completed status remains separate from evidence coverage and human acceptance.
- Agents: list/get/create/update/disable and assigned work. These identify participants; registering one does not launch it.
- Planning: basic task CRUD/completion and task/work linkage; omit coupling graph/recomputation until separately extracted.
- Extensions: schema inspect/validate/install/upgrade, object CRUD/query and typed relationships. Same generic tools serve every user-defined schema.
- Optional Code memory: store/list/get/search/events/confirm/reject/edit/supersede/needs-review/detect-stale. Optional Collaboration: participants/send/events/wait/acknowledge.
- New operator surface: init, serve, doctor, modules plan/enable/disable, credential issue/revoke, backup/restore/export. These names are proposed, not commands available today.

Every supported workflow must finish in a terminal. Current `work approve` and `work answer` launch the browser for managed execution requests; those runtime workflows are deferred. Core review acceptance gets a narrowly scoped operator command/API; worker credentials cannot acquire operator authority. A browserless flag that merely prints an approval URL does not satisfy headless acceptance.

Local initialization creates an owner and scoped credentials through a local administration path. Credential values stay in protected stores/files and out of receipts, ordinary JSON results and logs. CLI and stdio MCP resolve references to those credentials. Bind to loopback by default; the container must listen on its container interface while Compose publishes only to host loopback. Require credentials even locally. No Google login, hosted service token, model API key, or public endpoint is needed for the basic journey.

Keep code execution outside the service. Evidence is an attributed claim by its submitter; a passing evidence record does not independently prove the submitted command ran. Preserve evidence provenance and allow an authorized reviewer to accept a result without relabeling it as automated independent verification.

## Database extraction

Create a new migration lineage for fresh installations. Reconstruct final selected definitions from all applicable migrations, not just the first CREATE TABLE. The following are source anchors, not a complete replay list:

| Domain | Tables / semantics to preserve | Starting migration evidence |
|---|---|---|
| Foundation | Owner/scope/credentials, idempotency receipts, module ledger, registry, entity references | V365; selected auth/RLS migrations; V240 registry |
| Projects | `projects`, goals, updates, durable repository identities; selected access tables | V69, V133/V134, V158, V210, V323, V448 |
| Planning | `tasks`, acceptance criteria and project association | V18, V23, V142, V158 and later scope repairs |
| Context | `knowledge_notes`, revisions, `context_items`, entity links, compiled packets/items/sources/omissions | V46/V47/V58, V215, V236, V395, V453, V467 |
| Work | aliases, work items, dependencies, revisions, artifacts, plans/steps/evidence attempts | V220, V234, V278, V308, V319, V340, V446, V454, V461/V463/V465, V481 |
| Code memory | selected memory records, repository links and lifecycle events | V323, V351, V389 |
| Collaboration | participants, events, cursors, integrity functions/triggers | V418, V490/V491 |
| Extensions | selected registry tables, custom definitions/records and typed edges | V240, V246, V248, V258 and later scope changes |

Examples of hidden dependencies requiring explicit decisions: V446 introduces artifacts alongside agent rooms; retain artifact invariants without requiring rooms. V481 binds verification to managed attempts; basic external evidence must work without those tables. Code memory is stored through `user_memories` and may reference `code_chunks`; extract an explicit record model while preserving provenance. V246 originally required an organization-backed workspace; reconcile later nullable-scope changes before forming the new schema.

For every retained SQL object, inventory columns/defaults, foreign keys, enums/checks, indexes, RLS policies, SQL functions, triggers, and later modifications. Assign one module owner and an explicit integration owner for cross-module links. Compare the new schema against this inventory. No hidden foreign key or function reference may pull in absent domains.

Application connections use a restricted role; migration/backup administration is separate. Retain transaction-local identity and explicit personal/null scope. No development identity injection or superuser application connection. Core search uses PostgreSQL full-text search without attempting remote embeddings; note writes must not enqueue work for a missing embedding subsystem.

Use fresh synthetic data for extraction tests. Migrating Thomas's old data is a later explicit operation, not a prerequisite for publishing software. Define a versioned export with IDs, timestamps, scope, source versions, schema versions, links, and evidence lineage; imports report unsupported fields and never silently claim lossless migration. Backup/restore must preserve the module ledger as well as records. Before upgrades, back up; if a migration is not backward compatible, recover by documented restore rather than pretending image rollback reverses schema changes.

## Ordered implementation and delivery plan

Each row is an implementation-sized change with an observable exit. The implementation lead owns coordination; module owners can be assigned when implementation is authorized. No subagents or work items were dispatched by this planning task.

| Step | Work and deliverable | Exit evidence |
|---|---|---|
| 0. Freeze extraction contract | Select source SHA, finalize module/tool inventory, record intentional compatibility changes, enumerate SQL object closure | Every supported command has an owning module and test; every retained table/function has an owner; no unresolved implicit domain dependencies |
| 1. Prove the hard cut | Isolated staging tree, minimal auth/bootstrap + PostgreSQL + Work; extract contracts/client; CLI and MCP claim path | Fresh DB; two clients race for one item, only one claims; restart and lease expiry permit safe takeover; no browser/cloud dependency |
| 2. Establish modules | Module ledger, dependency resolver, per-module migrations, registry, startup registration | Context-only and work-only installations boot and operate without each other's tables; disabled routes refuse direct invocation |
| 3. Extract projects/context/planning | Basic CRUD, revisions, lexical index, repository mapping, explicit context packets and planning/work links | Agent B obtains project instructions and prior evidence created by A; restart retains it; search works with network egress denied |
| 4. Prove schema extension | Declarative definition validator/versioning, custom records, generic tools and typed links | Install a synthetic research schema without editing core code; create/query/link it through CLI and MCP; invalid and cross-scope writes fail |
| 5. Complete work evidence/review | Plans/revisions/artifacts, scoped operator acceptance, replay/lost-response behavior | Evidence attaches only to exact active plan/step; stale lease cannot mutate; review acceptance records actor; failure remains failure |
| 6. Add optional rich modules | Code memory and Collaboration, independently installable | Curation history survives restore; messages/cursors survive restart; recipient permissions and bounded waits pass |
| 7. Package and document | Pinned builds/images, Compose, minimal config, doctor, backup/restore, synthetic examples, module/extension author guide | Clean machine follows README through full lifecycle with no undeclared build tools or retired endpoints |
| 8. Prepare public release | Public allowlist, source/license provenance, secret/private-content scan, standalone CI, release notes and contribution/security instructions | Reviewable release tree and tarballs contain only intended files; package installation has no monorepo-relative imports |
| 9. Release and validate usefulness | After explicit publishing authorization, publish reviewed artifacts; invite voluntary external trials | At least two outside users complete the documented journey without private setup help; record failures and repeat use separately |

Steps 1 and 4 are the discriminating experiments. Stop expanding scope if either needs the entire old application. Repair the module boundary or revise the design before adding domains. Do not start by extracting every service or building a general plugin marketplace.

Preserve the private repository and history. Build a separate allowlisted public tree with an upstream revision/provenance manifest. Keep original copyright and third-party notices. MIT is the initial licensing candidate because CLI/MCP already use it; the owner must select the root license after checking rights and bundled dependency notices. Existing package licenses do not establish permission for every file. Publication requires a separate release approval; the current request is for this plan.

## Release acceptance matrix

1. **Headless entry point:** install, bootstrap, configure MCP, create scope/project/note/work, claim, submit evidence, accept, restart, retrieve and export entirely through documented CLI/MCP paths.
2. **Small compositions:** context-only, work-only, recommended preset, plus extensions; verify absent modules have no tables, required env vars, routes, tools or background activity on fresh installs.
3. **Concurrency/recovery:** competing claims; expired/revoked/stale epochs; dependency cycles; duplicate requests; response lost after commit; abrupt restart; bounded cancellation of waits.
4. **Evidence truth:** wrong plan/step and conflicting attempt replay rejected; missing/failed/skipped evidence never becomes passed; changing plan does not rewrite history; submitted output never masquerades as an independently observed run.
5. **Scope/auth:** owner vs worker; personal/null vs named scope; direct HTTP vs MCP parity; guessed IDs and hidden tool calls rejected; DB identity absent/wrong rejects access; credentials never included in exported records.
6. **Context:** deterministic lexical search with egress denied; revision/source references; stale sources marked; oversized packets report omissions; unreadable sources contribute neither content nor revealing metadata.
7. **Extensibility:** invalid records, absent endpoint types, cross-scope references, incompatible versions, malicious schema references and oversized schemas rejected; disabling retains recoverable data; dependency removal refuses safely.
8. **Portability:** fresh database upgrade; backup/restore with representative records and ledger equality; import fidelity report; exact published artifact works with no reference to the original checkout.

Run retained unit and PostgreSQL tests appropriate to each boundary, plus actual packaged CLI/MCP acceptance. Deliberately wrong evidence, unauthorized principals and simultaneous claims are negative controls. A green mocked suite alone is insufficient. Offline runtime means no required cloud calls after artifacts are obtained; it does not imply offline package installation or image builds.

## Open decisions and next dependency

No additional preference is needed to begin a local implementation of this proposal once authorized. The next dependency is the Step 0 contract inventory and Step 1 isolated vertical slice. Root license and final public repo/package names must be settled before publication. Exact dependency versions, build graph, database closure and supported host platforms remain verification tasks because this planning pass did not install dependencies or run the system.

Schema extension validation and module composition are new work. Existing ontology/custom-record storage is evidence of reusable machinery, not evidence that the proposed extension contract already works. The largest technical risk is preserving SQL/authorization invariants while removing optional domains; the first slice is designed to expose that risk early.
