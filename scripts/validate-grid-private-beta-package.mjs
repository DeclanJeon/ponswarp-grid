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

const jsonArtifacts = [
  { id: 'g001-config', path: 'artifacts/g001-grid-deployment-config-validation-report.json', requiredStatus: 'passed' },
  { id: 'g002-security', path: 'artifacts/g002-grid-security-release-validation-report.json', requiredStatus: 'passed' },
  { id: 'g003-db', path: 'artifacts/g003-grid-db-readiness-validation-report.json', requiredStatus: 'passed' },
  { id: 'g003-postgres-drill', path: 'artifacts/g003-grid-postgres-drill-report.json', requiredVerdict: 'passed' },
  { id: 'g003-rate-limit-drill', path: 'artifacts/g003-grid-postgres-rate-limit-report.json', requiredVerdict: 'passed' },
  { id: 'g004-onboarding', path: 'artifacts/g004-grid-onboarding-validation-report.json', requiredStatus: 'passed' },
  { id: 'g005-local-verification', path: 'artifacts/g005-grid-local-verification-report.json', requiredStatus: 'passed' },
];

const textArtifacts = [
  { id: 'deployment-design', path: 'docs/14-grid-ponslink-deployment-design.md', requiredTerms: ['grid.ponslink.com', 'Staging host smoke', 'Real-device QA', 'Go / No-Go'] },
  { id: 'user-guide', path: 'docs/15-grid-user-guide.md', requiredTerms: ['Web sender', 'CLI sender', 'NAT', 'TURN'] },
  { id: 'privacy-policy', path: 'deploy/grid-privacy-abuse-policy.md', requiredTerms: ['metadata', 'retention', 'rate limit', 'abuse'] },
  { id: 'incident-runbook', path: 'deploy/grid-ops-incident-runbook.md', requiredTerms: ['Rollback grid.ponslink.com only', 'Verify warp.ponslink.com unaffected'] },
  { id: 'private-beta-report', path: 'artifacts/g005-grid-private-beta-qa-report.md', requiredTerms: ['Go / No-Go', 'Verification matrix', 'Browser smoke instructions', 'CLI smoke instructions', 'Evidence artifacts'] },
];

async function readJsonArtifact(spec) {
  try {
    const parsed = JSON.parse(await readFile(spec.path, 'utf8'));
    const status = parsed.status ?? parsed.verdict;
    const required = spec.requiredStatus ?? spec.requiredVerdict;
    const commands = Array.isArray(parsed.commands) ? parsed.commands : [];
    const commandFailures = spec.id === 'g005-local-verification'
      ? commands.filter((command) => command.status !== 'passed')
      : [];
    const hasRequiredLocalCommands = spec.id !== 'g005-local-verification'
      || ['pnpm type-check', 'pnpm build', 'pnpm test'].every((command) => commands.some((entry) => entry.command === command && entry.status === 'passed'));
    const testSummaryOk = spec.id !== 'g005-local-verification'
      || commands.some((entry) => entry.command === 'pnpm test' && entry.testFilesPassed >= 11 && entry.testsPassed >= 80);
    return {
      id: spec.id,
      path: spec.path,
      status: status === required && commandFailures.length === 0 && hasRequiredLocalCommands && testSummaryOk ? 'passed' : 'failed',
      observed: status,
      required,
      commandFailures,
      hasRequiredLocalCommands,
      testSummaryOk
    };
  } catch (error) {
    return { id: spec.id, path: spec.path, status: 'failed', error: error.message };
  }
}

async function readTextArtifact(spec) {
  try {
    const content = await readFile(spec.path, 'utf8');
    const missingTerms = spec.requiredTerms.filter((term) => !content.toLowerCase().includes(term.toLowerCase()));
    return { id: spec.id, path: spec.path, status: missingTerms.length === 0 ? 'passed' : 'failed', missingTerms };
  } catch (error) {
    return { id: spec.id, path: spec.path, status: 'failed', error: error.message };
  }
}

const jsonChecks = await Promise.all(jsonArtifacts.map(readJsonArtifact));
const textChecks = await Promise.all(textArtifacts.map(readTextArtifact));
const checks = [...jsonChecks, ...textChecks];
const report = {
  schemaVersion: 1,
  kind: 'grid-private-beta-qa-package-validation-report',
  generatedAt: new Date().toISOString(),
  status: checks.every((check) => check.status === 'passed') ? 'passed' : 'failed',
  checks,
};

if (outPath) {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, 2));
if (report.status !== 'passed') process.exitCode = 1;
