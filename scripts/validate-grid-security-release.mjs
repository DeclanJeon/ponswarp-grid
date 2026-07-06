#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath = outIndex >= 0 ? args[outIndex + 1] : 'artifacts/grid-security-release-validation-report.json';

const checks = [];
function pass(id, evidence) { checks.push({ id, status: 'passed', evidence }); }
function fail(id, evidence) { checks.push({ id, status: 'failed', evidence }); }
function includesAll(id, text, needles) {
  const missing = needles.filter(needle => !text.includes(needle));
  if (missing.length === 0) pass(id, `Found ${needles.join(', ')}`);
  else fail(id, `Missing ${missing.join(', ')}`);
}
function assertTrue(id, condition, evidence, failure) {
  if (condition) pass(id, evidence);
  else fail(id, failure);
}

function locationBlock(text, name) {
  const start = name === '/'
    ? text.indexOf('location / {')
    : text.indexOf(`location ${name}`);
  if (start < 0) return '';
  const open = text.indexOf('{', start);
  if (open < 0) return '';
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return '';
}

const env = await readFile('deploy/grid.ponslink.env.example', 'utf8');
const nginx = await readFile('deploy/grid.ponslink.nginx.conf', 'utf8');
const checklist = await readFile('deploy/grid-security-release-checklist.md', 'utf8');
const cliIndex = await readFile('packages/cli/src/index.ts', 'utf8');
const cliRuntime = await readFile('packages/cli/src/coordinator-runtime.ts', 'utf8');
const versionScript = await readFile('scripts/generate-grid-version.mjs', 'utf8');
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const generatedVersion = JSON.parse(await readFile('apps/demo/public/version.json', 'utf8'));
const requiredSecurityHeaders = [
  'Strict-Transport-Security',
  'Content-Security-Policy',
  'X-Content-Type-Options',
  'Referrer-Policy',
  'Permissions-Policy',
  'Cross-Origin-Opener-Policy'
];

includesAll('secret-inventory', checklist, [
  'PONSWARP_MESH_DATABASE_URL',
  'PONSWARP_MESH_ADMIN_API_TOKEN',
  'PONSWARP_NODE_TOKEN_PEPPER',
  'PONSWARP_TURN_STATIC_AUTH_SECRET',
  'Rotation',
  'Redaction requirement'
]);
includesAll('env-placeholders-not-real-secrets', env, [
  'REPLACE_ME',
  'REPLACE_WITH_SECRET',
  'PONSWARP_BUILD_SHA=REPLACE_WITH_GIT_SHA'
]);
const databaseUrlLine = env.split('\n').find(line => line.startsWith('PONSWARP_MESH_DATABASE_URL='));
assertTrue(
  'env-database-url-placeholder',
  typeof databaseUrlLine === 'string' && /REPLACE_ME|\.\.\./.test(databaseUrlLine),
  'Database URL uses a placeholder password.',
  'Database URL must use a placeholder password, not a raw credential.'
);
for (const secretName of ['PONSWARP_MESH_ADMIN_API_TOKEN', 'PONSWARP_NODE_TOKEN_PEPPER', 'PONSWARP_TURN_STATIC_AUTH_SECRET']) {
  const line = env.split('\n').find(value => value.startsWith(`${secretName}=`));
  assertTrue(
    `env-${secretName.toLowerCase()}-placeholder`,
    line === `${secretName}=REPLACE_WITH_SECRET`,
    `${secretName} uses REPLACE_WITH_SECRET placeholder.`,
    `${secretName} must use REPLACE_WITH_SECRET placeholder.`
  );
}
includesAll('security-headers', nginx, requiredSecurityHeaders);
for (const [id, name] of [['security-headers-version-location', '= /version.json'], ['security-headers-assets-location', '/assets/'], ['security-headers-root-location', '/']]) {
  includesAll(id, locationBlock(nginx, name), requiredSecurityHeaders);
}
includesAll('cache-version-policy', nginx, [
  'location /assets/',
  'public, max-age=31536000, immutable',
  'location = /version.json',
  'proxy_pass http://ponswarp_grid_web/version.json',
  'Cache-Control "no-cache"'
]);
includesAll('version-generation', versionScript, [
  "kind: 'ponswarp-grid-web-version'",
  "process.env.PONSWARP_BUILD_SHA ?? 'dev'",
  "process.env.PONSWARP_COORDINATOR_URL ?? 'https://grid.ponslink.com'"
]);
assertTrue(
  'generated-version-schema',
  generatedVersion.kind === 'ponswarp-grid-web-version' &&
    generatedVersion.name === packageJson.name &&
    generatedVersion.version === packageJson.version &&
    generatedVersion.coordinator === 'https://grid.ponslink.com' &&
    typeof generatedVersion.generatedAt === 'string',
  'Generated web version metadata has expected name/version/coordinator/generatedAt schema.',
  'Generated web version metadata is missing required schema fields.'
);
assertTrue('package-version-script', packageJson.scripts['grid:version'] === 'node scripts/generate-grid-version.mjs', 'package.json exposes grid:version script.', 'package.json must expose grid:version script.');
includesAll('cli-coordinator-compatibility', `${cliIndex}\n${cliRuntime}`, [
  "https://grid.ponslink.com",
  '/api/grid/v1/workspaces',
  '/api/grid/v1/shares'
]);

const report = {
  schemaVersion: 1,
  kind: 'grid-security-release-validation-report',
  verdict: checks.every(check => check.status === 'passed') ? 'passed' : 'failed',
  checkedAt: new Date().toISOString(),
  checks
};
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (report.verdict !== 'passed') process.exitCode = 1;
