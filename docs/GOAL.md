# Proposed end state: a useful, recoverable headless core

Owner: Thomas Main. This is Codex's recommended product target, not authorization to publish or expand the scope. Current authority remains local implementation and verification. The execution record is WORK.md.

A developer or technically comfortable operator should be able to install Siftable locally, select only the domains they need, add a custom schema without forking the server, and connect their existing agent tools. Two independent clients should be able to share attributable context, hand off executable work, inspect evidence, obtain explicit acceptance, and recover the installation without a hosted account or private setup help.

The repeated job is: **“Give my next agent enough trustworthy project context to continue, and preserve what it did and how we checked it.”** Projects, notes, human tasks, executable work, attempts/evidence and acceptance remain different records and lifecycle states. Siftable stores and coordinates them; it does not need to become the agent executor.

## Immediate goal: a local beta that survives ordinary use

The current implementation has reached **checked and used locally** on the extraction’s own delegated-agent pilot. A shareable beta additionally needs a documented install/upgrade/recovery path on a second clean host, an independent review of authorization/recovery/migrations, and actual use on a bounded project. Public release remains separately authorized.

Acceptance journey:

1. Install either context-only or work-only; verify omitted domain tables and tools are absent.
2. Install the combined profile, create project context and planning tasks, and define one custom record type/relationship.
3. Agent A claims work and records a failed attempt. Agent B resumes from durable context/evidence; the owner reviews and accepts only current passing coverage.
4. Exercise edit conflicts, blocked/failed work, retry, deletion/restore and a lost response. History remains inspectable and old success does not satisfy changed work.
5. Stop/restart, upgrade an older database, back up, restore into a fresh database and continue useful work with identical prior records and intentionally invalidated active leases.
6. Repeat the same journey using only the README and packaged artifacts on another host, with no access to the old monorepo.

Steps 1–5 have automated local acceptance coverage. The extraction itself has now completed two actual agent handoffs and a recovery drill; see [the pilot report](pilot/2026-11-16.md). The setup and first-work/restart/recovery portion of step 6 now passes in an isolated clean Linux environment using only committed README-linked source; see [the onboarding report](onboarding/2026-11-16.md). This automated proof is not an independent human or second physical host. Independent human usability and the wider host matrix remain unproven.

## Next steps, in order

1. **First local project: completed.** The extraction pilot used three separately delegated agents for two handoffs and a real recovery drill. It exposed and repaired CLI help, MCP schema defaults and artifact receipt friction. Repeat use remains worth observing; this single run is not outside adoption. Do not migrate production/private source data implicitly.
2. **Close observed gaps and stabilize the contract.** Add generated operation examples/reference, a doctor command, explicit compatibility/version policy and release upgrade instructions. Add repository checkout mapping only if the pilot requires automatic project resolution; use explicit project IDs until then.
3. **Make the local beta independently reproducible.** The earlier automated clean-Linux README gate passed. The scoped credential/migration/recovery review now has three fresh-context approvals and adversarial runtime checks; see [the review report](security-review/2026-11-16.md). An initial repeat run was interrupted by Docker storage failure; after Thomas authorized restarting Docker, the complete clean-environment setup/restart/recovery gate passed and the existing pilot returned healthy. Next, have an independent operator follow the README without live hints, then test a representative dataset and document backup retention expectations. No performance or security certification is implied by functional acceptance.
4. **Prepare, then approve a public release.** Select the root license, check provenance/notices, pin release artifacts and publish only after Thomas explicitly authorizes it. A local repository and passing suite are not a release.
5. **Validate usefulness after release.** Seek two voluntary outside users who finish the journey without private assistance, then observe whether they return for another project/handoff. Installation count is not evidence of recurring value.

Stop widening the schema until the pilot identifies a repeated job the current domains cannot express. Code memory, collaboration mailboxes, richer goals/planning, binary attachments, remote hosting and execution orchestration remain deferred. If two handoffs still require copying the same context manually or opening SQL to recover work, fix that path before adding another domain.

## What “open source” should mean here

A small self-hostable product with readable domain boundaries, stable CLI/API/MCP contracts, user-owned data, supported migrations and recovery, and optional data modules. An external user can extend their records through namespaced schemas while retaining an upgrade path. The goal is independent usefulness and recoverability, with a release boundary that can be reviewed and reproduced.
