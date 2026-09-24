# Grid 95% Completion Plan

Status: Draft execution plan  
Created: 2026-07-05  
Primary design document: `docs/16-grid-95-completion-design.md`  
Primary work order: `docs/17-grid-95-completion-work-order.md`

## Requirements summary

Raise `ponswarp-grid` from MVP engine/demo/CLI readiness to >=95% product completion by closing the known gaps identified in the repository review:

- core transfer robustness: multi-chunk piece transfer, retry, resume, provider churn;
- measured transfer telemetry: real speed/RTT/buffer/retry reporting, no hard-coded speed claims;
- browser product flow: real coordinator share-code resolve/connect/transfer/resume/download;
- CLI product flow: `status`, `clean`, coordinator `get` completion, large-file reports;
- coordinator contract: `/api/grid/v1/*` and `/ws/grid/*` route alignment;
- cross-network matrix: LAN, NAT, LTE/5G, relay-only, UDP-blocked TCP/TLS;
- production hardening validation: DB, auth, rate limit, metrics, cleanup, DR;
- docs/release gates aligned to evidence.

## Acceptance criteria

- `pnpm test`, `pnpm type-check`, and `pnpm build` pass.
- Final scorecard in `docs/16-grid-95-completion-design.md` is >=95/100.
- No unwaived SEV-1 remains.
- `artifacts/g95-final-readiness-report.md` exists and links every required proof.
- Browser and CLI product flows have automated or artifact-backed E2E evidence.
- Cross-network speed matrix reports include topology, transport/candidate path, file size, chunk/piece size, throughput, retry/failure counts, memory, and final hash.

## Implementation steps

1. Freeze contracts and schemas.
   - Coordinator route contract.
   - Transfer telemetry schema.
   - Network matrix report schema.

2. Implement core transfer robustness.
   - Multi-chunk send/reassembly.
   - Chunk timeout/retry handling.
   - Backpressure integration.
   - Tests for missing/corrupt/duplicate chunks.

3. Implement telemetry and speed reporting.
   - Emit real `transfer:speed`, `buffer:watermark`, and transfer summary events.
   - Remove or relabel hard-coded UI speed.
   - Add CLI/browser JSON reports.

4. Complete product clients.
   - Browser coordinator share/get flow.
   - CLI status/clean/coordinator get.
   - Resume and large-file-safe UX.

5. Align coordinator/deployment contracts.
   - `/api/grid/v1/*` and `/ws/grid/*` route tests.
   - Deployment validator behavior checks.
   - External Rust coordinator integration note or dev stub.

6. Build QA and performance gates.
   - Network matrix harness.
   - 500MiB CLI transfer evidence.
   - 100MiB+ browser relay or explicit unsupported UX evidence.

7. Run production-hardening validators.
   - DB readiness.
   - Security/auth/rate-limit.
   - Metrics/cleanup/restart/DR.

8. Align docs and final readiness report.
   - README/user guide/release gates.
   - Final 95% scorecard.

## Risks and mitigations

- Coordinator implementation may live outside this repo. Mitigation: contract tests and explicit external integration setup.
- Synthetic throughput may be mistaken for network speed. Mitigation: `synthetic: true` metadata and docs language gate.
- Chunking rewrite may break direct CLI. Mitigation: preserve direct integration tests and add compatibility tests.
- Network matrix may be too manual. Mitigation: machine-readable report schema and required fields.

## Verification steps

Baseline:

```bash
pnpm test
pnpm type-check
pnpm build
pnpm perf:500mb
pnpm grid:multi-provider-qa -- --out artifacts/g95-baseline-multi-provider-grid-report.json --size-mib 64 --piece-mib 1
```

Final:

```bash
pnpm test
pnpm type-check
pnpm build
pnpm perf:500mb
pnpm grid:multi-provider-qa -- --out artifacts/g95-final-multi-provider-grid-report.json --size-mib 128 --piece-mib 1
pnpm deploy:validate-grid -- --out artifacts/g95-final-deployment-validation-report.json
pnpm deploy:validate-security -- --out artifacts/g95-final-security-validation-report.json
pnpm deploy:validate-db -- --out artifacts/g95-final-db-validation-report.json
pnpm deploy:validate-onboarding -- --out artifacts/g95-final-onboarding-validation-report.json
pnpm deploy:validate-private-beta -- --out artifacts/g95-final-private-beta-validation-report.json
```

## ADR

### Decision

Use evidence-gated completion, not feature-count completion. 95% requires transfer correctness, coordinator product flow, telemetry, network matrix, production hardening, and docs alignment.

### Drivers

1. Real network reliability is the product risk.
2. Speed claims must be measured on real paths.
3. Coordinator contract is the largest gap between MVP and product.

### Alternatives considered

- Polish demo only: rejected; does not close production gaps.
- Duplicate full coordinator in TS: rejected as default; deployment points to external Rust `mesh_api`.
- Treat direct send/join as final product: rejected; share-code/coordinator product flow remains required.

### Consequences

- Work is multi-lane and should be executed through coordinated agents or a durable goal workflow.
- Some tasks may require external coordinator repo access.
- Final docs must not overclaim unsupported network paths.

## Follow-up staffing guidance

Use Team + durable goal tracking for execution:

- Core protocol lane: `executor` / Core engine engineer.
- Browser lane: `designer` + frontend executor.
- CLI lane: CLI executor.
- Coordinator lane: backend/API integrator.
- QA/network lane: tester/performance engineer.
- Release/docs lane: writer + verifier.

Team verification path:

- Each lane returns changed files, targeted tests, and artifact paths.
- Verifier lane owns final scorecard and blocks 95% claim until evidence exists.
