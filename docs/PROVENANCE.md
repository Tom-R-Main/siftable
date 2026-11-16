# Source provenance and extraction changes

Upstream: Thomas Main's ExecuFunction/Siftable repository, commit `fb762fd2be4ec62e8ebd8048d75721fbb05ad5c6`. Thomas explicitly authorized reuse of all its code for this extraction on 2026-11-16. This records source authority, not a new public license grant.

Direct extractions:

| New source | Original source | Changes |
|---|---|---|
| `packages/core/src/verificationCoverage.ts` | `exf-app/src/services/agentWorkVerificationCoverage.ts` | Narrow local types/imports, formatting, monotonic evidence sequence tie-breaker for timestamps that collapse to one JavaScript millisecond |
| `packages/core/src/claimDigest.ts` | `exf-app/src/services/agentWorkClaimDigest.ts` | Retained SHA-256 claim-token formula and SQL selector |
| `packages/core/src/secretPolicy.ts` | `packages/shared/src/types/agentWorkSecrets.ts` | Formatting only; same bounded detector and metadata-only findings |

The work lifecycle, evidence ledger, scope isolation, repository proposal and schema design are adapted from the source services and migrations mapped in `extraction-plan.md` and `source-inventory.json`. Most surrounding source in this first slice is new, smaller implementation of those selected contracts; this is not a wholesale move of the old services or proof of full behavior parity.

Intentional differences in this milestone:

- Fresh module-owned PostgreSQL schemas and a new baseline. No old migration chain or production data import.
- Foundation entities/links bridge optional modules without table references into absent domains. A global module-reference ledger conservatively blocks disablement, including references created under another scope. No reference-removal operation yet.
- Immutable versioned verification steps are JSON within a plan, enforced by a PostgreSQL trigger for evidence membership, instead of the old normalized step table. Plans and evidence remain append-only.
- Work dependencies are fixed at creation. Existing predecessors only makes dependency cycles unconstructable through the supported API. Scope-level advisory serialization is deliberately simple and has not been throughput-qualified.
- Scoped agent credentials plus a distinct owner operator; the owner can accept only reviewed work with passing evidence. No browser approval or managed execution request adapter.
- Context packet limits are measured in characters, explicitly labeled. Immutable source revisions/digests and current-source freshness are exposed. Token estimation, automatic retrieval planning and source ingestion remain later work.
- Local lexical search does not import or call embedding providers.
- Extensions support a deliberately bounded declarative JSON Schema subset and additive optional-field upgrades. They do not execute SQL or arbitrary code.
- HTTP operations use `/v1/operations/<name>` and share the registry with CLI/MCP. No compatibility claim for all legacy REST paths or published clients.

The copied plan and inventory describe the larger intended extraction. `WORK.md` is the authority for what this implementation actually reached. Source hashes for the direct extractions are recorded in `extracted-sources.json`.
