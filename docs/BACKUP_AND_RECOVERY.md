# Backup and Recovery

Procedures, security boundaries, and failure recovery for PostgreSQL 17 backups on a local Siftable installation.

## Backup, verify, and restore commands

Run these commands with the local `db` container healthy. `restore` requires a **fresh** target database name and never overwrites an existing database:

```sh
docker compose run --rm admin backup --output /run/sift/backup-001
docker compose run --rm admin backup-verify --file /run/sift/backup-001
docker compose run --rm admin restore \
  --file /run/sift/backup-001 --database siftable_recovered
```

On the host, `/run/sift/backup-001` resolves to `.local/backup-001/`, created with directory mode `0700` and file modes `0600`.

## Archive format, manifests, and threat model

- **PostgreSQL 17 native archives**: `backup` uses PostgreSQL 17 `pg_dump` custom archives with an exported transaction snapshot, and `restore` runs `pg_restore` into a new database. Both tools are bundled in the Docker image. Native CLI users running outside Compose need PostgreSQL 17 client binaries on `PATH` and a PostgreSQL superuser for restore; the serving role (`sift_runtime`) remains restricted.
- **Manifest integrity**: A private manifest is written only after the backup completes. It records installed module versions and SQL checksums, enabled state, archive SHA-256, and per-table row counts and SHA-256 digests for every owned table. `backup-verify` and `restore` check those digests before completing.
- **Scope limit**: Backups cover only installed Siftable module schemas, not unrelated schemas added manually to PostgreSQL.
- **Trust boundary**: Only restore trusted backups you created. Native PostgreSQL custom archives contain executable schema SQL. Manifest and table SHA-256 digests detect accidental corruption, not malicious replacement by an attacker who controls both the archive and the manifest.
- **Version coupling**: Preserve the matching Siftable application image or release alongside each backup. This release requires PostgreSQL major version 17 and exact module schema versions. See the [PostgreSQL 17 pg_dump documentation](https://www.postgresql.org/docs/17/app-pgdump.html) for snapshot and custom-archive mechanics.

## Snapshot state, credentials, and revocation replay

`restore` preserves owner/scope/principal IDs, token **hashes**, custom schema and relation definitions, records, idempotency receipts, evidence, text artifacts, and tombstone deletion state.

It does **not** copy plaintext credential JSON files, local `leases/` custody files, database-role passwords, or external files.

Before serving traffic from a recovered database, complete this checklist:

1. **Restore or re-issue credentials**: Keep original `.local/*.json` files in private storage, or issue fresh credentials against the recovered database using `docker compose run --rm admin credential --owner-id ...`.
2. **Replay post-backup revocations**: Credential revocations are restored to their snapshot state at the time of the backup. Reapply any credential revocations made after the backup was taken, or replace and revoke affected credentials against the recovered database. Recovery does not infer later security decisions from the original database.
3. **Expect cleared leases and new request keys**: Restore invalidates all old active leases, records a restore event, and increments lease epochs before enabling runtime access. Start new claims with a **new** `--key` (`requestKey`) after recovery. Server receipts remain immutable.
4. **Respect endpoint lease isolation**: Client retries of lease-bearing operations require their private `leases/` custody at the same API URL. If you stand up the recovered database on a different URL or port, claim afresh with new keys; local lease bindings are isolated by endpoint and are not relocated automatically. Switching the local Compose service database (below) preserves the existing API URL.

## Switching the running Compose service to a recovered database

`restore` never switches the running `server` automatically. To inspect or serve the recovered database with the existing Compose service, stop `server`, update only the database pathname in `.local/runtime-db-url` without printing its contents, recreate `server`, wait for `/health`, and verify module state:

```sh
docker compose stop server
node --input-type=module -e 'import {readFile,writeFile} from "node:fs/promises"; const p=".local/runtime-db-url"; const u=new URL((await readFile(p,"utf8")).trim()); u.pathname="/siftable_recovered"; await writeFile(p,u.href,{mode:0o600});'
docker compose up -d --force-recreate server
node -e 'fetch(`http://127.0.0.1:${process.env.SIFT_PORT || 8088}/health`).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'
npm run sift -- modules.list --config .local/owner.json
```

To run `admin` commands against the recovered database later, apply the same pathname update to `.local/admin-db-url` (preserving mode `0600`). Both the original (`siftable`) and recovered (`siftable_recovered`) databases remain in Postgres; updating the URL pathnames back restores the previous serving target.

## Quarantine and `access state unknown` recovery

Restore protects partially recovered databases from premature runtime traffic:

- **Zero-connection start**: `restore` creates the target database with an ordinary-connection limit of `0` (`sift_runtime` cannot connect), while the trusted superuser (`postgres` via `.local/admin-db-url`) can still inspect and populate it.
- **Commit gate**: Only after `pg_restore`, table hash verification, restricted runtime grant reapplication, and active-lease invalidation all succeed does `restore` lift the connection limit and enable runtime access.
- **Quarantine on recoverable failure**: If a step fails after creating the target database, `restore` re-applies the zero ordinary-connection limit, terminates any ordinary sessions on the new target, and verifies the lock before reporting quarantine. No failed restore is ever reported as successful, and automatic cleanup never drops a database.
- **Uncertain outcomes (`access state unknown`)**: If a connection failure prevents `restore` from verifying session termination or the connection limit, it reports **`access state unknown`**. An uncertain database-creation response identifies the target database name for manual inspection without modifying a potentially competing database.

When a restore fails with quarantine or `access state unknown`:

1. **Leave the live service untouched**: Do not modify `.local/runtime-db-url` or `.local/admin-db-url` while investigating; keep the original database as the serving target.
2. **Inspect as the superuser**: Connect to `db` with the trusted superuser (`postgres`) to inspect whether the target database exists, check its connection limit (`pg_database.datconnlimit`) and active ordinary sessions (`pg_stat_activity`), and terminate any stray sessions if needed.
3. **Clean up manually and retry**: Once you confirm the failed target database is safe to remove, drop or rename it manually as the superuser, or choose a fresh `--database` name for the next `restore` attempt.
