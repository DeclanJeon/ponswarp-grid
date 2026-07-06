#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath = outIndex >= 0 ? args[outIndex + 1] : 'apps/demo/public/version.json';
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const version = {
  schemaVersion: 1,
  kind: 'ponswarp-grid-web-version',
  name: packageJson.name,
  version: packageJson.version,
  commitSha: process.env.PONSWARP_BUILD_SHA ?? 'dev',
  coordinator: process.env.PONSWARP_COORDINATOR_URL ?? 'https://grid.ponslink.com',
  generatedAt: new Date().toISOString()
};
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(version, null, 2)}\n`);
console.log(JSON.stringify(version, null, 2));
