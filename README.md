# Siftable

A local, headless service for project context and accountable agent work. Use the CLI or MCP to share notes, assign work, recover interrupted claims, and preserve verification evidence across sessions.

This is a local extraction with a tested core lifecycle and recovery path, not the full former hosted product. Everything runs locally. No Siftable account, browser login, model key or cloud service is required. Nothing in this repository has been published by this extraction.

## Start locally

Prerequisites: Docker Compose and Node.js 22 or newer. Node 22.23.3 is the tested container runtime. Builds need network access to obtain dependencies/images; ordinary operation does not call external services.

```sh
npm ci
npm run build
npm run local
```

The server listens at `http://127.0.0.1:8088`. Bootstrap creates random database passwords and an owner credential in protected, ignored `.local/` files. It never prints them. The database is accessible only on the private Docker network. The server has a second network for loopback port publishing; this Compose configuration is not an outbound firewall.

Start with only the modules you want on a fresh installation:

```sh
npm run local -- context
# or
npm run local -- work
```

A previously installed module is retained when a later invocation selects fewer modules. Use `modules.set` to disable it; omission is never a data deletion command. Modules with dependencies or recorded cross-module references cannot be disabled. No data-deleting module uninstall is provided in this milestone.

Inspect the actual catalog and module state:

```sh
npm run sift -- catalog --config .local/owner.json
npm run sift -- modules.list --config .local/owner.json
npm run sift -- schema.inspect --config .local/owner.json
```

Create a project and work item (use returned IDs for subsequent operations):

```sh
npm run sift -- projects.create --config .local/owner.json --key project-1 \
  --json '{"title":"My project","instructions":"Keep source references and verify the result"}'

npm run sift -- work.create --config .local/owner.json --key work-1 \
  --json '{"title":"Check the local workflow","steps":[{"key":"check","title":"Observe the intended result","required":true}]}'
```

Each mutation requires a stable request key. Retry identical input with the same key after a lost response. Changing the input requires a different key. `--file input.json` can replace `--json` for larger payloads.

## Modules

| Module | Requires | Implemented in this milestone |
|---|---|---|
| foundation | Always installed | Owner/agent credentials, scopes, module ledger, registry, audit, durable idempotency |
| projects | foundation | Create/get/list/update/delete/restore projects and instructions |
| context | foundation | Note CRUD, reversible deletion, revision history, lexical search, immutable context packets with source revisions and omissions |
| work | foundation | CRUD, dependencies and cycle checks, claim/start/heartbeat/release/block/fail/requeue/review/accept/cancel, immutable plans/evidence/artifacts |
| planning | projects | Task CRUD, completion/cancellation, project linkage and acceptance criteria |
| extensions | foundation | Versioned custom schemas, validated record CRUD, reversible deletion, typed relationship CRUD |

Optional associations use foundation entity references. Work requires no project or context tables. Planning explicitly requires Projects. Foundation remains small and does not contain the retired CRM, calendar, billing or execution domains.

Modules own SQL schemas and migration checksums under `modules/`. Startup does not mutate the schema. Local administration applies migrations explicitly. Changes to an applied migration checksum fail closed; append a new numbered migration rather than editing receipts. The runner upgrades existing version-1 installations to version 2 transactionally, verifies each checksum, and preserves disabled module state. `install` upgrades all installed modules as well as adding the requested modules.

Module enablement, tool presentation and credential permissions are separate. Direct HTTP calls receive the same authorization checks as MCP calls. Installing/disabling modules is instance administration; record access is scoped to the credential's owner and personal/named scope.

## Agents, evidence and review

Create an agent credential using the owner ID returned by bootstrap:

```sh
docker compose run --rm admin credential \
  --owner-id OWNER_UUID --role agent \
  --permissions foundation:read,projects:read,context:read,context:write,work:read,work:write \
  --output /run/sift/worker.json --url http://127.0.0.1:8088
```

Use `.local/worker.json` on the host. `work.claim` stores the generated lease secret in the credential directory's protected `leases/` store. Later CLI/MCP mutations use that same custody automatically; secrets do not appear in tool output. The files must be protected from other OS users. These credentials distinguish API authority; they do not sandbox processes running as the same OS user.

The normal sequence is:

```text
work.create -> work.claim -> work.start -> work.evidence -> work.review
                                                           |
                                            owner: work.accept
```

`work.evidence` needs the returned plan version and step ID, an attempt ID, outcome (`passed`, `failed`, `error`), bounded output and provenance. Only an active lease holder may submit. A later failed attempt replaces an earlier passing result for coverage. Revising a plan retains history and starts new coverage. A reviewer can accept only work in review with passing required evidence; acceptance records the operator and plan version.

Evidence is a statement by its submitter. Siftable does not execute submitted commands or turn a worker's report into independent verification. `commands_passed`, `done`, and operator acceptance remain distinct fields.

## Edits, deletion and retries

Project, note, task, custom-object and work edits require the current `revision`; stale edits fail with `revision_conflict`. Task status is human planning state (`open`, `in_progress`, `done`, `cancelled`), independent of executable work acceptance.

`projects.delete`, `notes.delete`, `tasks.delete`, `objects.delete` and `work.delete` require an owner credential, expected revision and reason. They **tombstone** records. Normal get/list/search/reference operations exclude them; `includeDeleted: true` exposes them for inspection. `*.restore` reverses deletion with the expected revision and reason. Incoming active references prevent deletion, and restore requires available outgoing references. Work must be terminal before deletion. Evidence, artifacts, note revisions, context packets and audit/idempotency receipts remain intact. This is not secure erasure or storage reclamation.

```sh
npm run sift -- projects.update --key project-edit-1 \
  --json '{"id":"PROJECT_UUID","revision":1,"title":"Revised project","instructions":"Record the evidence"}'

npm run sift -- notes.list --json '{"limit":30,"offset":0}'
npm run sift -- notes.history --json '{"id":"NOTE_UUID"}'
```

A lease holder can `work.block` or `work.fail` with a reason. Both release the lease. The operator uses `work.requeue` to retry blocked, failed, cancelled or reviewed work. Requeue creates a fresh plan version and fresh step IDs; previous evidence remains visible but cannot satisfy the retry. `work.release` is a handoff within the same plan, preserving evidence. Accepted work is immutable with respect to its plan and cannot be requeued; create follow-up work instead.

`work.update` and `work.dependencies.set` accept only queued/blocked work with the expected revision, and start new verification coverage. Dependency edits reject cycles. `work.plan.revise` retains previous plans and returns nonterminal work to the queue. `work.get` includes dependencies, plan history, evidence, events and artifact metadata.

`work.artifacts.add` requires an active lease and stores a bounded text artifact (up to 64,000 characters), its media type, SHA-256, actor and plan version. `work.artifacts.list` and `work.artifacts.get` retrieve it. Artifacts are immutable and included in backups. Binary/object-store attachments are not implemented. Custom relationship edges can be read/updated/deleted; built-in project/work associations are outside that API. Schema and relationship **definitions** remain immutable contracts.

## MCP

Configure any client supporting MCP over stdio. Use absolute paths:

```json
{
  "mcpServers": {
    "siftable": {
      "command": "node",
      "args": ["/absolute/path/to/siftable/packages/mcp/dist/index.js"],
      "env": {
        "SIFT_CONFIG": "/absolute/path/to/siftable/.local/worker.json",
        "SIFT_TOOLS": "projects,context,work"
      }
    }
  }
}
```

`SIFT_TOOLS` selects module groups for presentation. It cannot grant permissions. Discovery refreshes the server catalog; calls recheck enabled modules and permissions. Mutations require `requestKey`. Tool names replace dots with underscores, such as `work_claim` and `notes_get`. Schemas and tools come from the same operation registry as the API.

The initial transport is stdio MCP connecting to the local HTTP API. HTTP MCP transport and MCP Apps are not included.

## Extend the schema

Define a namespaced object without modifying application code:

```sh
npm run sift -- extensions.define --config .local/owner.json --key paper-schema-1 \
  --file examples/research-paper.json

npm run sift -- objects.create --config .local/owner.json --key paper-1 \
  --json '{"type":"research.paper","version":1,"data":{"title":"A useful source","year":2026}}'
```

The same object operations are available through MCP. Schemas support a bounded JSON Schema subset: objects/properties, required fields, types, enum/const, array items, numeric/string/array bounds and additional-properties rules. Remote references, regex patterns, executable code and SQL are not accepted. Built-in namespaces are reserved even when their modules are absent.

Definitions are immutable and versioned. The initial upgrade path permits adding optional properties while preserving existing constraints. Existing records retain their declared version. Record updates validate the declared schema and expected record revision. They may explicitly move to a newer compatible schema version. Breaking schema migrations and relationship cardinality customization are deferred. Relationships are directed, unique source/type/target edges with many-to-many cardinality and validated endpoint types/existence/scope.

## Validate and operate

```sh
npm test
npm run typecheck
npm run format:check
npm run test:isolated
```

`test:isolated` builds a test image, creates its own randomly named Docker network and disposable database, runs real CLI/server/MCP subprocesses on Node 22, and removes the containers/network. The network has no external route. The integration scenarios cover independent schemas, version-1 upgrades, CRUD/deletion/recovery, claims, evidence, handoff, scope enforcement, extensions, work retries/artifacts, backup integrity and restart. The TAP report is saved under `.local/validation/`.

To test the built image's CLI, MCP and server artifacts:

```sh
docker compose build server
SIFT_TEST_IMAGE=siftable-headless:local npm run test:isolated
```

Stop or resume the local instance without deleting data:

```sh
docker compose stop
docker compose start
```

`.local/` contains credentials and must never be committed or shared. Keep it with the database when moving a private installation. Database recovery is documented below. Portable record interchange/import remains separate future work. Local acceptance is not workload qualification or independent security review.

## Backup and restore

Backups use PostgreSQL 17 `pg_dump` custom archives and an exported transaction snapshot. A private manifest records module versions/checksums, enabled state, archive SHA-256, and row counts/SHA-256 for every owned table. Restore uses `pg_restore` into a **new** database, verifies all table hashes, reapplies restricted runtime grants and invalidates active leases before enabling runtime access. The tools are included in the Docker image. Native CLI users need PostgreSQL 17 client binaries on `PATH`.

```sh
# Run with the local database available. The destination must not already exist.
docker compose run --rm admin backup --output /run/sift/backup-001
docker compose run --rm admin backup-verify --file /run/sift/backup-001

# A fresh database name is mandatory; existing databases are never overwritten.
docker compose run --rm admin restore \
  --file /run/sift/backup-001 --database siftable_recovered
```

The host backup is `.local/backup-001/`. A manifest is written only when the backup completes. The directory is mode 0700 and files are mode 0600. Only restore trusted backups you created: native PostgreSQL archives contain executable schema SQL. Hashes detect accidental corruption, not malicious replacement by someone who controls both archive and manifest. Preserve the matching application image/release with each backup; this version requires exact module schema versions and PostgreSQL major 17. [PostgreSQL dump documentation](https://www.postgresql.org/docs/17/app-pgdump.html) describes snapshots and native archive behavior.

Restore preserves owner/scope/principal IDs, token **hashes**, definitions, records, receipts, evidence, artifacts and deletion state. It does not copy plaintext credentials, lease files, database-role passwords or external files. Keep credential files separately in private storage, or issue new credentials with `credential --owner-id ...` against the recovered database. Old active leases are cleared with a recorded restore event and incremented epoch; use a **new** claim request key after recovery. Old mutation keys still replay their historical receipts.

Restore never switches the running service automatically. To inspect the new database with the existing Compose service, stop the service and change only the database name in its protected URL file, without printing the URL:

```sh
docker compose stop server
node --input-type=module -e 'import {readFile,writeFile} from "node:fs/promises"; const p=".local/runtime-db-url"; const u=new URL((await readFile(p,"utf8")).trim()); u.pathname="/siftable_recovered"; await writeFile(p,u.href,{mode:0o600});'
docker compose up -d --force-recreate server
npm run sift -- modules.list --config .local/owner.json
```

To administer the recovered database later, similarly change the database component of `.local/admin-db-url`. Both old and recovered databases remain present; moving the URL back recovers the previous serving choice. A restore that fails after database creation retains that new database for inspection, with public runtime connection access disabled. No failed restore is reported as successful, and automatic cleanup never drops a database. Backups currently cover only installed Siftable module schemas, not unrelated schemas added manually to the database.

## Development status

The complete proposal is in [the extraction plan](docs/extraction-plan.md). Actual implemented scope, tests, intentional compatibility changes and next dependencies are recorded in [WORK.md](docs/WORK.md). [Provenance](docs/PROVENANCE.md) distinguishes copied source from adapted contracts and new implementation.

This milestone has no code-memory module, collaboration mailbox, managed execution, agent launching, arbitrary plugins, calendar/CRM, or hosted-client compatibility promise. The bounded CRUD/work lifecycle is implemented; repository checkout mapping, richer goals/planning and full former-client parity remain outside this milestone. Repository/package publication and root-license selection are pending; packages remain private.
