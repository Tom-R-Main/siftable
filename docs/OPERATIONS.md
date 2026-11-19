# Operations and Contracts

Operational details, lifecycle contracts, and troubleshooting for a local Siftable installation. For initial setup and the quickstart, see [the root README](../README.md). For PostgreSQL 17 backup, restore, and quarantine recovery, see [Backup and recovery](./BACKUP_AND_RECOVERY.md).

## Topology and port customization

Compose runs under the fixed project name `siftable-headless` (defined in [compose.yaml](../compose.yaml)). Run one installation per Docker daemon; a second checkout on the same daemon shares that Compose project and is not an isolated installation.

- **`db` (`pgvector/pgvector:pg17`)**: Attached only to the `private` (`internal: true`) Docker network. It is not exposed on the host.
- **`server`**: Built from the local repository, listens on `127.0.0.1:${SIFT_PORT:-8088}` (mapped to container port `8080`), and connects to both `private` and `local`. This Compose setup is not an outbound firewall.
- **`admin` (`profiles: [tools]`)**: Runs CLI administration commands on the `private` network with `./.local` mounted at `/run/sift`, executing as the owner of `/run/sift` via [scripts/admin.sh](../scripts/admin.sh) so created credentials and backups stay readable by the host user with private permissions.

To change the listening port, export `SIFT_PORT` **before the first setup**, and keep that value exported in shells running Compose, credential creation, and examples:

```sh
export SIFT_PORT=18088
```

Changing `SIFT_PORT` later does not rewrite URLs already stored inside existing `.local/*.json` credential files.

Stop or resume the local instance without deleting database volumes or `.local/` state:

```sh
docker compose stop
docker compose start
```

After starting the service or switching databases, wait for `/health` to return HTTP 200 before sending API requests (or rerun `npm run local` for its built-in readiness loop):

```sh
node -e 'fetch(`http://127.0.0.1:${process.env.SIFT_PORT || 8088}/health`).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'
```

A healthy `/health` response proves the HTTP server is listening, not that the full workflow is working. Run `npm run example:first-work` (see [scripts/first-work.mjs](../scripts/first-work.mjs)) for an end-to-end CLI and stdio MCP check.

## Modules, migrations, and state locks

Install a subset of modules on a fresh checkout by passing module names to `npm run local`:

```sh
npm run local -- context
# or
npm run local -- work
```

`foundation` is always installed. The default installation installs `projects,context,work,planning,extensions`. Minimal `context`-only or `work`-only setups intentionally omit other modules and cannot run `npm run example:first-work`, which requires `projects,context,work`. Check active operations with `catalog`.

Key module and schema rules:

- **Omission does not delete**: When a later `npm run local` invocation selects fewer modules, previously installed modules remain installed.
- **Disabling modules**: Use the owner-only `modules.set` operation to disable a module. Modules with active dependents or recorded cross-module references cannot be disabled. No data-deleting module uninstall is provided in this milestone.
- **Dependencies**: `work` requires no `projects` or `context` tables; optional associations use `foundation` entity references. `planning` explicitly requires `projects`. `foundation` remains small and excludes retired CRM, calendar, billing, or execution domains.
- **Checksummed SQL migrations**: Modules own their SQL schemas and migration checksums under [modules/](../modules/) (`001.sql`, `002.sql`, and `manifest.json`). Server startup never mutates the schema; local administration (`admin init` or `admin install`) applies migrations explicitly.
- **Fail-closed checksums**: Modifying an applied migration's SQL checksum fails closed. Append a new numbered migration rather than editing applied files or receipts. The runner upgrades existing version-1 installations to version 2 transactionally, verifies each checksum, and preserves disabled module state. `install` upgrades all installed modules in addition to adding any requested modules.
- **Shared state lock**: Installation and `modules.set` toggles share a state lock. Installing an enabled dependent such as `planning` fails atomically if its prerequisite (`projects`) is disabled; re-enable `projects` first, because installation does not silently re-enable disabled prerequisites.
- **Authorization separation**: Module enablement, MCP tool presentation (`SIFT_TOOLS`), and credential permissions are enforced independently. Direct HTTP calls receive the same authorization checks as stdio MCP calls. Installing or disabling modules is instance administration; record access is scoped to the credential's owner and personal/named scope.

Inspect the live catalog, module state, schemas, and local credential metadata with:

```sh
npm run sift -- catalog --config .local/owner.json
npm run sift -- modules.list --config .local/owner.json
npm run sift -- schema.inspect --config .local/owner.json
npm run sift -- config.info --config .local/owner.json
```

Inspect operation input contracts offline from the bundled registry (no credentials or running server needed):

```sh
npm run sift -- work.claim --help
npm run sift -- work.artifacts.add --help
```

Local `--help` documents caller JSON input, required fields, server defaults/limits, and the stable `--key` (`requestKey`) requirement. It describes supported syntax, not whether your current server has a module enabled or grants your credential permission; run `catalog` with a credential to check live permissions.

## Credentials, leases, and review custody

### Creating scoped agent credentials

Read `ownerId` from local identity metadata via `config.info` (which prints only identity IDs without displaying secrets or contacting the server), then issue a scoped agent credential under `.local/`:

```sh
OWNER_ID=$(node packages/cli/dist/index.js config.info --config .local/owner.json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).ownerId')

docker compose run --rm admin credential \
  --owner-id "$OWNER_ID" --role agent \
  --permissions foundation:read,projects:read,context:read,context:write,work:read,work:write \
  --output /run/sift/worker.json --url "http://127.0.0.1:${SIFT_PORT:-8088}"
```

Keep `.local/` private (`0700` directory, `0600` files) and never share credential files or paste their contents into a terminal. Credentials separate API authority (`owner` vs `agent`); they do not sandbox processes running as the same OS user.

### Attempt-scoped lease custody and `work.lease`

`work.claim` stores the generated lease secret in a protected `leases/` store inside the credential file's directory. Subsequent CLI and stdio MCP mutations read that custody automatically; lease secrets never appear in tool output.

- **Share custody intentionally**: Use the same credential file path (such as `.local/worker.json`) in both CLI and MCP when continuing the same claim so both processes locate the same `leases/` store. Keep your long-lived `.local/worker.json` separate from the temporary, revoked credential created by `npm run example:first-work`.
- **Per-attempt bindings and `work.lease`**: Claim secrets are stored separately per attempt. Before a new lease-bearing mutation, the client calls `work.lease` to resolve its active claim identifier and epoch, then writes a private binding keyed by that mutation's request key.
- **Retry and epoch safety**: Retrying a failed or timed-out request with the same request key reuses the original binding even after release or expiry. An old claim response cannot overwrite a newer claim, and recovery can safely reuse or lower epochs.
- **`work.lease` limits**: `work.lease` requires `work:write`, returns metadata only for the caller's own active lease, and returns no work content or lease secret. Even an `owner` cannot resolve another principal's lease via `work.lease`.
- **Upgrade lockstep**: Keep CLI/MCP clients and the server on the same build when upgrading because this client requires `work.lease`. Existing private lease files remain readable for active claims and historical retries.

### Work lifecycle, evidence, and non-self-acceptance

The core execution flow separates worker execution from owner acceptance:

```text
work.create -> work.claim -> work.start -> work.evidence -> work.review
                                                           |
                                            owner: work.accept
```

- **Non-self-acceptance**: `work.accept` is an operator-only transition (`operator: true`). Credentials with role `agent` cannot accept their own work through either the CLI or MCP.
- **Evidence submission**: `work.evidence` requires an active lease holder, the current plan version and step ID, an attempt ID, an outcome (`passed`, `failed`, or `error`), bounded output, and provenance. A later failed attempt replaces an earlier passing result for step coverage. Revising a plan retains prior evidence for history and starts fresh coverage.
- **Acceptance gate**: A reviewer can accept work only when it is in `needs_review` with passing required evidence. Acceptance records the operator identity and plan version.
- **Submitter-asserted boundary**: `work.evidence` records a statement by its submitter. Siftable does not run submitted commands or convert a worker's report into independent verification. `commands_passed`, `done`, and operator acceptance remain distinct fields.

## Edits, deletion, retries, and artifacts

### Idempotency and optimistic revisions

Every mutation requires a stable request key (`--key` on the CLI, `requestKey` in MCP). Retry an identical payload with the same key after a lost response; changing the input requires a new key. Pass `--file input.json` instead of `--json` for larger payloads.

Edits to projects, notes, tasks, custom objects, and work items require the current `revision`. Stale revisions fail with `revision_conflict` (HTTP 409). Task status (`open`, `in_progress`, `done`, `cancelled`) represents human planning state and is independent of executable work acceptance.

```sh
npm run sift -- projects.update --key project-edit-1 \
  --json '{"id":"PROJECT_UUID","revision":1,"title":"Revised project","instructions":"Record the evidence"}'

npm run sift -- notes.list --json '{"limit":30,"offset":0}'
npm run sift -- notes.history --json '{"id":"NOTE_UUID"}'
```

### Reversible tombstone deletion

`projects.delete`, `notes.delete`, `tasks.delete`, `objects.delete`, and `work.delete` require an `owner` credential, the expected `revision`, and a `reason`. Deletion tombstones the record rather than erasing storage:

- Standard get, list, search, and reference operations exclude tombstoned records; pass `includeDeleted: true` to inspect them.
- `*.restore` reverses deletion when given the expected `revision` and `reason`.
- Incoming active references block deletion; restore requires all outgoing references to be available (not deleted).
- Work items must be in a terminal state before deletion.
- Evidence, artifacts, note revisions, context packets, and audit/idempotency receipts remain intact. Tombstoning is not secure erasure or storage reclamation.

### Retries, handoffs, dependencies, and `work.fork`

- **`work.block` / `work.fail`**: Called by the active lease holder with a reason; both release the lease.
- **`work.release`**: Hands off work within the same plan version while preserving submitted evidence.
- **`work.requeue`**: Operator action for `blocked`, `failed`, `cancelled`, or `needs_review` work. Requeue allocates a fresh plan version and fresh step IDs; earlier evidence remains visible in history but cannot satisfy the new plan version. Accepted work is immutable with respect to its plan and cannot be requeued; create follow-up work instead.
- **`work.update` and `work.dependencies.set`**: Require `queued` or `blocked` work with the expected `revision`, and reset verification coverage for the item. Dependency updates reject cycles.
- **`work.plan.revise`**: Retains previous plan versions and returns nonterminal work to `queued`.
- **`work.fork`**: Requires `queued` or `blocked` work with the expected `revision` and a `reason`. Atomically creates 1–25 child branch items (inheriting `belongs_to` project links if present, defaulting each branch to a required `complete` step when `steps` is omitted), wires them as predecessors on the parent with `gate` (`done` by default, or `commands_passed`), bumps the parent's `plan_version` under `reason`, increments `revision`, and returns the parent to `queued`.
- **`work.get`**: Returns dependencies, plan history, evidence, events, and artifact metadata.

### Bounded immutable text artifacts

`work.artifacts.add` requires an active lease and stores a bounded UTF-8 text artifact (up to `64000` characters), its media type, SHA-256 digest, actor, and plan version:

- Creation receipts include `artifactId` alongside the work `id` so callers can fetch immediately with `work.artifacts.get` without listing first.
- Retrying with the same request key returns the original receipt and `artifactId`.
- `work.artifacts.list` returns artifact metadata; historical receipts are unchanged.
- Artifacts are immutable and included in backups. Binary and object-store attachments are not implemented.

## Custom schemas and relationships

Define versioned custom object types without modifying server code (example schema in [examples/research-paper.json](../examples/research-paper.json)):

```sh
npm run sift -- extensions.define --config .local/owner.json --key paper-schema-1 \
  --file examples/research-paper.json

npm run sift -- objects.create --config .local/owner.json --key paper-1 \
  --json '{"type":"research.paper","version":1,"data":{"title":"A useful source","year":2026}}'
```

Schema and relationship rules:

- **Bounded JSON Schema subset**: Supports objects and `properties`, `required`, primitive/structural `type`, `enum` and `const`, array `items`, numeric/string/array bounds, and `additionalProperties` rules. Remote `$ref` references, regex `pattern`s, executable code, and SQL are rejected.
- **Reserved namespaces**: Built-in module namespaces (`foundation`, `projects`, `context`, `work`, `planning`, `extensions`) are reserved even when those modules are absent.
- **Immutable versioned definitions**: `extensions.define` and `relations.define` are owner-only and produce immutable, versioned contracts. The supported upgrade path permits adding optional properties while preserving existing constraints; breaking schema migrations are deferred.
- **Record versioning**: Existing `objects` records retain their declared `version`. `objects.update` validates against the declared schema and expected `revision`, and may explicitly advance a record to a newer compatible schema version.
- **Typed relationships**: `relations.create`, `get`, `list`, `update`, and `delete` manage directed, unique `(source, type, target)` edges with many-to-many cardinality and validated endpoint types, existence, and scope. Relationship cardinality customization is deferred, and built-in project/work links stay outside the custom relationship API.

## Validation harnesses and troubleshooting

### Test suites

```sh
npm test
npm run typecheck
npm run format:check
npm run test:isolated
```

- **`npm run test:isolated`** ([scripts/acceptance.mjs](../scripts/acceptance.mjs)): Builds a test image (or uses `SIFT_TEST_IMAGE` when set), creates a randomly named `--internal` Docker network (no external route) and disposable `pgvector/pgvector:pg17` database, runs [tests/acceptance/headless.test.mjs](../tests/acceptance/headless.test.mjs) with real CLI, HTTP server, and stdio MCP subprocesses on Node 22, removes the temporary containers and network, and saves the TAP report to `.local/validation/headless.tap`. Scenarios cover independent module schemas, version-1 upgrades, CRUD/tombstones/recovery, claims, evidence, handoffs, scope enforcement, extensions, work retries/artifacts, backup integrity, and restarts.
- **Testing the Compose-built image**:
  ```sh
  docker compose build server
  SIFT_TEST_IMAGE=siftable-headless:local npm run test:isolated
  ```
- **`npm run test:readme`** ([scripts/readme-check.mjs](../scripts/readme-check.mjs)): Packages **committed `HEAD`** via `git archive` (uncommitted edits are excluded) into a clean Linux container (`node:22.23.3-alpine` + `docker:29.9.3-dind`, non-root UID `10001`, empty Docker/npm/DB/config state) and executes [scripts/cleanroom/verify.mjs](../scripts/cleanroom/verify.mjs). It tests setup, `example:first-work`, `docker compose stop`/`start`, and backup/restore with real assertions. It requires network downloads and a Docker host that allows `--privileged` Docker-in-Docker containers (privileged containers are a test harness, not a security sandbox; no host Docker socket, host home mounts, or host ports are attached). The runner removes its disposable container, volumes, and harness image, preserves non-secret `run.log`, `source.json`, and `receipt.json` under `.local/readme-*/`, and leaves existing Compose services untouched. This proves clean-Linux automated execution on committed `HEAD`, not unaided human usability or every host platform.

### Troubleshooting `.local/` and `EACCES`

- **Keep errors and `.local/` intact**: If setup fails, keep the error output and rerun after fixing the cause. Never delete `.local/` or run `docker compose down -v` as troubleshooting—credentials, lease bindings, and database state belong together.
- **Common checks**: Verify Docker access with `docker info`, port conflicts with `docker compose ps`, and active modules with `modules.list`.
- **Root-owned `.local/` files (`EACCES`)**: A CLI `EACCES` error on an installation originally created with an earlier build usually indicates root-owned files under `.local/`. Inspect ownership without exposing file contents:
  ```sh
  ls -ld .local .local/owner.json
  ```
  Correct ownership to your host user locally without loosening file permissions (keep `.local/` at `0700` and files at `0600`). Never commit, share, or print `.local/` contents.
- **Moving a private installation**: Keep `.local/` together with the database volume or backup; portable record interchange/import remains separate future work. Local acceptance checks are not workload qualification or an independent security review.
