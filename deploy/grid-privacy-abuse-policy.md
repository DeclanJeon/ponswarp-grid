# grid.ponslink.com Privacy and Abuse Policy

Operational policy for the PonsWarp Grid public-beta surface at `https://grid.ponslink.com`.

## Data model and metadata inventory

Grid is a coordinator for direct file transfer. It may store or process:

| Category | Examples | Purpose |
|---|---|---|
| Workspace/node metadata | workspace id, node id hash, public key, node status, heartbeat timestamps | authorize providers and find live candidates |
| Share metadata | share code hash, file id, expiry, revoked/deleted state, creator node/workspace | resolve a receiver request without exposing internals |
| File metadata | file name, size, MIME/type if supplied, piece size/count, content/piece hashes | display expected transfer and verify pieces |
| Availability metadata | which nodes claim pieces/files, last seen, candidate priority | schedule direct/relay transfer |
| Rate-limit keys | IP hash, share code hash, route group, counters, expiry | block scraping, brute force, and relay abuse |
| Audit events | request id, actor type, workspace id, node id hash, share code hash, action, allow/deny, reason, latency | incident response and abuse investigation |
| Metrics | active nodes, shares, candidates, connect grants, auth denials, TURN failures, quota denials | reliability, capacity, and cost control |

## Data not stored

Grid coordinator policy prohibits storing:

- Original file contents.
- Raw private file paths from sender machines.
- Raw node tokens or token signing secrets.
- Raw TURN credentials or TURN issuer secrets.
- Full raw share codes in logs, metrics, audit records, support notes, or screenshots.
- Private network addresses unless required transiently by WebRTC/TURN infrastructure; do not persist them in application audit records.

## Retention, delete, and revoke

| Data | Retention policy | Delete/revoke behavior |
|---|---|---|
| Active share | Until configured expiry or explicit revocation | Owner/admin revoke immediately denies resolve/candidates/connect. |
| Expired share | Deny immediately after expiry; cleanup after operational grace period | Cleanup may remove share and orphaned file metadata. |
| File metadata | While an active share or active availability references it | Remove after share expiry/revoke and no active availability remains. |
| Presence/availability | Mark offline after heartbeat timeout | Cleanup stale rows after timeout/grace period. |
| Revoked token | Deny immediately; retain hash/audit reference for investigation | Raw token is never stored; rotate compromised token. |
| Rate-limit buckets | Until `expires_at`, then cleanup | False positives may be cleared for the affected key only. |
| Audit events | Public beta default: 30-90 days | Preserve relevant events under incident hold; redact before sharing externally. |
| Infrastructure access logs | Short operational retention under host policy | Prefer no query strings; scrub codes/tokens before support export. |

Deletion requests should remove or anonymize user/workspace/share metadata that is no longer needed for active transfer, legal/security hold, billing, or abuse investigation. Revocation is the immediate safety action for leaked shares/tokens; deletion is cleanup after access is already denied.

## IP hash and salt/pepper policy

- Application rate limits use keyed IP hashes rather than raw IP addresses when feasible.
- Hash inputs should include a deployment-specific secret pepper not committed to the repository.
- Rotate salt/pepper on a scheduled basis and immediately after suspected exposure.
- Rotation may invalidate historical correlation; keep a short overlap only when needed for active abuse mitigation.
- Operators must not reverse, export, or enrich IP hashes except for documented abuse/security response.
- Public or support-facing records must show truncated hashes only.

## Audit logging and redaction rules

Audit records must include enough information to explain a decision without exposing credentials:

- Include: request id, route/action, actor type, workspace id, node id hash, share code hash, decision, reason code, latency, coarse timestamp.
- Exclude: raw node token, raw TURN credential, full share code, private file path, full Authorization header, cookies, database URL, secret env values.
- Redact before copying logs into issues, chat, email, incident reports, or customer replies.
- Use stable redaction labels such as `[share-code-hash:abc123]`, `[node-token:redacted]`, and `[turn-credential:redacted]`.
- Screenshots and terminal transcripts must be reviewed for codes/tokens before sharing.

## Abuse reporting

Reports should include the share link/code if the reporter can safely provide it, approximate time, observed behavior, and any user-visible error. Operators must convert raw codes to hashes for internal tracking and then redact the raw value from the ticket.

Initial response actions:

1. Verify whether the share exists, is active, and has unusual resolve/candidate/connect volume.
2. Revoke the abusive share or node token when policy or safety requires it.
3. Apply or tighten route-specific rate limits for the affected IP hash/share hash/workspace.
4. Preserve audit evidence for the retention window or incident hold.
5. Communicate outcome without exposing reporter identity, raw tokens, or unrelated metadata.

## Quota, rate-limit, and cost guardrails

Public beta defaults should be conservative:

| Guardrail | Default intent |
|---|---|
| create workspace | Low per-IP hourly limit to prevent signup/workspace spray. |
| register node | Per-workspace hourly limit. |
| heartbeat/events | Per-node minute limits. |
| publish file/create share | Per-node hourly limits. |
| resolve/candidates/connect | Per-IP + share-code-hash minute limits. |
| active shares per node | Cap to prevent unattended provider abuse. |
| file metadata size | Reject oversized metadata before DB/storage pressure. |
| candidates per response | Bound response size and candidate scraping. |
| relay-only session duration | Cap TURN cost exposure. |
| daily connect grants per IP/workspace | Limit automated relay drain. |
| large-file warning threshold | Route users to CLI before browser/relay cost risk grows. |

Metrics to watch: `rate_limit_hits_total`, `quota_denied_total`, `turn_relay_sessions_total`, `turn_relay_bytes_estimated`, `grid_candidate_response_size`, `large_file_share_created_total`, `auth_denied_total`, and API/DB latency.

## Operator conduct

- Use least-privilege admin access and prefer internal/VPN-only admin endpoints.
- Never ask a user for raw node tokens, TURN credentials, or private file paths.
- Avoid downloading user files during support; use metadata and transfer status unless the user explicitly provides a test file.
- Do not disclose whether another workspace/node exists except through authorized support channels.
- When in doubt, revoke first for safety, preserve audit evidence, then perform cleanup/deletion after review.
