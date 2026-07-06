#!/usr/bin/env node
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const DEFAULT_TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  const args = {
    policy: 'relay',
    mode: 'candidate',
    expect: 'relay-any',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    transferBytes: 30,
    out: '',
    iceServerJson: '',
    cdpUrl: '',
    chromePath: process.env.CHROME_PATH ?? '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--') continue;
    const value = argv[index + 1];
    if (flag === '--help' || flag === '-h') {
      args.help = true;
    } else if (flag === '--ice-server-json') {
      args.iceServerJson = requiredValue(flag, value);
      index += 1;
    } else if (flag === '--policy') {
      args.policy = requiredValue(flag, value);
      index += 1;
    } else if (flag === '--mode') {
      args.mode = requiredValue(flag, value);
      index += 1;
    } else if (flag === '--expect') {
      args.expect = requiredValue(flag, value);
      index += 1;
    } else if (flag === '--timeout-ms') {
      args.timeoutMs = Number(requiredValue(flag, value));
      index += 1;
    } else if (flag === '--transfer-bytes') {
      args.transferBytes = Number(requiredValue(flag, value));
      index += 1;
    } else if (flag === '--out') {
      args.out = requiredValue(flag, value);
      index += 1;
    } else if (flag === '--cdp-url') {
      args.cdpUrl = requiredValue(flag, value);
      index += 1;
    } else if (flag === '--chrome-path') {
      args.chromePath = requiredValue(flag, value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return args;
}

function requiredValue(flag, value) {
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function usage() {
  return `Usage: pnpm turn:diagnose -- --ice-server-json '<json-or-path>' [options]\n\nOptions:\n  --policy relay|all             ICE transport policy. Default: relay\n  --mode candidate|transfer      Candidate-only or datachannel transfer. Default: candidate\n  --expect relay-any|relay-udp|relay-tcp\n  --timeout-ms 30000\n  --transfer-bytes 30\n  --out artifacts/public-g001-turn-tcp-tls-report.json\n  --cdp-url http://127.0.0.1:9222  Use an existing Chrome DevTools endpoint\n  --chrome-path /path/to/chrome      Launch this Chrome/Chromium binary\n\nThe report is intentionally strict: relay UDP proves relay reachability, but only relay TCP/TLS evidence can close the TCP/TLS-only public-production gate.`;
}

async function readIceServers(input) {
  if (!input) throw new Error('--ice-server-json is required');
  let raw = input;
  if (!input.trim().startsWith('{') && !input.trim().startsWith('[')) {
    raw = await readFile(input, 'utf8');
  }
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.iceServers)) return parsed.iceServers;
  if (Array.isArray(parsed.servers)) return parsed.servers;
  throw new Error('ICE JSON must be an array or an object with iceServers/servers array');
}

async function findChrome(explicit) {
  const candidates = [
    explicit,
    process.env.PONSWARP_CHROME_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep searching
    }
  }
  throw new Error('Chrome/Chromium not found. Pass --cdp-url or --chrome-path.');
}

async function launchChrome(chromePath) {
  const userDataDir = await mkdtemp(join(tmpdir(), 'ponswarp-turn-diag-'));
  const child = spawn(chromePath, [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let buffer = '';
  const cdpUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for Chrome DevTools endpoint')), 10_000);
    child.stderr.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        const url = new URL(match[1]);
        resolve(`http://${url.host}`);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited before DevTools endpoint was ready (code ${code})`));
    });
  });

  return {
    cdpUrl,
    async close() {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

async function createTab(cdpUrl) {
  const base = cdpUrl.replace(/\/$/, '');
  let response = await fetch(`${base}/json/new?about:blank`, { method: 'PUT' });
  if (!response.ok) response = await fetch(`${base}/json/new?about:blank`);
  if (!response.ok) throw new Error(`Failed to create CDP tab: ${response.status}`);
  const tab = await response.json();
  return tab.webSocketDebuggerUrl;
}

function makeCdpClient(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });
  return {
    async send(method, params = {}) {
      await opened;
      const requestId = ++id;
      socket.send(JSON.stringify({ id: requestId, method, params }));
      return await new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        setTimeout(() => {
          if (pending.delete(requestId)) reject(new Error(`CDP command timed out: ${method}`));
        }, 30_000);
      });
    },
    close() {
      socket.close();
    },
  };
}

function browserDiagnosticSource({ iceServers, policy, mode, timeoutMs, transferBytes }) {
  return `(${async function runTurnDiagnostic(input) {
    const startedAt = new Date().toISOString();
    const startedMonotonicMs = performance.now();
    const startedHeapBytes = performance.memory?.usedJSHeapSize;
    const pc1 = new RTCPeerConnection({ iceServers: input.iceServers, iceTransportPolicy: input.policy });
    const pc2 = new RTCPeerConnection({ iceServers: input.iceServers, iceTransportPolicy: input.policy });
    const candidates = { pc1: [], pc2: [] };
    const errors = [];
    let receivedBytes = 0;
    let channelOpened = false;

    pc1.onicecandidate = (event) => {
      if (event.candidate) {
        candidates.pc1.push(event.candidate.candidate);
        pc2.addIceCandidate(event.candidate).catch((error) => errors.push(String(error)));
      }
    };
    pc2.onicecandidate = (event) => {
      if (event.candidate) {
        candidates.pc2.push(event.candidate.candidate);
        pc1.addIceCandidate(event.candidate).catch((error) => errors.push(String(error)));
      }
    };

    const dc1 = pc1.createDataChannel('ponswarp-turn-diagnostic');
    pc2.ondatachannel = (event) => {
      event.channel.onmessage = (message) => {
        if (message.data instanceof ArrayBuffer) receivedBytes += message.data.byteLength;
        else if (message.data instanceof Blob) receivedBytes += message.data.size;
        else receivedBytes += String(message.data).length;
      };
    };
    dc1.onopen = () => {
      channelOpened = true;
      if (input.mode === 'transfer') {
        const payload = new Uint8Array(input.transferBytes);
        for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
        dc1.send(payload);
      }
    };

    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);
    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);

    const waitUntil = Date.now() + input.timeoutMs;
    while (Date.now() < waitUntil) {
      const connected = ['connected', 'completed'].includes(pc1.iceConnectionState)
        && ['connected', 'completed'].includes(pc2.iceConnectionState);
      const transferDone = input.mode !== 'transfer' || receivedBytes >= input.transferBytes;
      if (connected && channelOpened && transferDone) break;
      if (['failed', 'closed'].includes(pc1.iceConnectionState) || ['failed', 'closed'].includes(pc2.iceConnectionState)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    async function selectedPair(pc) {
      const stats = await pc.getStats();
      let pair = undefined;
      for (const stat of stats.values()) {
        if (stat.type === 'candidate-pair' && (stat.nominated || stat.selected || stat.state === 'succeeded')) {
          if (!pair || stat.bytesSent + stat.bytesReceived > pair.bytesSent + pair.bytesReceived) pair = stat;
        }
      }
      if (!pair) return undefined;
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      return {
        state: pair.state,
        nominated: Boolean(pair.nominated),
        bytesSent: pair.bytesSent ?? 0,
        bytesReceived: pair.bytesReceived ?? 0,
        localCandidateType: local?.candidateType,
        localProtocol: local?.protocol ?? local?.relayProtocol,
        localRelayProtocol: local?.relayProtocol,
        localAddress: local?.address ?? local?.ip,
        localPort: local?.port,
        remoteCandidateType: remote?.candidateType,
        remoteProtocol: remote?.protocol ?? remote?.relayProtocol,
        remoteRelayProtocol: remote?.relayProtocol,
      };
    }

    const selectedCandidatePair = await selectedPair(pc1);
    const durationMs = Math.max(1, performance.now() - startedMonotonicMs);
    const finishedHeapBytes = performance.memory?.usedJSHeapSize;
    const transfer = input.mode === 'transfer'
      ? {
          requestedBytes: input.transferBytes,
          receivedBytes,
          complete: receivedBytes >= input.transferBytes,
          durationMs,
          throughputBps: Math.round(receivedBytes / Math.max(0.001, durationMs / 1000))
        }
      : undefined;
    pc1.close();
    pc2.close();

    return {
      schemaVersion: 1,
      kind: 'turn-diagnostic-report',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs,
      mode: input.mode,
      iceTransportPolicy: input.policy,
      candidateCounts: { pc1: candidates.pc1.length, pc2: candidates.pc2.length },
      candidates,
      selectedCandidatePair,
      transfer,
      memory: {
        startedHeapBytes: startedHeapBytes ?? null,
        finishedHeapBytes: finishedHeapBytes ?? null,
        heapDeltaBytes: typeof startedHeapBytes === 'number' && typeof finishedHeapBytes === 'number' ? finishedHeapBytes - startedHeapBytes : null
      },
      connectionStates: { pc1: pc1.iceConnectionState, pc2: pc2.iceConnectionState },
      errors,
    };
  }})( ${JSON.stringify({ iceServers, policy, mode, timeoutMs, transferBytes })} )`;
}

function classify(report, expected) {
  const pair = report.selectedCandidatePair;
  const localType = pair?.localCandidateType;
  const protocol = String(pair?.localProtocol ?? '').toLowerCase();
  const relayProtocol = String(pair?.localRelayProtocol ?? '').toLowerCase();
  const transportProof = relayProtocol || protocol;
  const transferComplete = Boolean(report.transfer?.complete);
  const transferOk = !report.transfer || transferComplete;
  const relayOk = localType === 'relay' && transferOk;
  const strictRelayTransfer = report.iceTransportPolicy === 'relay' && transferComplete;
  const expectedOk = expected === 'relay-any'
    ? relayOk
    : expected === 'relay-udp'
      ? relayOk && transportProof === 'udp'
      : expected === 'relay-tcp'
        ? relayOk && strictRelayTransfer && (protocol === 'tcp' || relayProtocol === 'tcp' || relayProtocol === 'tls')
        : false;
  return {
    expected,
    observedProtocol: protocol || null,
    observedRelayProtocol: relayProtocol || null,
    relayOk,
    transferOk,
    verdict: expectedOk ? 'passed' : relayOk ? 'inconclusive' : 'failed',
    productionInterpretation: expectedOk
      ? 'Requested TURN path is validated for this environment.'
      : relayOk
        ? 'Relay works, but this is not TCP/TLS-only proof for public production.'
        : 'TURN relay path did not complete in this environment.',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!['relay', 'all'].includes(args.policy)) throw new Error('--policy must be relay or all');
  if (!['candidate', 'transfer'].includes(args.mode)) throw new Error('--mode must be candidate or transfer');
  if (!['relay-any', 'relay-udp', 'relay-tcp'].includes(args.expect)) throw new Error('--expect must be relay-any, relay-udp, or relay-tcp');
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error('--timeout-ms must be positive');
  if (!Number.isFinite(args.transferBytes) || args.transferBytes <= 0) throw new Error('--transfer-bytes must be positive');

  const iceServers = await readIceServers(args.iceServerJson);
  let launcher;
  const cdpUrl = args.cdpUrl || (launcher = await launchChrome(await findChrome(args.chromePath))).cdpUrl;
  const wsUrl = await createTab(cdpUrl);
  const cdp = makeCdpClient(wsUrl);
  try {
    await cdp.send('Runtime.enable');
    const result = await cdp.send('Runtime.evaluate', {
      expression: browserDiagnosticSource({ iceServers, policy: args.policy, mode: args.mode, timeoutMs: args.timeoutMs, transferBytes: args.transferBytes }),
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Browser diagnostic failed');
    const report = result.result.value;
    report.classification = classify(report, args.expect);
    report.verdict = report.classification.verdict;
    const rendered = JSON.stringify(report, null, 2);
    if (args.out) await writeFile(args.out, `${rendered}\n`);
    console.log(rendered);
    if (report.verdict === 'failed') process.exitCode = 1;
  } finally {
    cdp.close();
    if (launcher) await launcher.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
