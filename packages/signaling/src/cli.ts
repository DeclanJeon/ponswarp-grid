#!/usr/bin/env node
import { createSignalingHttpServer, DEFAULT_SIGNALING_SERVER_CONFIG, type SignalingServerConfig } from './server.js';

function readConfig(): SignalingServerConfig {
  return {
    ...DEFAULT_SIGNALING_SERVER_CONFIG,
    host: process.env.PONSWARP_SIGNALING_HOST ?? DEFAULT_SIGNALING_SERVER_CONFIG.host,
    port: Number(process.env.PONSWARP_SIGNALING_PORT ?? DEFAULT_SIGNALING_SERVER_CONFIG.port),
    publicBaseUrl: process.env.PONSWARP_PUBLIC_BASE_URL ?? DEFAULT_SIGNALING_SERVER_CONFIG.publicBaseUrl,
    sessionTtlMs: Number(process.env.PONSWARP_SESSION_TTL_MS ?? DEFAULT_SIGNALING_SERVER_CONFIG.sessionTtlMs),
    peerTtlMs: Number(process.env.PONSWARP_PEER_TTL_MS ?? DEFAULT_SIGNALING_SERVER_CONFIG.peerTtlMs),
    maxPeersPerSession: Number(process.env.PONSWARP_MAX_PEERS_PER_SESSION ?? DEFAULT_SIGNALING_SERVER_CONFIG.maxPeersPerSession),
    maxSessions: Number(process.env.PONSWARP_MAX_SESSIONS ?? DEFAULT_SIGNALING_SERVER_CONFIG.maxSessions),
    heartbeatIntervalMs: Number(process.env.PONSWARP_HEARTBEAT_INTERVAL_MS ?? DEFAULT_SIGNALING_SERVER_CONFIG.heartbeatIntervalMs),
    stalePeerTimeoutMs: Number(process.env.PONSWARP_STALE_PEER_TIMEOUT_MS ?? DEFAULT_SIGNALING_SERVER_CONFIG.stalePeerTimeoutMs),
    allowedOrigins: (process.env.PONSWARP_ALLOWED_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean)
  };
}

const runtime = createSignalingHttpServer({ config: readConfig() });
await runtime.listen();
const address = runtime.server.address();
const renderedAddress = typeof address === 'object' && address ? `${address.address}:${address.port}` : String(address);
process.stdout.write(`PonsWarp signaling server listening on ${renderedAddress}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void runtime.close().finally(() => process.exit(0));
  });
}
