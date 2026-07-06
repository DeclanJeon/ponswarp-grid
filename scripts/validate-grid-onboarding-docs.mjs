#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';

const args = process.argv.slice(2);
let outPath = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--out') {
    outPath = args[i + 1];
    i += 1;
  }
}

const docs = [
  { id: 'readme', path: 'README.md' },
  { id: 'user-guide', path: 'docs/15-grid-user-guide.md' },
  { id: 'privacy-abuse', path: 'deploy/grid-privacy-abuse-policy.md' },
  { id: 'incident-runbook', path: 'deploy/grid-ops-incident-runbook.md' },
  { id: 'cli-package', path: 'packages/cli/package.json' },
];

const requiredChecks = [
  { id: 'readme-grid-domain', doc: 'readme', terms: ['grid.ponslink.com', 'https://grid.ponslink.com'] },
  { id: 'readme-cli-install', doc: 'readme', terms: ['CLI', 'pnpm', 'ponswarp-grid'] },
  { id: 'readme-large-file-cli', doc: 'readme', terms: ['large', 'CLI', 'resume'] },
  { id: 'readme-current-transport-caveat', doc: 'readme', terms: ['direct transfer hint', 'send`/`join', 'candidate planning'] },
  { id: 'guide-web-sender', doc: 'user-guide', terms: ['Web sender', 'Choose a file', 'Create share link'] },
  { id: 'guide-web-receiver', doc: 'user-guide', terms: ['Web receiver', 'share code', 'Find file'] },
  { id: 'guide-cli-sender-receiver', doc: 'user-guide', terms: ['CLI sender', 'CLI receiver', 'share', 'get'] },
  { id: 'guide-cli-storage', doc: 'user-guide', terms: ['PONSWARP_STORAGE_DIR', '.ponswarp-grid', 'user-only directory'] },
  { id: 'guide-current-transport-caveat', doc: 'user-guide', terms: ['direct join hint', 'execution: unavailable', 'send'] },
  { id: 'guide-nat-turn', doc: 'user-guide', terms: ['NAT', 'TURN', 'firewall', 'TCP/TLS'] },
  { id: 'guide-large-file', doc: 'user-guide', terms: ['large file', 'bounded-memory', 'resume'] },
  { id: 'privacy-metadata', doc: 'privacy-abuse', terms: ['metadata', 'not store', 'original file'] },
  { id: 'privacy-retention-delete', doc: 'privacy-abuse', terms: ['retention', 'delete', 'revoke'] },
  { id: 'privacy-audit-ip-hash', doc: 'privacy-abuse', terms: ['audit', 'IP hash', 'salt'] },
  { id: 'abuse-rate-limit-quota', doc: 'privacy-abuse', terms: ['rate limit', 'quota', 'abuse'] },
  { id: 'incident-coordinator-down', doc: 'incident-runbook', terms: ['coordinator down', 'Detection', 'Mitigation'] },
  { id: 'incident-db-migration', doc: 'incident-runbook', terms: ['DB down', 'migration mismatch', 'readyz'] },
  { id: 'incident-turn-down', doc: 'incident-runbook', terms: ['TURN down', 'relay'] },
  { id: 'incident-token-leak', doc: 'incident-runbook', terms: ['token leak', 'rotate', 'revoke'] },
  { id: 'incident-abuse-spike', doc: 'incident-runbook', terms: ['abuse spike', 'rate limit'] },
  { id: 'incident-grid-rollback', doc: 'incident-runbook', terms: ['rollback grid.ponslink.com only', 'warp.ponslink.com', 'unaffected'] },
  { id: 'cli-bin-alias', doc: 'cli-package', terms: ['ponswarp-grid', './dist/cli.js'] },
];

const structuralChecks = [
  { id: 'readme-links-all-g004-docs', doc: 'readme', patterns: [/docs\/15-grid-user-guide\.md/, /deploy\/grid-privacy-abuse-policy\.md/, /deploy\/grid-ops-incident-runbook\.md/] },
  { id: 'user-guide-required-headings', doc: 'user-guide', patterns: [/^## Web sender$/m, /^## Web receiver$/m, /^## CLI installation$/m, /^## CLI sender$/m, /^## CLI receiver$/m, /^## NAT, TURN, and firewall troubleshooting$/m, /^## Large-file behavior$/m, /^## Safe privacy expectations$/m] },
  { id: 'user-guide-cli-commands', doc: 'user-guide', patterns: [/pnpm install/, /pnpm build/, /node packages\/cli\/dist\/cli\.js share/, /node packages\/cli\/dist\/cli\.js get/, /ponswarp-grid share/, /ponswarp-grid get/, /PONSWARP_COORDINATOR_URL=/, /PONSWARP_STORAGE_DIR=/] },
  { id: 'privacy-required-sections', doc: 'privacy-abuse', patterns: [/^## Data model and metadata inventory$/m, /^## Data not stored$/m, /^## Retention, delete, and revoke$/m, /^## IP hash and salt\/pepper policy$/m, /^## Audit logging and redaction rules$/m, /^## Abuse reporting$/m, /^## Quota, rate-limit, and cost guardrails$/m] },
  { id: 'incident-required-sections', doc: 'incident-runbook', patterns: [/^## Grid coordinator down$/m, /^## DB down or migration mismatch$/m, /^## TURN down or ICE credential failure$/m, /^## Rate-limit false positive$/m, /^## Token leak suspected$/m, /^## Abuse spike$/m, /^## Rollback grid\.ponslink\.com only$/m, /^## Verify warp\.ponslink\.com unaffected$/m] },
];

const prohibitedChecks = [
  { id: 'no-file-content-upload-claim', doc: 'readme', patterns: [/server stores (the )?original file/i, /upload(s|ed)? original file/i] },
  { id: 'no-raw-secret-advice', doc: 'privacy-abuse', patterns: [/log raw node token/i, /log raw TURN credential/i, /paste raw token/i] },
  { id: 'no-legacy-rollback-mutation', doc: 'incident-runbook', patterns: [/stop legacy `?warp\.ponslink\.com`?/i, /disable legacy `?warp\.ponslink\.com`?/i, /rollback legacy `?warp\.ponslink\.com`?/i] },
];

const loaded = new Map();
const missingDocs = [];
for (const doc of docs) {
  try {
    loaded.set(doc.id, await readFile(doc.path, 'utf8'));
  } catch (error) {
    missingDocs.push({ id: doc.id, path: doc.path, error: error.message });
    loaded.set(doc.id, '');
  }
}

const keywordChecks = requiredChecks.map((check) => {
  const content = loaded.get(check.doc) ?? '';
  const missingTerms = check.terms.filter((term) => !content.toLowerCase().includes(term.toLowerCase()));
  return { id: check.id, type: 'keyword', doc: check.doc, terms: check.terms, status: missingTerms.length === 0 ? 'passed' : 'failed', missingTerms };
});

const structureResults = structuralChecks.map((check) => {
  const content = loaded.get(check.doc) ?? '';
  const missingPatterns = check.patterns.map((pattern) => pattern.toString()).filter((_, index) => !check.patterns[index].test(content));
  return { id: check.id, type: 'structure', doc: check.doc, status: missingPatterns.length === 0 ? 'passed' : 'failed', missingPatterns };
});

const prohibitedResults = prohibitedChecks.map((check) => {
  const content = loaded.get(check.doc) ?? '';
  const matchedPatterns = check.patterns.map((pattern) => pattern.toString()).filter((_, index) => check.patterns[index].test(content));
  return { id: check.id, type: 'prohibited', doc: check.doc, status: matchedPatterns.length === 0 ? 'passed' : 'failed', matchedPatterns };
});

const checks = [...keywordChecks, ...structureResults, ...prohibitedResults];
const report = {
  schemaVersion: 1,
  kind: 'grid-onboarding-docs-validation-report',
  generatedAt: new Date().toISOString(),
  status: missingDocs.length === 0 && checks.every((check) => check.status === 'passed') ? 'passed' : 'failed',
  documents: docs,
  missingDocs,
  checks,
};

if (outPath) {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, 2));
if (report.status !== 'passed') process.exitCode = 1;
