#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath = outIndex >= 0 ? args[outIndex + 1] : 'artifacts/grid-db-readiness-validation-report.json';
const migrationPath = '/home/declan/Documents/Develop/Project/ponswarp/ponswarp-signaling-rs/migrations/202607040001_mesh_repository_foundation.sql';

const checks = [];
function pass(id, evidence) { checks.push({ id, status: 'passed', evidence }); }
function fail(id, evidence) { checks.push({ id, status: 'failed', evidence }); }
function includesAll(id, text, needles) {
  const missing = needles.filter(needle => !text.includes(needle));
  if (missing.length === 0) pass(id, `Found ${needles.join(', ')}`);
  else fail(id, `Missing ${missing.join(', ')}`);
}
function assertTrue(id, condition, evidence, failure) { condition ? pass(id, evidence) : fail(id, failure); }

const migration = await readFile(migrationPath, 'utf8');
const runbook = await readFile('deploy/grid-db-operational-runbook.md', 'utf8');
const server = await readFile('packages/signaling/src/server.ts', 'utf8');
const drill = await readFile('scripts/mesh-postgres-drill.mjs', 'utf8');
let drillReport = null;
let rateLimitReport = null;
try { drillReport = JSON.parse(await readFile('artifacts/g003-grid-postgres-drill-report.json', 'utf8')); } catch {}
try { rateLimitReport = JSON.parse(await readFile('artifacts/g003-grid-postgres-rate-limit-report.json', 'utf8')); } catch {}

includesAll('migration-grid-schema', migration, [
  'CREATE SCHEMA IF NOT EXISTS grid',
  'SET search_path TO grid, public'
]);
includesAll('migration-required-tables', migration, [
  'CREATE TABLE IF NOT EXISTS mesh_workspaces',
  'CREATE TABLE IF NOT EXISTS mesh_workspace_members',
  'CREATE TABLE IF NOT EXISTS mesh_nodes',
  'CREATE TABLE IF NOT EXISTS mesh_node_tokens',
  'CREATE TABLE IF NOT EXISTS mesh_presence',
  'CREATE TABLE IF NOT EXISTS mesh_files',
  'CREATE TABLE IF NOT EXISTS mesh_availability',
  'CREATE TABLE IF NOT EXISTS mesh_shares',
  'CREATE TABLE IF NOT EXISTS mesh_events',
  'CREATE TABLE IF NOT EXISTS mesh_rate_limits'
]);
includesAll('migration-cleanup-indexes', migration, [
  'idx_mesh_presence_fresh',
  'idx_mesh_shares_active',
  'idx_mesh_rate_limits_expires'
]);
includesAll('runbook-namespace-backup-restore', runbook, [
  'ponswarp_grid_prod',
  'schema: grid',
  'pg_dump',
  'pg_restore',
  'staging clone',
  'mesh-postgres-drill'
]);
includesAll('runbook-cleanup-retention', runbook, [
  'mesh_presence',
  'mesh_shares',
  'mesh_rate_limits',
  'expired/revoked shares deny resolve/candidates/connect'
]);
includesAll('readiness-degraded-gate', server, [
  "request.url === '/readyz'",
  "ready ? 200 : 503",
  "status: ready ? 'ready' : 'not_ready'",
  "cleanupScheduler",
]);
includesAll('readiness-required-check-contract', runbook, [
  '"db": "ok|degraded"',
  '"migrations": "ok|degraded"',
  '"rateLimitStore": "ok|degraded"',
  '"cleanupScheduler": "ok|degraded|disabled"'
]);
includesAll('postgres-drill-coverage', drill, [
  'restart-persistence',
  'migration-grid-schema',
  'revoked-share-denied',
  'backup-restore',
  'restore-smoke',
  'cleanup-retention',
  'pg_dump',
  'pg_restore',
  'rateLimitSmoke',
  'PONSWARP_MESH_CLEANUP_RUN_ON_STARTUP'
]);
assertTrue(
  'migration-non-destructive-foundation',
  !/DROP\s+(TABLE|COLUMN)|TRUNCATE/i.test(migration),
  'Foundation migration contains no DROP/TRUNCATE destructive statements.',
  'Foundation migration must not contain destructive DROP/TRUNCATE statements.'
);
if (drillReport) {
  const stepIds = new Set((drillReport.steps ?? []).map(step => step.id));
  assertTrue('drill-artifact-verdict', drillReport.verdict === 'passed', 'Main Postgres drill artifact verdict is passed.', 'Main Postgres drill artifact must have verdict passed.');
  includesAll('drill-artifact-required-steps', [...stepIds].join('\n'), [
    'migration-grid-schema',
    'restart-persistence',
    'revoked-share-denied',
    'backup-restore',
    'restore-smoke',
    'cleanup-retention'
  ]);
} else {
  fail('drill-artifact-verdict', 'Missing artifacts/g003-grid-postgres-drill-report.json');
}
if (rateLimitReport) {
  const stepIds = new Set((rateLimitReport.steps ?? []).map(step => step.id));
  assertTrue('rate-limit-artifact-verdict', rateLimitReport.verdict === 'passed' && stepIds.has('rate-limit-smoke'), 'Rate-limit smoke artifact verdict is passed and includes rate-limit-smoke.', 'Rate-limit smoke artifact must pass and include rate-limit-smoke.');
} else {
  fail('rate-limit-artifact-verdict', 'Missing artifacts/g003-grid-postgres-rate-limit-report.json');
}

const report = { schemaVersion: 1, kind: 'grid-db-readiness-validation-report', verdict: checks.every(check => check.status === 'passed') ? 'passed' : 'failed', checkedAt: new Date().toISOString(), migrationPath, checks };
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (report.verdict !== 'passed') process.exitCode = 1;
