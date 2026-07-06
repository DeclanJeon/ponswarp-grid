# grid.ponslink.com Operations Incident Runbook

Scope: incidents affecting `https://grid.ponslink.com`, its coordinator API, Grid database/schema, TURN/ICE path, rate limits, tokens, abuse controls, and grid-only rollback. The legacy `https://warp.ponslink.com` service must remain isolated and verified during every incident.

Use request ids and hashes in incident notes. Do not paste raw node tokens, TURN credentials, full share codes, private file paths, database URLs, or secret env values.

## Common first checks

- `GET https://grid.ponslink.com/healthz`: process/static edge liveness.
- `GET https://grid.ponslink.com/readyz`: DB, migration, rate-limit store, cleanup scheduler, optional TURN credential issuer readiness.
- `GET https://grid.ponslink.com/api/grid/v1/ice`: ICE/TURN config availability.
- Metrics: API error rate, `api_latency_ms`, `db_query_latency_ms`, `active_nodes`, `share_resolved_total`, `candidate_requests_total`, `connect_grants_total`, `rate_limit_hits_total`, `auth_denied_total`, `turn_ice_failures_total`, `quota_denied_total`.
- Logs/audit: request id, action, decision, reason code, node/share hashes.

## Grid coordinator down

Detection:

- `healthz` fails or reverse proxy returns 502/503 for `grid.ponslink.com`.
- API error rate spikes; active nodes drop as heartbeats fail.
- Web UI loads but share/receive operations cannot call `/api/grid/v1/*`.

Immediate mitigation:

1. Confirm failure is limited to grid routes, not `warp.ponslink.com`.
2. Restart the `ponswarp-grid-coordinator` process if the last deploy/config is known good.
3. If restart loops or causes high error rates, disable only the grid upstream or roll back the grid service release.
4. Keep existing transfer expectations conservative: already connected P2P transfers may continue, but new resolve/candidate/connect will fail.

Verification:

- `healthz` returns 200.
- `readyz` returns ready with expected version/checks.
- A smoke share resolve/candidate/connect path works on grid.
- `warp.ponslink.com` health and WebSocket signaling remain normal.

User comms criteria:

- Post/update status if grid share creation or receiving is unavailable for more than a short transient window, or if rollback disables new Grid sessions.
- State that original file contents are not stored by the coordinator.

## DB down or migration mismatch

Detection:

- `healthz` may be 200, but `readyz` fails DB, migrations, rate-limit store, or cleanup checks.
- Elevated `db_query_latency_ms`, 5xx on share/node/file routes, migration mismatch in logs.
- New shares, heartbeats, cleanup, or rate limits fail.

Immediate mitigation:

1. Stop rollout; do not apply more migrations.
2. Put grid into maintenance or disable write routes if partial writes are occurring.
3. Restore DB connectivity, credentials, or permissions for the grid database/schema only.
4. For migration mismatch, prefer app rollback to a forward-compatible version over destructive DB downgrade.
5. Use the most recent pre-migration snapshot/backup only after confirming data-loss impact and grid-only scope.

Verification:

- `readyz` reports DB and migration checks `ok`.
- Heartbeat, share create/resolve, candidates, connect, revoke, and cleanup smoke succeed.
- No queries point at the legacy `warp.ponslink.com` database/schema.
- `warp.ponslink.com` health/readiness remain unaffected.

User comms criteria:

- Notify if users cannot create/receive Grid shares or if published shares may need recreation.
- Do not disclose schema details, credentials, or raw identifiers.

## TURN down or ICE credential failure

Detection:

- `/api/grid/v1/ice` fails, omits TURN servers, or returns expired/invalid credentials.
- `turn_ice_failures_total` spikes; NAT/mobile transfers fail while same-LAN transfers still work.
- Browser/client errors mention ICE failure, relay allocation failure, or timeout.

Immediate mitigation:

1. Confirm STUN/TURN service health and credential issuer secret/config.
2. Restart or fail over TURN service if available.
3. Temporarily communicate LAN/direct-only limitation if relay is unavailable.
4. Tighten relay quotas if outage is caused by overload/abuse rather than service failure.

Verification:

- `/api/grid/v1/ice` returns STUN/TURN config with sane `ttlSeconds` and no raw secret leakage.
- LAN direct transfer still works.
- NAT/mobile or relay-only diagnostic succeeds, or failure is clearly classified.
- TURN credentials are redacted in logs and client errors.

User comms criteria:

- Notify when cross-network/mobile transfers are degraded and recommend CLI retry/resume or same-network transfer.
- Announce recovery after relay tests pass.

## Rate-limit false positive

Detection:

- Legitimate user reports 429/deny on normal share resolve/candidates/connect.
- `rate_limit_hits_total` or `quota_denied_total` spikes after config change.
- Audit reason codes show limit hits for low-volume users/workspaces.

Immediate mitigation:

1. Identify the affected route group, IP hash, share code hash, workspace, and time window.
2. Clear or raise only the affected bucket/config; avoid disabling all limits globally.
3. If a release changed defaults, roll back the grid rate-limit config only.
4. Preserve audit evidence for tuning.

Verification:

- Affected user flow succeeds without bypassing token/share expiry checks.
- Abuse test still receives 429 after the intended threshold.
- Metrics return to expected baseline.

User comms criteria:

- Reply directly to affected users after access is restored.
- Public notice only if broad legitimate traffic was blocked.

## Token leak suspected

Detection:

- Raw token appears in logs, support ticket, screenshot, shell history, or client error.
- `auth_denied_total` rises for a node/workspace; audit shows unusual node actions.
- User reports accidental public posting of node token or share code.

Immediate mitigation:

1. Revoke the affected node token/share immediately.
2. Rotate related signing secret/pepper only if exposure scope indicates server-side compromise.
3. Redact leaked token/code from tickets, logs exports, chat, and incident docs.
4. Search only approved log stores for the raw value, then store incident references as hashes.
5. Issue replacement token/share through the normal owner/admin boundary.

Verification:

- Revoked token/share denies heartbeat, publish, candidates, and connect as applicable.
- New token/share works for the owner.
- Audit records show revoke and subsequent deny decisions without raw secret values.
- No raw token/TURN credential/full code remains in shared incident materials.

User comms criteria:

- Notify affected owner with rotation/re-share instructions.
- Public notice only if shared infrastructure secret or broad user exposure is confirmed.

## Abuse spike

Detection:

- Spikes in resolve/candidates/connect, `rate_limit_hits_total`, `quota_denied_total`, TURN sessions/estimated bytes, or auth denials.
- Large candidate response sizes, many active shares per node, or repeated invalid share guesses.
- Reports of malicious/publicly posted share links.

Immediate mitigation:

1. Raise protection on affected route groups: resolve, candidates, connect, create_share, register_node.
2. Revoke abusive shares/nodes/workspaces after policy review.
3. Lower candidate response caps or relay-only session duration if TURN cost is at risk.
4. Block/deny by IP hash/share hash/workspace where supported.
5. Preserve audit and metrics evidence under incident hold.

Verification:

- Abuse traffic receives 429/403/404 as appropriate.
- Legitimate smoke share still works within quota.
- TURN relay metrics and DB/API latency return to safe levels.
- No raw codes/tokens are exposed in abuse reports.

User comms criteria:

- Notify affected users if their shares/nodes are revoked or delayed.
- Public notice if broad availability or relay quality is degraded.

## Rollback grid.ponslink.com only

Detection/triggers:

- Grid deploy causes persistent 5xx, bad migration compatibility, token/credential leak risk, unbounded relay cost, or severe abuse that cannot be mitigated live.
- Any sign that grid changes affect `warp.ponslink.com` is an immediate No-Go and rollback trigger.

Immediate mitigation:

1. Disable only the `grid.ponslink.com` upstream in reverse proxy, or stop `ponswarp-grid-coordinator`.
2. Revert grid web static assets to the last known good build if UI-only regression.
3. Revert grid coordinator binary/config to the last known good release if API/runtime regression.
4. Do not alter legacy `warp.ponslink.com` routes, `/ws`, auth, billing, or cloud config.
5. Prefer app/config rollback plus forward-compatible DB schema over destructive DB rollback.

Verification:

- `https://grid.ponslink.com/healthz` shows expected maintenance/down state or recovered old version.
- New Grid requests are stopped or served by the rolled-back version.
- `https://warp.ponslink.com/health` and legacy WebSocket smoke pass.
- Reverse proxy config contains separate grid and warp routes.

User comms criteria:

- Announce Grid beta rollback/maintenance when new shares or receives are unavailable.
- State whether users should recreate shares after recovery.

## Verify warp.ponslink.com unaffected

Run during every Grid incident, mitigation, and recovery.

Detection:

- Check `https://warp.ponslink.com/health` and legacy signaling/WebSocket behavior.
- Watch legacy error rate, auth, billing/cloud, and `/ws` logs for correlated changes.
- Confirm no grid proxy route catches `warp.ponslink.com/*`.

Immediate mitigation if affected:

1. Treat as severity escalation.
2. Revert the last reverse proxy/config change touching shared host routing.
3. Disable grid routes before touching legacy service state.
4. Restore legacy config from known backup if proxy separation broke.

Verification:

- Legacy health returns expected service identity.
- Legacy WebSocket connects on its existing path.
- Grid-specific routes are not reachable through `warp.ponslink.com` unless explicitly designed and approved.
- Grid DB/schema/process failure does not change legacy readiness.

User comms criteria:

- If legacy users are affected, communicate as a production incident, not a Grid beta-only issue.
- Confirm final status separately for Grid and legacy Warp surfaces.
