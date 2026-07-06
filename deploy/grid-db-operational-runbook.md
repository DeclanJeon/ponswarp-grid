# grid.ponslink.com Database Migration and Operational Drill Runbook

## Scope

This runbook covers the `grid.ponslink.com` mesh coordinator Postgres namespace. It must not reuse or mutate the existing `warp.ponslink.com` legacy signaling database/schema.

## Required namespace

```text
database: ponswarp_grid_prod
schema: grid
application role: ponswarp_grid_app
migration owner role: ponswarp_grid_migrator
```

The application role should have DML privileges only on the grid schema. Migration ownership remains separate.

## Required migration objects

The current foundation migration is:

```text
/home/declan/Documents/Develop/Project/ponswarp/ponswarp-signaling-rs/migrations/202607040001_mesh_repository_foundation.sql
```

Required tables:

```text
mesh_workspaces
mesh_workspace_members
mesh_nodes
mesh_node_tokens
mesh_presence
mesh_files
mesh_availability
mesh_shares
mesh_events
mesh_rate_limits
```

Required cleanup indexes:

```text
idx_mesh_presence_fresh
idx_mesh_shares_active
idx_mesh_rate_limits_expires
```

## Pre-deploy migration procedure

```text
1. Confirm current migration version.
2. Create pg_dump or provider snapshot.
3. Restore snapshot to staging clone.
4. Apply migrations on staging clone.
5. Run mesh-postgres drill against staging clone.
6. Record migration runtime and lock observations.
7. Apply production migration only after staging clone passes.
8. Verify /readyz migration and rateLimitStore checks.
```

## Backup / restore drill

Minimum private-beta drill:

```text
pg_dump --format=custom --schema=grid --file=/var/backups/ponswarp-grid/grid-<timestamp>.dump <db>
createdb ponswarp_grid_restore_check
pg_restore --dbname=ponswarp_grid_restore_check /var/backups/ponswarp-grid/grid-<timestamp>.dump
run mesh-postgres-drill against restored DB
```

## Readiness requirements

`/readyz` must report `not_ready` and HTTP 503 when any required operational dependency is degraded:

```json
{
  "checks": {
    "db": "ok|degraded",
    "migrations": "ok|degraded",
    "rateLimitStore": "ok|degraded",
    "cleanupScheduler": "ok|degraded|disabled"
  }
}
```

`/healthz` must remain a process-liveness check and must not fail only because DB is down.

## Cleanup / retention checks

| Object | Cleanup expectation |
|---|---|
| `mesh_presence` | stale rows excluded from candidates and deleted/expired by cleanup |
| `mesh_shares` | expired/revoked shares deny resolve/candidates/connect |
| `mesh_rate_limits` | expired buckets are deleted |
| `mesh_events` | retained according to beta retention policy |

## Rollback principles

- Prefer application rollback over destructive DB rollback.
- Migrations must be forward-compatible for at least one app version.
- Do not drop columns/tables in beta migrations.
- If migration fails, keep `grid.ponslink.com` upstream disabled and verify `warp.ponslink.com` remains healthy.
