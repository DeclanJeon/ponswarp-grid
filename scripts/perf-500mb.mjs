#!/usr/bin/env node
import { performance } from 'node:perf_hooks';

const sizeBytes = Number(process.env.PONSWARP_PERF_BYTES ?? 500 * 1024 * 1024);
const pieceSize = Number(process.env.PONSWARP_PERF_PIECE_BYTES ?? 1024 * 1024);
const pieces = Math.ceil(sizeBytes / pieceSize);
const started = performance.now();
let checksum = 0;
let maxHeap = process.memoryUsage().heapUsed;

for (let index = 0; index < pieces; index += 1) {
  const bytes = Math.min(pieceSize, sizeBytes - index * pieceSize);
  const piece = Buffer.allocUnsafe(bytes);
  piece.fill(index % 251);
  checksum = (checksum + piece[0] + piece[piece.length - 1] + bytes) >>> 0;
  maxHeap = Math.max(maxHeap, process.memoryUsage().heapUsed);
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
  checksum,
  boundedMemory: maxHeap < 256 * 1024 * 1024
};
console.log(JSON.stringify(report, null, 2));
if (!report.boundedMemory) process.exitCode = 1;
