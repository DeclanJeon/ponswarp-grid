# PonsWarp Grid User Guide

This guide covers first use of `https://grid.ponslink.com` for direct file sharing through the Grid coordinator. Grid metadata is registered with the coordinator, but original file bytes stay on sender/provider devices and move through WebRTC direct connections or TURN relay.

## Web sender

1. Open `https://grid.ponslink.com/`.
2. Select **Share a file**.
3. Click **Choose a file** and select the file to share.
4. Click **Create share link** to create the share link/code.
5. Send the code or link to the receiver through a channel you trust.
6. Keep the tab, browser, and device online until every receiver finishes.

The coordinator may store minimal metadata such as share code hash, file name/size/type, piece/hash metadata, node/workspace identifiers, expiry time, and audit/rate-limit events. It does not store the original file content.

## Web receiver

1. Open the received Grid link, or open `https://grid.ponslink.com/` and paste the share code.
2. Confirm that the displayed file name, size, and sender context are expected.
3. Click **Find file** and start the transfer.
4. Keep the browser open until the download completes and the integrity check succeeds.
5. If the page recommends CLI for a large file, use the CLI command shown with the same code.

A receiver should treat unknown codes like unknown download links. Do not open sensitive content from an untrusted sender.

## CLI installation

From this repository:

```bash
pnpm install
pnpm build
```

Default coordinator:
```text
https://grid.ponslink.com
```

Local development or staging override:
```bash
PONSWARP_COORDINATOR_URL=http://127.0.0.1:8787 node packages/cli/dist/cli.js files --workspace my-workspace
```

Persistent CLI state uses `PONSWARP_STORAGE_DIR` when set, otherwise `.ponswarp-grid` under the current working directory. For private state, set a user-only directory and keep node tokens out of shell history, logs, screenshots, and support tickets:
```bash
PONSWARP_STORAGE_DIR="$HOME/.ponswarp-grid" node packages/cli/dist/cli.js files --workspace my-workspace
```

## CLI sender

Start/register a node for the workspace:

```bash
node packages/cli/dist/cli.js node start \
  --workspace my-workspace \
  --node-id node-a \
  --public-key ed25519:dev
```

Create share metadata and print the resulting code or link:
```bash
node packages/cli/dist/cli.js share ./file.zip \
  --workspace my-workspace \
  --node-id node-a
```

The installed package exposes both `ponswarp` and `ponswarp-grid` bin names. From this source tree, use `node packages/cli/dist/cli.js ...`; after package installation/linking, the equivalent command is:
```bash
ponswarp-grid share ./file.zip --workspace my-workspace --node-id node-a
```

Keep the sender process/device online while receivers fetch pieces. Current coordinator `share/get` executes bytes only when an online provider advertises a direct join hint; otherwise it resolves metadata/candidates and reports that byte execution is unavailable. For reliable local byte-transfer QA, the lower-level direct primitive remains available:
```bash
node packages/cli/dist/cli.js send ./file.zip --listen 127.0.0.1:0
```

## CLI receiver

Receive by code or link:
```bash
node packages/cli/dist/cli.js get <share-code-or-link> --out ./downloads
```

Installed-package equivalent:
```bash
ponswarp-grid get <share-code-or-link> --out ./downloads
```

If `get` reports `execution: unavailable` or says no direct provider join hint is online yet, use the descriptor printed by `send` until coordinator-mediated provider byte transport is available for that provider:
```bash
node packages/cli/dist/cli.js join 'ponswarp://join/...' --out ./downloads
```

The CLI is recommended for large files because it can stream to disk, preserve resume state, avoid browser tab lifetime limits, and handle bounded-memory assembly more predictably.

## Sharing codes and links safely

- Share codes and links are bearer access to the advertised file metadata and transfer candidates until expiry or revocation.
- Send codes only to intended receivers.
- Revoke/delete a share when it was sent to the wrong person, posted publicly by mistake, or no longer needs to be active.
- Expired or revoked shares must fail resolve, candidate, and connect requests.
- Support and operators should refer to share code hashes, not full raw share codes.

## NAT, TURN, and firewall troubleshooting

Symptoms and fixes:

| Symptom | Likely cause | Action |
|---|---|---|
| Receiver cannot find a share | Bad, expired, or revoked code | Re-copy the full code/link; sender creates a new share if expired/revoked. |
| Share resolves but transfer never starts | Sender tab/process offline | Sender reopens the tab or restarts the CLI node and republishes/heartbeats. |
| Works on same Wi-Fi but not mobile/LTE | NAT traversal failure | Retry with both devices online; confirm `/api/grid/v1/ice` returns STUN/TURN config; use CLI for retry/resume. |
| UDP blocked by office network | Firewall blocks direct/UDP relay | Use a network allowing WebRTC, or require TURN TCP/TLS relay if available. |
| Browser download fails for large file | Browser memory/writable-stream limit | Use CLI receiver. |
| Transfer stalls repeatedly | Relay throughput/cost guardrail or unstable link | Use CLI, reduce concurrent transfers, or retry on a less restricted network. |

For operators, the ICE endpoint is `GET https://grid.ponslink.com/api/grid/v1/ice`. TURN credentials must be short-lived and never logged.

## Large-file behavior

- Browser small/medium files can use normal download behavior.
- Large files should show a CLI recommendation such as `ponswarp-grid get DEMO-XXXX` or the repository CLI equivalent.
- The engine verifies pieces with SHA-256 and avoids unsafe whole-file memory allocation above configured thresholds.
- CLI/native paths are preferred for resume, disk streaming, and long transfers.
- If a browser reports that final assembly is unsupported, do not keep retrying in the same browser; switch to CLI or a browser with a safe writable file sink.

## Safe privacy expectations

Grid is designed for direct transfer, not server-side file hosting:

- Original file bytes are not uploaded to or stored by the coordinator.
- Metadata can still be sensitive: file names, sizes, content types, hashes, workspace/node/share identifiers, timestamps, IP-derived rate-limit keys, and audit decisions may reveal activity.
- Private file paths, raw node tokens, raw TURN credentials, and full share codes must not appear in logs or support tickets.
- IP addresses should be stored for abuse controls only as keyed hashes with salt/pepper rotation, except where infrastructure logs require short operational retention.
- Use revocation/delete for mistaken shares; expiration alone is not a substitute for revoking a leaked code.
