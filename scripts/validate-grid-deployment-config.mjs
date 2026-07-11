#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath = outIndex >= 0 ? args[outIndex + 1] : 'artifacts/grid-deployment-config-validation-report.json';

const checks = [];
function pass(id, evidence) { checks.push({ id, status: 'passed', evidence }); }
function fail(id, evidence) { checks.push({ id, status: 'failed', evidence }); }
function includesAll(id, text, needles) {
  const missing = needles.filter(needle => !text.includes(needle));
  if (missing.length === 0) pass(id, `Found ${needles.join(', ')}`);
  else fail(id, `Missing ${missing.join(', ')}`);
}

function uncommented(text) {
  return text
    .split('\n')
    .map(line => line.replace(/\s+#.*$/, '').trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
    .join('\n');
}

function assertTrue(id, condition, evidence, failure) {
  if (condition) pass(id, evidence);
  else fail(id, failure);
}
function parseExactHoldOneConfig(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value).sort();
    const direct = value.directTransfer;
    return JSON.stringify(keys) === JSON.stringify(['directTransfer', 'schema'])
      && value.schema === 'ponswarp-grid.runtime-config/v1'
      && direct
      && typeof direct === 'object'
      && !Array.isArray(direct)
      && JSON.stringify(Object.keys(direct).sort()) === JSON.stringify(['allowDiagnosticWindow2', 'hold', 'qaBuild', 'rolloutId', 'window'])
      && direct.window === 1
      && direct.hold === true
      && direct.qaBuild === false
      && direct.allowDiagnosticWindow2 === false
      && direct.rolloutId === 'hold-1';
  } catch {
    return false;
  }
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

const env = await readFile('deploy/grid.ponslink.env.example', 'utf8');
const nginx = await readFile('deploy/grid.ponslink.nginx.conf', 'utf8');
const coordinatorSystemd = await readFile('deploy/ponswarp-grid-coordinator.service', 'utf8');
const webSystemd = await readFile('deploy/ponswarp-grid-web.service', 'utf8');
const cliIndex = await readFile('packages/cli/src/index.ts', 'utf8');
const signalingServer = await readFile('packages/signaling/src/server.ts', 'utf8');
const runtimeConfig = await readOptional('apps/demo/public/runtime-config.json');
const runtimeConfigExample = await readOptional('deploy/ponswarp-grid-runtime-config.json.example');
const transferReleaseConfig = await readOptional('apps/demo/src/transfer-release-config.ts');

const activeNginx = uncommented(nginx);
includesAll('env-grid-domain', env, [
  'PONSWARP_MESH_PUBLIC_BASE_URL=https://grid.ponslink.com',
  'PONSWARP_MESH_LEGACY_BASE_URL=https://warp.ponslink.com',
  'PONSWARP_MESH_DB_SCHEMA=grid',
  'PONSWARP_WEB_SHOW_QA_CONTROLS=false'
]);
includesAll('env-secret-placeholders', env, [
  'PONSWARP_MESH_ADMIN_API_TOKEN=REPLACE_WITH_SECRET',
  'PONSWARP_NODE_TOKEN_PEPPER=REPLACE_WITH_SECRET',
  'PONSWARP_TURN_STATIC_AUTH_SECRET=REPLACE_WITH_SECRET'
]);
includesAll('nginx-grid-routes', activeNginx, [
  'server_name grid.ponslink.com',
  'location /api/grid/v1/',
  'location /ws/grid/',
  'location = /healthz',
  'location = /readyz'
]);
if (runtimeConfig !== null || runtimeConfigExample !== null || transferReleaseConfig !== null) {
  includesAll('nginx-runtime-config-route', activeNginx, [
    'location = /runtime-config.json',
    'alias /etc/ponswarp-grid/web-runtime-config.json;',
    'default_type application/json;',
    'add_header Cache-Control "no-store, max-age=0" always;',
    'add_header X-Content-Type-Options "nosniff" always;'
  ]);
  assertTrue(
    'runtime-config-exact-hold-1',
    runtimeConfig !== null && runtimeConfigExample !== null
      && parseExactHoldOneConfig(runtimeConfig) && parseExactHoldOneConfig(runtimeConfigExample),
    'Bundled and deployment runtime configs use the exact ponswarp-grid.runtime-config/v1 hold-1 object.',
    'Runtime configs must include the strict hold/window/QA authorization/rollout fields; malformed, missing, extra, or window-2 values fail validation.'
  );
  assertTrue(
    'runtime-config-fail-closed-window-1',
    transferReleaseConfig !== null
      && transferReleaseConfig.includes('DEFAULT_TRANSFER_WINDOW = 1;')
      && transferReleaseConfig.includes('return DEFAULT_TRANSFER_WINDOW;')
      && transferReleaseConfig.includes('return null;'),
    'Runtime config parsing and resolution retain window-1 fallback on invalid or unavailable config.',
    'Runtime config handling must fail closed to transfer window 1 when config is malformed or unavailable.'
  );
}
assertTrue(
  'nginx-legacy-isolation',
  !activeNginx.includes('warp.ponslink.com') && !activeNginx.includes('location /ws ') && !activeNginx.includes('location /ws{'),
  'Active nginx directives contain no warp.ponslink.com server/proxy target and no legacy /ws location in the grid server block.',
  'Active nginx directives must not include warp.ponslink.com or legacy /ws routes in the grid server block.'
);
includesAll('nginx-security-cache', nginx, [
  'Strict-Transport-Security',
  'Content-Security-Policy',
  'X-Content-Type-Options',
  'Referrer-Policy',
  'Cache-Control "public, max-age=31536000, immutable"',
  'Cache-Control "no-cache"'
]);
includesAll('systemd-isolated-service', coordinatorSystemd, [
  'Description=PonsWarp Grid Coordinator for grid.ponslink.com',
  'EnvironmentFile=/etc/ponswarp/grid.ponslink.env',
  '--port 8788',
  'Restart=on-failure',
  'NoNewPrivileges=true'
]);
includesAll('systemd-web-static-service', webSystemd, [
  'Description=PonsWarp Grid static web for grid.ponslink.com',
  'WorkingDirectory=/home/declan/ponswarp-grid-web/current',
  'ExecStart=/usr/bin/python3 -m http.server 4180 --bind 127.0.0.1',
  'Restart=on-failure',
  'NoNewPrivileges=true'
]);
if (runtimeConfig !== null || runtimeConfigExample !== null || transferReleaseConfig !== null) {
  includesAll('systemd-web-runtime-config', webSystemd, [
    '/etc/ponswarp-grid/web-runtime-config.json',
    'install -d -o root -g root -m 0755 /etc/ponswarp-grid',
    'install -o root -g root -m 0644',
    'ExecStartPre=/usr/bin/test -s /etc/ponswarp-grid/web-runtime-config.json',
    'Atomic replacement or rollback:'
  ]);
}
includesAll('cli-default-grid', cliIndex, [
  "process.env.PONSWARP_COORDINATOR_URL ?? 'https://grid.ponslink.com'"
]);
includesAll('cli-grid-api-prefix', await readFile('packages/cli/src/coordinator-runtime.ts', 'utf8'), [
  '/api/grid/v1/workspaces',
  '/api/grid/v1/shares'
]);
includesAll('health-ready-version-surface', signalingServer, [
  "request.url === '/healthz'",
  "request.url === '/readyz'",
  "request.url === '/version.json'",
  "request.url === '/api/grid/v1/ice'",
  "isGridWebSocketPath(request.url)",
  "url === '/ws/grid'",
  "expectedExternalService: 'ponswarp-grid-coordinator'",
  "legacyDomain: 'warp.ponslink.com'",
  "ready ? 200 : 503",
  "status: ready ? 'ready' : 'not_ready'"
]);

const report = {
  schemaVersion: 1,
  kind: 'grid-deployment-config-validation-report',
  verdict: checks.every(check => check.status === 'passed') ? 'passed' : 'failed',
  checkedAt: new Date().toISOString(),
  checks
};

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (report.verdict !== 'passed') process.exitCode = 1;
