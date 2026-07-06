#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';

function parseArgs(argv) {
  const args = { signal: 'wss://warp.ponslink.com/ws', room: `turn_diag_${Date.now()}`, out: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--') continue;
    const value = argv[index + 1];
    if (flag === '--signal') {
      args.signal = required(flag, value);
      index += 1;
    } else if (flag === '--room') {
      args.room = required(flag, value);
      index += 1;
    } else if (flag === '--out') {
      args.out = required(flag, value);
      index += 1;
    } else if (flag === '--help' || flag === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return args;
}

function required(flag, value) {
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function usage() {
  return `Usage: node scripts/fetch-turn-ice.mjs --out artifacts/.turn-ice.json [--signal wss://warp.ponslink.com/ws] [--room turn_diag]\n\nWrites temporary ICE server credentials for diagnostics. The output file is secret material and must not be committed.`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.out) throw new Error('--out is required');
  const socket = new WebSocket(args.signal);
  const turnConfig = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for TURN config')), 15_000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'RequestTurnConfig', payload: { room_id: args.room, force_refresh: true } }));
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'TurnConfig') {
        clearTimeout(timer);
        if (!message.payload?.success) reject(new Error(message.payload?.error || 'TURN config request failed'));
        else resolve(message.payload.data);
      }
    });
    socket.addEventListener('error', (event) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error while requesting TURN config: ${event.message || 'unknown'}`));
    });
  });
  socket.close();
  await writeFile(args.out, `${JSON.stringify({ iceServers: turnConfig.ice_servers }, null, 2)}\n`, { mode: 0o600 });
  const urls = turnConfig.ice_servers.flatMap((server) => server.urls ?? []);
  console.log(JSON.stringify({ ok: true, room: args.room, iceServerCount: turnConfig.ice_servers.length, urls }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
