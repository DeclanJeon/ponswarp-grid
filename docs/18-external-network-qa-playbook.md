# External Network QA Playbook

Status: Active
Last updated: 2026-07-06

## Purpose

This playbook records the external-network evidence needed before claiming PonsWarp Grid is production-ready across real network conditions. The local code, validators, and matrix runner exist; the remaining proof requires actual devices and networks.

## Current gate

Run:

```bash
pnpm grid:network-matrix -- --strict --out artifacts/g008-cross-network-strict-report.json
```

Expected final state:

```text
verdict: passed
exit code: 0
```

Current known blocker state from the latest strict-schema run:

```text
verdict: needs_external_evidence
NET-001 passed: normalized JSON is backed by the measured LAN CLI receipt and matching SHA-256.
NET-002 passed: strict NAT/split-network browser evidence records selected pair, RTT, goodput, integrity, and clean disposal.
NET-003 passed: strict LTE browser evidence records the same machine-readable contract.
NET-004 missing: the historical TURN UDP result is Markdown/screenshot evidence without the required positive byte and throughput fields.
NET-005 inconclusive: a historical TCP/TLS diagnostic exists but lacks the complete current producer schema and selected-pair invariants.
NET-006 missing: UDP-blocked TCP/TLS-only transfer proof is absent.
NET-007 and NET-008 passed as explicitly synthetic, non-network evidence.
```

## Who can run this

The agent can run the full flow only if it has access to the actual test devices and network controls:

- sender device shell or browser/CDP access,
- receiver device shell or browser/CDP access,
- permission to use two different networks,
- permission to temporarily block UDP on a test device or network,
- production/staging signaling URL.

Without that access, an operator must run the external tests and commit/copy the generated artifacts into `artifacts/`.

## Required artifacts

Minimum artifact set to unblock the remaining strict matrix rows:

```text
artifacts/turn-relay-udp-report.json
artifacts/turn-tcp-tls-diagnostic-report.json
artifacts/udp-blocked-tcp-tls-report.json
```

Every PASS-producing matrix row requires exact versioned JSON with its scenario-specific positive metrics and cross-field invariants. Markdown and screenshots may be retained only as operator notes and never satisfy a row. Browser and TURN output metrics contain candidate type/protocol only; address-bearing evidence is rejected or excluded from serialization.

## Preparation

Install and verify locally:

```bash
pnpm install
pnpm build
pnpm test
```

Fetch short-lived ICE/TURN credentials. Prefer the grid production route when deployed:

```bash
pnpm turn:fetch-ice -- \
  --out artifacts/.turn-ice.json \
  --signal wss://grid.ponslink.com/ws/grid
```

Fallback only if the grid route is not deployed yet:

```bash
pnpm turn:fetch-ice -- \
  --out artifacts/.turn-ice.json \
  --signal wss://warp.ponslink.com/ws
```

`artifacts/.turn-ice.json` contains temporary TURN credentials. Do not commit it.

## NET-006: UDP-blocked TCP/TLS-only TURN transfer

### Goal

Prove that when UDP is actually blocked, transfer still completes through TURN TCP/TLS relay.

A TURN URL with `?transport=tcp` is not sufficient by itself. Chrome may still select UDP relay. The proof must show:

- UDP was blocked or unavailable,
- selected relay protocol is `tcp` or `tls`,
- transfer completed,
- throughput is recorded.

### Linux UDP block example

Use a disposable test device or a controlled network. Add rules:

```bash
sudo iptables -I OUTPUT -p udp -j REJECT
sudo iptables -I INPUT -p udp -j REJECT
```

Run diagnostic:

```bash
pnpm turn:diagnose -- \
  --ice-server-json artifacts/.turn-ice.json \
  --policy relay \
  --mode transfer \
  --expect relay-tcp \
  --transfer-bytes 1048576 \
  --out artifacts/udp-blocked-tcp-tls-report.json
```

Restore networking immediately:

```bash
sudo iptables -D OUTPUT -p udp -j REJECT
sudo iptables -D INPUT -p udp -j REJECT
```

Validate:

```bash
pnpm grid:network-matrix -- --out artifacts/g006-cross-network-matrix-report.json
```

### Artifact requirements

NET-006 is classified only from the exact structured proof below. The diagnostic output must be combined with evidence captured while UDP rejection was active; a filename, Markdown assertion, or `?transport=tcp` URL alone is inconclusive.

```json
{
  "schemaVersion": 1,
  "kind": "udp-blocked-turn-diagnostic-report",
  "verdict": "passed",
  "udpBlockedProof": {
    "kind": "firewall-rule",
    "verified": true,
    "evidence": "isolated QA host firewall rejected UDP during the run"
  },
  "selectedCandidatePair": {
    "localCandidateType": "relay",
    "localRelayProtocol": "tls"
  },
  "transfer": {
    "requestedBytes": 1048576,
    "receivedBytes": 1048576,
    "complete": true,
    "throughputBps": 123456
  },
  "classification": {
    "verdict": "passed",
    "observedRelayProtocol": "tls"
  }
}
```

`udpBlockedProof.kind` is limited to `firewall-rule` or `network-namespace`. Requested and received bytes must match, the selected relay protocol and classification must agree, and all numeric measurements must be positive.

## NET-002: NAT / split-network browser transfer

### Goal
Remote HTTP QA must run in a secure context: serve the browser page over HTTPS (or use `localhost` for local-only QA). A plain remote `http://` origin is not valid evidence because WebRTC and its diagnostic APIs require a secure context.

Prove browser transfer works across NAT/split-network conditions and record the selected ICE pair.

### Markdown artifact (reference only; never classified)

A Markdown report may be retained for operator notes, but it cannot satisfy NET-002 or NET-003. Use the JSON contract below for machine-readable evidence.

Create:

```text
artifacts/nat-split-network-browser-report.md
```

Required content:

```md
# NAT split-network browser QA

Result: PASS

Sender: workstation on home Wi-Fi
Receiver: laptop on phone LTE hotspot

Selected pair: local=srflx/udp remote=srflx/udp

Transfer complete and verified.
File size: 10485760 bytes
Throughput: 1234567 bps
```

If relay is selected, record it truthfully:

```md
Selected pair: local=relay/udp remote=relay/udp
```

### JSON artifact (required for browser classification)

A browser row is classified only from a JSON artifact with these exact fields. Markdown, CLI reports, and JSON with missing or extra fields are inconclusive:

```json
{
  "schemaVersion": 1,
  "kind": "browser-network-transfer-report",
  "scenario": "nat-split-network",
  "verdict": "passed",
  "sender": { "device": "workstation", "network": "home-wifi" },
  "receiver": { "device": "laptop", "network": "phone-lte-hotspot" },
  "selectedPair": "local=srflx/udp remote=srflx/udp",
  "transfer": {
    "complete": true,
    "bytes": 10485760,
    "rttMs": 42,
    "payloadGoodputBps": 1234567
  },
  "runtime": { "window": 1 },
  "terminal": {
    "integrityVerified": true,
    "disposalCompleted": true,
    "outstandingRequests": 0,
    "activeTimers": 0
  }
}
```

`selectedPair` contains candidate types and protocols only; never record IP addresses, URLs, tokens, or other privacy-sensitive values. `rttMs`, `payloadGoodputBps`, and `bytes` must be positive observed numbers. `runtime.window` must be `1`; this evidence never enables Window 2.

## Direct-transfer reliability evidence (local)

External-network artifacts do not replace the local direct-transfer reliability run. Local evidence uses schema v2 under `artifacts/direct-transfer/<suiteId>/runs/`; each run is bound to the manifest suite/build/fixture and records its selected window, stratum, outcome, lifecycle errors, and clean `dispose` evidence. Dispose evidence is mandatory for succeeded, failed, and cancelled runs. A stratum that cannot run is represented only by the separate unavailable-approval record, never by a fabricated run.

Use the versioned manifest and approval files:

```text
qa/direct-transfer/run-manifest.v1.json
qa/direct-transfer/unavailable-approval.v1.json
qa/direct-transfer/suite-index.v1.json
```

Unavailable strata require explicit approval naming the reason, impact, approver, expiry, and rollback condition. Approval does not turn unavailable into pass; absent or expired approval yields `HOLD`.

Run strict validation followed by aggregation:

```bash
node scripts/validate-direct-transfer-runs.mjs \
  --manifest qa/direct-transfer/run-manifest.v1.json \
  --approval qa/direct-transfer/unavailable-approval.v1.json \
  --runs artifacts/direct-transfer/<suiteId>/runs \
  --out artifacts/direct-transfer/<suiteId>/validation.json && \
node scripts/aggregate-direct-transfer-runs.mjs \
  --manifest qa/direct-transfer/run-manifest.v1.json \
  --approval qa/direct-transfer/unavailable-approval.v1.json \
  --validation artifacts/direct-transfer/<suiteId>/validation.json \
  --runs artifacts/direct-transfer/<suiteId>/runs \
  --out artifacts/direct-transfer/<suiteId>/result.json \
  --markdown-out artifacts/direct-transfer/<suiteId>/result.md \
  --strict
```

The operational runtime default is hold-1. Window 2 is config-gated and impossible before an explicit `ENABLE`; `HOLD` and `ROLLBACK` force window 1. A lifecycle error, failed validation, unavailable stratum without approval, or missing dispose evidence requires rollback to hold-1. Do not infer or publish performance gains from these records.
## NET-003: LTE/5G mobile browser transfer

### Goal

Prove a real mobile-network path and normalize the evidence.

Create:

```text
artifacts/lte-5g-mobile-browser-report.md
```

Required content:

```md
# LTE/5G mobile browser QA

Result: PASS

Sender: phone Chrome
Sender network: LTE

Receiver: laptop Chrome
Receiver network: home Wi-Fi

Selected pair: local=srflx/udp remote=srflx/udp

Transfer complete and verified.
File size: 10485760 bytes
Throughput: 1234567 bps
```

If relay is selected:

```md
Selected pair: local=relay/udp remote=relay/udp
```

## Final verification

After adding the three artifacts:

```bash
pnpm grid:network-matrix -- --strict --out artifacts/final-cross-network-matrix-report.json
pnpm test
pnpm type-check
pnpm build
pnpm deploy:validate-grid -- --out artifacts/final-deployment-config-validation-report.json
pnpm deploy:validate-security -- --out artifacts/final-security-release-validation-report.json
pnpm deploy:validate-db -- --out artifacts/final-db-readiness-validation-report.json
pnpm deploy:validate-onboarding -- --out artifacts/final-onboarding-validation-report.json
pnpm deploy:validate-private-beta -- --out artifacts/final-private-beta-validation-report.json
```

Do not claim final 95% readiness until the strict matrix passes.

## Operator safety notes

- Do not commit raw TURN credentials.
- Do not leave UDP firewall rules active after testing.
- Do not publish full share codes in public logs or screenshots.
- Prefer dedicated test files with non-sensitive names.
- Record actual selected ICE pairs; do not rewrite relay/direct results to match expectations.
