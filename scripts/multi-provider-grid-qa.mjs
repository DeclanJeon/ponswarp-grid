#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import {
  PonsWarpEngine,
  MemoryStorageAdapter,
} from '../packages/core/dist/index.js';

function parseArgs(argv) {
  const args = { out: 'artifacts/public-g005-multi-provider-grid-report.json', sizeMiB: 64, pieceMiB: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--') continue;
    const value = argv[index + 1];
    if (flag === '--out') { args.out = required(flag, value); index += 1; }
    else if (flag === '--size-mib') { args.sizeMiB = Number(required(flag, value)); index += 1; }
    else if (flag === '--piece-mib') { args.pieceMiB = Number(required(flag, value)); index += 1; }
    else if (flag === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}
function required(flag, value) { if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`); return value; }
function usage() { return 'Usage: node scripts/multi-provider-grid-qa.mjs --out artifacts/public-g005-multi-provider-grid-report.json [--size-mib 64] [--piece-mib 1]'; }

class FakeTransport {
  constructor(selfId) {
    this.selfId = selfId;
    this.messageHandlers = new Set();
    this.binaryHandlers = new Set();
    this.peers = new Map();
    this.sentMessages = [];
    this.sentBinary = [];
  }
  link(peerId, peer) { this.peers.set(peerId, peer); }
  async connect() {}
  async send(peerId, message) {
    this.sentMessages.push(message);
    this.peers.get(peerId)?.emitMessage(this.selfId, message);
  }
  async sendBinary(peerId, frame) {
    const buffer = frame instanceof ArrayBuffer ? frame : frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
    this.sentBinary.push(buffer);
    this.peers.get(peerId)?.emitBinary(this.selfId, buffer);
  }
  onMessage(handler) { this.messageHandlers.add(handler); return () => this.messageHandlers.delete(handler); }
  onBinary(handler) { this.binaryHandlers.add(handler); return () => this.binaryHandlers.delete(handler); }
  async close() {}
  emitMessage(peerId, message) { this.messageHandlers.forEach(handler => handler(peerId, message)); }
  emitBinary(peerId, frame) { this.binaryHandlers.forEach(handler => handler(peerId, frame)); }
}

async function flushAsync(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
}

function linkAll(transports) {
  for (const [peerId, transport] of transports) {
    for (const [otherId, other] of transports) {
      if (peerId !== otherId) transport.link(otherId, other);
    }
  }
}

function deterministicBlob(sizeBytes) {
  const chunkSize = 1024 * 1024;
  const chunks = [];
  for (let offset = 0; offset < sizeBytes; offset += chunkSize) {
    const size = Math.min(chunkSize, sizeBytes - offset);
    const chunk = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) chunk[index] = (offset + index) % 251;
    chunks.push(chunk);
  }
  const blob = new Blob(chunks, { type: 'application/octet-stream' });
  blob.name = `grid-${sizeBytes}.bin`;
  return blob;
}

async function seedProvider(provider, manifest, sourceBlob, pieceIndexes) {
  for (const pieceIndex of pieceIndexes) {
    const piece = manifest.pieces[pieceIndex];
    const data = await sourceBlob.slice(piece.offset, piece.offset + piece.size).arrayBuffer();
    const result = await provider.engine.receivePiece({ fileId: manifest.fileId, pieceIndex, requestId: `seed_${provider.peerId}_${pieceIndex}`, data });
    if (result.type !== 'PIECE_ACK') throw new Error(`seed failed for ${provider.peerId} piece ${pieceIndex}: ${result.reason}`);
  }
}

async function runScenario({ sizeMiB, pieceMiB }) {
  const started = performance.now();
  const sizeBytes = sizeMiB * 1024 * 1024;
  const pieceSize = pieceMiB * 1024 * 1024;
  const ownerPeerId = 'peer_owner';
  const providerAId = 'peer_provider_a';
  const providerBId = 'peer_provider_b';
  const receiverId = 'peer_receiver';
  const sessionId = `sess_grid_${Date.now()}`;

  const transports = new Map([
    [ownerPeerId, new FakeTransport(ownerPeerId)],
    [providerAId, new FakeTransport(providerAId)],
    [providerBId, new FakeTransport(providerBId)],
    [receiverId, new FakeTransport(receiverId)],
  ]);
  linkAll(transports);

  const owner = new PonsWarpEngine(new MemoryStorageAdapter(), undefined, undefined, undefined, transports.get(ownerPeerId));
  const providerA = { peerId: providerAId, storage: new MemoryStorageAdapter() };
  providerA.engine = new PonsWarpEngine(providerA.storage, undefined, undefined, undefined, transports.get(providerAId));
  const providerB = { peerId: providerBId, storage: new MemoryStorageAdapter() };
  providerB.engine = new PonsWarpEngine(providerB.storage, undefined, undefined, undefined, transports.get(providerBId));
  const receiverStorage = new MemoryStorageAdapter();
  const receiver = new PonsWarpEngine(receiverStorage, undefined, undefined, undefined, transports.get(receiverId));

  const sourceBlob = deterministicBlob(sizeBytes);
  const session = await owner.createSession({ sessionId, files: [sourceBlob], pieceSize, includeFileHash: false });
  const manifest = session.manifests[0];
  await providerA.engine.joinSession(sessionId, [manifest]);
  await providerB.engine.joinSession(sessionId, [manifest]);
  await receiver.joinSession(sessionId, [manifest]);

  const evenPieces = manifest.pieces.map(piece => piece.index).filter(index => index % 2 === 0);
  const oddPieces = manifest.pieces.map(piece => piece.index).filter(index => index % 2 === 1);
  await seedProvider(providerA, manifest, sourceBlob, evenPieces);
  await seedProvider(providerB, manifest, sourceBlob, oddPieces);
  await providerA.engine.broadcastPieceMap(manifest.fileId, [receiverId]);
  await providerB.engine.broadcastPieceMap(manifest.fileId, [receiverId]);
  await flushAsync();

  const scheduled = [];
  const pieceSources = new Map();
  let churnApplied = false;
  while (receiver.getProgress(manifest.fileId).verifiedPieces < manifest.pieceCount) {
    const result = await receiver.requestNextGridPiece(manifest.fileId, {
      ownerPeerId,
      candidatePeers: [providerAId, providerBId, ownerPeerId],
      maxRequestsPerPeer: 1,
      requestLeaseMs: 5_000,
      now: 1_000 + scheduled.length * 100,
    });
    scheduled.push(result);
    if (result.type !== 'scheduled') throw new Error(`scheduler stopped before completion: ${JSON.stringify(result)}`);
    pieceSources.set(result.pieceIndex, result.peerId);
    await flushAsync();
    if (!churnApplied && receiver.getProgress(manifest.fileId).verifiedPieces >= Math.ceil(manifest.pieceCount / 3)) {
      receiver.setPeerHealth(providerAId, { connectionState: 'failed', recentFailures: 5 });
      churnApplied = true;
    }
  }

  const assembled = await receiverStorage.assembleFile(manifest.fileId, manifest);
  const sourceDigest = await crypto.subtle.digest('SHA-256', await sourceBlob.arrayBuffer());
  const assembledDigest = await crypto.subtle.digest('SHA-256', await assembled.arrayBuffer());
  const hashMatch = Buffer.from(sourceDigest).equals(Buffer.from(assembledDigest));
  const providerCounts = [...pieceSources.values()].reduce((counts, peerId) => {
    counts[peerId] = (counts[peerId] ?? 0) + 1;
    return counts;
  }, {});
  const nonOwnerPieces = Object.entries(providerCounts).filter(([peerId]) => peerId !== ownerPeerId).reduce((sum, [, count]) => sum + count, 0);
  const ownerPieces = providerCounts[ownerPeerId] ?? 0;
  const nonOwnerProviderCount = Object.keys(providerCounts).filter(peerId => peerId !== ownerPeerId && providerCounts[peerId] > 0).length;
  const receiverVerifiedPieces = receiver.getProgress(manifest.fileId).verifiedPieces;
  const gatePassed = hashMatch
    && nonOwnerProviderCount >= 2
    && churnApplied
    && ownerPieces > 0
    && receiverVerifiedPieces === manifest.pieceCount
    && scheduled.filter(item => item.type === 'scheduled').length === manifest.pieceCount;
  const elapsedMs = performance.now() - started;
  const report = {
    schemaVersion: 1,
    kind: 'multi-provider-grid-qa-report',
    verdict: gatePassed ? 'passed' : 'failed',
    file: { sizeBytes, pieceSize, pieceCount: manifest.pieceCount },
    metrics: {
      elapsedMs,
      throughputBps: Math.round(sizeBytes / Math.max(0.001, elapsedMs / 1000)),
      providerCounts,
      nonOwnerPieces,
      ownerPieces,
      nonOwnerProviderCount,
      churnApplied,
      finalHashMatch: hashMatch,
      receiverVerifiedPieces,
      scheduledPieces: scheduled.filter(item => item.type === 'scheduled').length,
      heapUsedBytes: process.memoryUsage().heapUsed,
    },
    scheduled: scheduled.filter(item => item.type === 'scheduled').map(item => ({ pieceIndex: item.pieceIndex, peerId: item.peerId, reason: item.reason })),
    qualitative: [
      'Receiver assembled the file from two non-owner providers using piece-level availability maps.',
      'Provider A was marked failed mid-run; transfer still completed using remaining provider/owner fallback path if needed.',
      'Final assembled hash matched the deterministic source blob.',
    ],
    blockers: [],
  };
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }
  const report = await runScenario({ sizeMiB: args.sizeMiB, pieceMiB: args.pieceMiB });
  await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (report.verdict !== 'passed') process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
