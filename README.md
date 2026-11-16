# Siftable

A local, headless service for project context and accountable agent work. Use the CLI or MCP to share notes, assign work, recover interrupted claims, and preserve verification evidence across sessions.

This is the first extraction milestone, not the full former hosted product. Everything runs locally. No Siftable account, browser login, model key or cloud service is required. Nothing in this repository has been published by this extraction.

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
| projects | foundation | Create/get/list projects and instructions |
| context | foundation | Markdown notes, version-checked updates, lexical search, immutable context packets with source revisions and omissions |
| work | foundation | Create/get/list, dependencies at creation, claim/start/heartbeat/release/review/accept/cancel, versioned evidence plans and submissions |
| planning | projects | Create/get human planning tasks with project linkage and acceptance criteria |
| extensions | foundation | Versioned custom schemas, validated records, generic create/get/list, typed relationships |

Optional associations use foundation entity references. Work requires no project or context tables. Planning explicitly requires Projects. Foundation remains small and does not contain the retired CRM, calendar, billing or execution domains.

Modules own SQL schemas and migration checksums under `modules/`. Startup does not mutate the schema. Local administration applies migrations explicitly. Changes to an applied migration checksum fail closed; create a new upgrade design rather than editing receipts. The current runner supports baseline version 1, not automatic version-2 SQL upgrades.

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

Definitions are immutable and versioned. The initial upgrade path permits adding optional properties while preserving existing constraints. Existing records retain their declared version. Record mutation, breaking schema migrations and relationship cardinality customization are deferred. Relationships are directed, unique source/type/target edges with many-to-many cardinality and validated endpoint types/existence/scope.

## Validate and operate

```sh
npm test
npm run typecheck
npm run format:check
npm run test:isolated
```

`test:isolated` creates its own randomly named Docker network and disposable database, runs real CLI/server/MCP subprocesses on Node 22, and removes the containers/network. The network has no external route. Nine integration scenarios cover independent schemas, claims, evidence, handoff, scope enforcement, extensions, disabling and restart. The TAP report is saved under `.local/validation/`.

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

`.local/` contains credentials and must never be committed or shared. Keep it with the database when moving a private installation. Database backup/restore tooling and portable record export remain pending; do not entrust irreplaceable data to this first milestone.

## Development status

The complete proposal is in [the extraction plan](docs/extraction-plan.md). Actual implemented scope, tests, intentional compatibility changes and next dependencies are recorded in [WORK.md](docs/WORK.md). [Provenance](docs/PROVENANCE.md) distinguishes copied source from adapted contracts and new implementation.

This milestone has no code-memory module, collaboration mailbox, managed execution, agent launching, arbitrary plugins, calendar/CRM, or hosted-client compatibility promise. It also does not yet implement the complete CRUD/lifecycle surface from the plan. Repository/package publication and root-license selection are pending; packages remain private.
