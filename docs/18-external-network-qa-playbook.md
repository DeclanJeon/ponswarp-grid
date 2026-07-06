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

Current known blocker state from the latest run:

```text
verdict: needs_external_evidence
NET-006 missing: UDP-blocked TCP/TLS-only transfer artifact is absent.
NET-002 inconclusive: NAT/split-network browser transfer lacks machine-readable selectedPair.
NET-003 inconclusive: LTE/5G mobile row is not fully normalized as machine-readable evidence.
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

Minimum artifact set to unblock the strict matrix:

```text
artifacts/udp-blocked-tcp-tls-report.json
artifacts/nat-split-network-browser-report.md
artifacts/lte-5g-mobile-browser-report.md
```

JSON is preferred. Markdown is acceptable if it includes the exact selected-pair and throughput fields listed below.

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

The generated JSON should contain or imply:

```json
{
  "kind": "turn-diagnostic-report",
  "verdict": "passed",
  "selectedCandidatePair": {
    "localCandidateType": "relay",
    "localRelayProtocol": "tls"
  },
  "transfer": {
    "complete": true,
    "receivedBytes": 1048576,
    "throughputBps": 123456
  },
  "classification": {
    "verdict": "passed",
    "observedRelayProtocol": "tls"
  }
}
```

## NET-002: NAT / split-network browser transfer

### Goal

Prove browser transfer works across NAT/split-network conditions and record the selected ICE pair.

### Markdown artifact option

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

### JSON artifact option

Preferred shape:

```json
{
  "schemaVersion": 1,
  "kind": "browser-network-transfer-report",
  "scenario": "nat-split-network",
  "verdict": "passed",
  "sender": {
    "device": "workstation",
    "network": "home-wifi"
  },
  "receiver": {
    "device": "laptop",
    "network": "phone-lte-hotspot"
  },
  "selectedPair": "local=srflx/udp remote=srflx/udp",
  "transfer": {
    "complete": true,
    "bytes": 10485760,
    "throughputBps": 1234567
  }
}
```

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
