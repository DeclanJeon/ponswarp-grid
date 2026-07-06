#!/usr/bin/env node
import { performance } from 'node:perf_hooks';

const sizeBytes = Number(process.env.PONSWARP_PERF_BYTES ?? 500 * 1024 * 1024);
const pieceSize = Number(process.env.PONSWARP_PERF_PIECE_BYTES ?? 1024 * 1024);
const pieces = Math.ceil(sizeBytes / pieceSize);
const started = performance.now();
let checksum = 0;
let maxHeap = process.memoryUsage().heapUsed;
let maxRss = process.memoryUsage().rss;
let maxExternal = process.memoryUsage().external;
let maxArrayBuffers = process.memoryUsage().arrayBuffers;

const reusablePiece = Buffer.allocUnsafe(pieceSize);

for (let index = 0; index < pieces; index += 1) {
  const bytes = Math.min(pieceSize, sizeBytes - index * pieceSize);
  const piece = bytes === reusablePiece.length ? reusablePiece : reusablePiece.subarray(0, bytes);
  piece.fill(index % 251);
  checksum = (checksum + piece[0] + piece[piece.length - 1] + bytes) >>> 0;
  const usage = process.memoryUsage();
  maxHeap = Math.max(maxHeap, usage.heapUsed);
  maxRss = Math.max(maxRss, usage.rss);
  maxExternal = Math.max(maxExternal, usage.external);
  maxArrayBuffers = Math.max(maxArrayBuffers, usage.arrayBuffers);
}

const durationMs = Math.max(1, performance.now() - started);
const report = {
  schemaVersion: 1,
  kind: 'large-file-performance-report',
  sizeBytes,
  pieceSize,
  pieces,
  durationMs: Math.round(durationMs),
  throughputBps: Math.round((sizeBytes / durationMs) * 1000),
  maxHeapBytes: maxHeap,
  maxRssBytes: maxRss,
  maxExternalBytes: maxExternal,
  maxArrayBufferBytes: maxArrayBuffers,
  checksum,
  boundedMemory: maxHeap < 256 * 1024 * 1024 && maxArrayBuffers < 64 * 1024 * 1024 && maxExternal < 128 * 1024 * 1024
};
console.log(JSON.stringify(report, null, 2));
if (!report.boundedMemory) process.exitCode = 1;
