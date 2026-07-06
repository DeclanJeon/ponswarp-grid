#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const RUST_ROOT = '/home/declan/Documents/Develop/Project/ponswarp/ponswarp-signaling-rs';
const TOKEN = 'g002-postgres-drill-token-pepper-32-bytes-minimum';

function parseArgs(argv) {
  const args = { out: 'artifacts/public-g002-postgres-drill-report.json', port: 5592, pgPort: 55432, keep: false, rateLimitSmoke: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--') continue;
    const value = argv[index + 1];
    if (flag === '--out') { args.out = required(flag, value); index += 1; }
    else if (flag === '--port') { args.port = Number(required(flag, value)); index += 1; }
    else if (flag === '--pg-port') { args.pgPort = Number(required(flag, value)); index += 1; }
    else if (flag === '--keep') args.keep = true;
    else if (flag === '--rate-limit-smoke') args.rateLimitSmoke = true;
    else if (flag === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}
function required(flag, value) { if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`); return value; }
function usage() { return 'Usage: node scripts/mesh-postgres-drill.mjs --out artifacts/public-g002-postgres-drill-report.json [--port 5592] [--pg-port 55432]'; }
function pgUrl(port, database) { return `postgres://postgres:postgres@127.0.0.1:${port}/${database}?options=-csearch_path%3Dgrid,public`; }

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? ROOT, env: options.env ?? process.env, stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '', stderr = '';
    if (options.capture) {
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
    }
    child.on('exit', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`)));
    child.on('error', reject);
  });
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError?.message ?? 'no success'}`);
}

async function request(origin, path, { method = 'GET', body, auth = true } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
  return { status: response.status, json };
}

async function startMesh(port, databaseUrl, options = {}) {
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    PONSWARP_MESH_ENABLED: 'true',
    PONSWARP_MESH_STORAGE: 'postgres',
    PONSWARP_MESH_AUTO_APPROVE_NODES: 'true',
    PONSWARP_MESH_TOKEN_PEPPER: TOKEN,
    PONSWARP_MESH_CLEANUP_RUN_ON_STARTUP: 'true',
    PONSWARP_MESH_CLEANUP_INTERVAL_SECONDS: '0',
    PONSWARP_MESH_EXPIRED_SHARE_RETENTION_SECONDS: '0',
    PONSWARP_MESH_STALE_PRESENCE_RETENTION_SECONDS: '0',
    PONSWARP_MESH_EVENT_RETENTION_SECONDS: '1',
    DATABASE_URL: databaseUrl,
    DATABASE_RUN_MIGRATIONS: 'true',
    ...(options.strictRateLimit ? { PONSWARP_MESH_RATE_LIMIT_CAPACITY: '1', PONSWARP_MESH_RATE_LIMIT_REFILL_PER_SECOND: '1' } : {}),
  };
  const child = spawn('cargo', ['run', '--quiet', '--manifest-path', join(RUST_ROOT, 'Cargo.toml'), '--bin', 'mesh_api'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`mesh_api exited ${child.exitCode}: ${stdout}\n${stderr}`);
      const response = await fetch(`${origin}/ready`);
      return response.ok;
    }, 120_000, 'mesh_api ready');
  } catch (error) {
    throw new Error(`${error.message}\nmesh_api stdout:\n${stdout}\nmesh_api stderr:\n${stderr}`);
  }
  return {
    origin,
    logs: () => ({ stdout, stderr }),
    async stop() {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }
  const name = `ponswarp-g002-pg-${Date.now()}`;
  const databaseUrl = pgUrl(args.pgPort, 'postgres');
  const restoreDatabase = `restore_${Date.now()}`;
  const restoreUrl = pgUrl(args.pgPort, restoreDatabase);
  const report = { schemaVersion: 1, kind: 'postgres-operational-drill-report', startedAt: new Date().toISOString(), steps: [], verdict: 'failed' };
  let mesh;
  try {
    await run('docker', ['run', '--rm', '--name', name, '-e', 'POSTGRES_PASSWORD=postgres', '-p', `127.0.0.1:${args.pgPort}:5432`, '-d', 'postgres:16-alpine'], { capture: true });
    report.steps.push({ id: 'postgres-start', status: 'passed', port: args.pgPort });
    await waitFor(() => run('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { capture: true }).then(() => true), 60_000, 'postgres ready');
    report.steps.push({ id: 'postgres-ready', status: 'passed' });

    mesh = await startMesh(args.port, databaseUrl, args.rateLimitSmoke ? { strictRateLimit: true } : {});
    report.steps.push({ id: 'mesh-start-migrate', status: 'passed' });
    const schemaCheck = await run('docker', ['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'grid' AND table_name = 'mesh_workspaces'"], { capture: true });
    if (schemaCheck.stdout.trim() !== '1') throw new Error(`grid schema migration check failed: ${schemaCheck.stdout}`);
    report.steps.push({ id: 'migration-grid-schema', status: 'passed' });
    const origin = mesh.origin;
    if (args.rateLimitSmoke) {
      const rateWorkspace = `rl_${Date.now()}`;
      const first = await fetch(`${origin}/api/mesh/v1/workspaces`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: rateWorkspace, name: rateWorkspace })
      });
      const second = await fetch(`${origin}/api/mesh/v1/workspaces`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: `${rateWorkspace}_second`, name: `${rateWorkspace}_second` })
      });
      const secondBody = await second.json().catch(() => ({}));
      if (first.status === 429) throw new Error('first request was rate limited; expected one allowed token');
      if (second.status !== 429) throw new Error(`second request was not rate limited: ${second.status}`);
      report.steps.push({
        id: 'rate-limit-smoke',
        status: 'passed',
        firstStatus: first.status,
        secondStatus: second.status,
        retryAfter: second.headers.get('retry-after'),
        body: secondBody,
      });
      report.verdict = 'passed';
      report.finishedAt = new Date().toISOString();
      await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const workspace = `g002_${Date.now()}`;
    const nodeId = 'node-a';
    const fileId = 'file-a';
    const shareCode = 'G002-DRILL';
    const now = Math.floor(Date.now() / 1000);

    await request(origin, '/api/mesh/v1/workspaces', { method: 'POST', body: { workspaceId: workspace, name: workspace } });
    await request(origin, `/api/mesh/v1/workspaces/${workspace}/nodes`, { method: 'POST', body: { nodeId, displayName: 'Node A', publicKey: 'pk-a', capabilities: { transport: 'test' } } });
    await request(origin, `/api/mesh/v1/workspaces/${workspace}/nodes/${nodeId}/heartbeat`, { method: 'POST', body: { status: 'online', endpointHints: [{ kind: 'test', value: 'endpoint' }], ttlSeconds: 60 } });
    await request(origin, `/api/mesh/v1/workspaces/${workspace}/files`, { method: 'POST', body: { manifest: { fileId, name: 'demo.bin', sizeBytes: 16, pieceSize: 8, pieceCount: 2 }, availability: { nodeId, complete: true, verifiedRanges: [{ start: 0, end: 1 }] } } });
    await request(origin, `/api/mesh/v1/workspaces/${workspace}/shares`, { method: 'POST', body: { code: shareCode, fileId, createdByNodeId: nodeId, ttlSeconds: 300 } });
    const beforeResolve = await request(origin, `/api/mesh/v1/shares/${shareCode}`, { auth: false });
    const beforeCandidates = await request(origin, `/api/mesh/v1/shares/${shareCode}/candidates`, { auth: false });
    report.steps.push({ id: 'fixture-create', status: 'passed', beforeResolve: beforeResolve.json, beforeCandidateCount: beforeCandidates.json.providers?.length ?? 0 });

    await mesh.stop();
    mesh = await startMesh(args.port, databaseUrl);
    const afterResolve = await request(mesh.origin, `/api/mesh/v1/shares/${shareCode}`, { auth: false });
    const afterCandidates = await request(mesh.origin, `/api/mesh/v1/shares/${shareCode}/candidates`, { auth: false });
    if (afterResolve.json.fileId !== fileId) throw new Error('restart resolve did not preserve fileId');
    if ((afterCandidates.json.providers?.length ?? 0) < 1) throw new Error('restart candidates did not hydrate from Postgres');
    report.steps.push({ id: 'restart-persistence', status: 'passed', afterResolve: afterResolve.json, afterCandidateCount: afterCandidates.json.providers.length });

    const revokedCode = 'G002-RVKD';
    await request(mesh.origin, `/api/mesh/v1/workspaces/${workspace}/shares`, { method: 'POST', body: { code: revokedCode, fileId, createdByNodeId: nodeId, ttlSeconds: 300 } });
    await request(mesh.origin, `/api/mesh/v1/shares/${revokedCode}`, { method: 'DELETE' });
    const revokedResponse = await fetch(`${mesh.origin}/api/mesh/v1/shares/${revokedCode}`);
    if (revokedResponse.ok) throw new Error('revoked share remained resolvable');
    report.steps.push({ id: 'revoked-share-denied', status: 'passed', httpStatus: revokedResponse.status });

    await mesh.stop();
    mesh = undefined;
    await run('docker', ['exec', name, 'pg_dump', '-U', 'postgres', '-Fc', '-d', 'postgres', '-f', '/tmp/grid.dump'], { capture: true });
    await run('docker', ['exec', name, 'createdb', '-U', 'postgres', restoreDatabase], { capture: true });
    await run('docker', ['exec', name, 'pg_restore', '-U', 'postgres', '-d', restoreDatabase, '/tmp/grid.dump'], { capture: true });
    report.steps.push({ id: 'backup-restore', status: 'passed', restoreDatabase });

    mesh = await startMesh(args.port, restoreUrl);
    const restoredResolve = await request(mesh.origin, `/api/mesh/v1/shares/${shareCode}`, { auth: false });
    const restoredCandidates = await request(mesh.origin, `/api/mesh/v1/shares/${shareCode}/candidates`, { auth: false });
    if (restoredResolve.json.fileId !== fileId) throw new Error('restored resolve did not preserve fileId');
    if ((restoredCandidates.json.providers?.length ?? 0) < 1) throw new Error('restored candidates missing provider');
    report.steps.push({ id: 'restore-smoke', status: 'passed', restoredCandidateCount: restoredCandidates.json.providers.length });

    const expiredCode = 'G002-OLDX';
    await request(mesh.origin, `/api/mesh/v1/workspaces/${workspace}/shares`, { method: 'POST', body: { code: expiredCode, fileId, createdByNodeId: nodeId, ttlSeconds: 1 } });
    await new Promise(resolve => setTimeout(resolve, 1500));
    await mesh.stop();
    mesh = undefined;
    await run('docker', ['exec', name, 'psql', '-U', 'postgres', '-d', restoreDatabase, '-c', `UPDATE grid.mesh_presence SET expires_at = 0 WHERE workspace_id = '${workspace}'; INSERT INTO grid.mesh_events (event_id, workspace_id, event_type, payload, created_at) VALUES ('evt-old-${workspace}', '${workspace}', 'old_event', '{}'::jsonb, 0) ON CONFLICT (event_id) DO NOTHING; INSERT INTO grid.mesh_rate_limits (bucket_key, tokens, capacity, refill_per_second, updated_at, expires_at) VALUES ('expired-${workspace}', 0, 1, 1, 0, 0) ON CONFLICT (bucket_key) DO UPDATE SET expires_at = EXCLUDED.expires_at;`], { capture: true });
    mesh = await startMesh(args.port, restoreUrl);
    const expiredResponse = await fetch(`${mesh.origin}/api/mesh/v1/shares/${expiredCode}`);
    if (expiredResponse.ok) throw new Error('expired share remained resolvable after cleanup-on-startup');
    await request(mesh.origin, '/api/mesh/v1/workspaces', { method: 'POST', body: { workspaceId: `cleanup_${Date.now()}`, name: 'cleanup trigger' } }).catch(() => null);
    const retentionCounts = await run('docker', ['exec', name, 'psql', '-U', 'postgres', '-d', restoreDatabase, '-tAc', `SELECT (SELECT COUNT(*) FROM grid.mesh_presence WHERE workspace_id = '${workspace}' AND expires_at <= 0) || ',' || (SELECT COUNT(*) FROM grid.mesh_events WHERE event_id = 'evt-old-${workspace}') || ',' || (SELECT COUNT(*) FROM grid.mesh_rate_limits WHERE bucket_key = 'expired-${workspace}')`], { capture: true });
    const [stalePresence, oldEvents, expiredRateLimitBuckets] = retentionCounts.stdout.trim().split(',').map(Number);
    if (stalePresence !== 0) throw new Error(`stale presence remained after cleanup: ${stalePresence}`);
    if (oldEvents !== 0) throw new Error(`old events remained after cleanup: ${oldEvents}`);
    if (expiredRateLimitBuckets !== 0) throw new Error(`expired rate limit buckets remained after cleanup: ${expiredRateLimitBuckets}`);
    report.steps.push({ id: 'cleanup-retention', status: 'passed', expiredShareStatus: expiredResponse.status, stalePresence, oldEvents, expiredRateLimitBuckets });

    report.verdict = 'passed';
    report.finishedAt = new Date().toISOString();
    await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (mesh) await mesh.stop().catch(() => {});
    if (!args.keep) await run('docker', ['rm', '-f', name], { capture: true }).catch(() => {});
  }
  if (report.verdict !== 'passed') process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
