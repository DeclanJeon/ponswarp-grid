import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findDirectTransferHint, runDownload, runFiles, runGet, runNodeStart, runPublish, runShare, setDirectTransferRunnerForTest } from '../src/coordinator-runtime';

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

function testJoinDescriptor(fileId = 'file-1', size = 9): string {
  return `ponswarp://join/${Buffer.from(JSON.stringify({
    schemaVersion: 1,
    sessionId: 'sess_test',
    ownerPeerId: 'peer_owner',
    ownerEndpoint: { peerId: 'peer_owner', url: 'tcp://127.0.0.1:12345' },
    manifests: [{
      fileId,
      name: 'demo.bin',
      size,
      pieceSize: 4,
      pieceCount: Math.ceil(size / 4),
      pieces: [{ index: 0, offset: 0, size, hash: 'test' }]
    }]
  })).toString('base64url')}`;
}

const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

afterEach(() => {
  consoleSpy.mockClear();
});

describe('coordinator CLI runtime', () => {
  it('registers node start and heartbeat with the coordinator', async () => {
    const server = await startCoordinatorStub((request, response, recorded) => {
      if (request.method === 'POST' && request.url === '/api/grid/v1/workspaces') return json(response, { workspaceId: (recorded.body as { workspaceId: string }).workspaceId });
      if (request.method === 'POST' && request.url === '/api/grid/v1/workspaces/ws/nodes') return json(response, { registered: recorded.body });
      if (request.method === 'POST' && request.url === '/api/grid/v1/workspaces/ws/nodes/node-a/heartbeat') return json(response, { heartbeat: recorded.body });
      return notFound(response);
    });
    try {
      await runNodeStart({
        command: 'node-start',
        coordinator: server.origin,
        workspace: 'ws',
        nodeId: 'node-a',
        displayName: 'Node A',
        publicKey: 'ed25519:test',
        json: true,
        dryRun: false
      });

      expect(server.requests.map(request => `${request.method} ${request.path}`)).toEqual([
        'POST /api/grid/v1/workspaces',
        'POST /api/grid/v1/workspaces/ws/nodes',
        'POST /api/grid/v1/workspaces/ws/nodes/node-a/heartbeat'
      ]);
      expect(server.requests[0]?.body).toMatchObject({ workspaceId: 'ws', name: 'ws' });
      expect(server.requests[1]?.body).toMatchObject({ nodeId: 'node-a', displayName: 'Node A', publicKey: 'ed25519:test' });
      expect(JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]))).toMatchObject({ ok: true, command: 'node-start' });
      expect(server.requests[2]?.body).toMatchObject({ status: 'online', endpointHints: [] });
    } finally {
      await server.close();
    }
  });

  it('registers direct join endpoint hints for coordinator-mediated provider transfer', async () => {
    const server = await startCoordinatorStub((request, response, recorded) => {
      if (request.method === 'POST' && request.url === '/api/grid/v1/workspaces') return json(response, { workspaceId: 'ws' });
      if (request.method === 'POST' && request.url === '/api/grid/v1/workspaces/ws/nodes') return json(response, { registered: recorded.body });
      if (request.method === 'POST' && request.url === '/api/grid/v1/workspaces/ws/nodes/node-a/heartbeat') return json(response, { heartbeat: recorded.body });
      return notFound(response);
    });
    try {
      await runNodeStart({
        command: 'node-start',
        coordinator: server.origin,
        workspace: 'ws',
        nodeId: 'node-a',
        displayName: 'Node A',
        publicKey: 'ed25519:test',
        directJoin: 'ponswarp://join/provider',
        json: true,
        dryRun: false
      });

      expect(server.requests[2]?.body).toMatchObject({
        status: 'online',
        endpointHints: [{ kind: 'ponswarp-join', value: 'ponswarp://join/provider' }]
      });
    } finally {
      await server.close();
    }
  });

  it('prints node-start dry-run registration without contacting the coordinator', async () => {
    const server = await startCoordinatorStub((_request, response) => notFound(response));
    try {
      await runNodeStart({
        command: 'node-start',
        coordinator: server.origin,
        workspace: 'ws',
        nodeId: 'node-a',
        displayName: 'Node A',
        publicKey: 'ed25519:test',
        json: true,
        dryRun: true
      });

      expect(server.requests).toHaveLength(0);
      const output = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]));
      expect(output).toMatchObject({
        ok: true,
        command: 'node-start',
        dryRun: true,
        data: {
          workspace: { workspaceId: 'ws', name: 'ws' },
          registration: { nodeId: 'node-a', displayName: 'Node A', publicKey: 'ed25519:test' },
          heartbeat: { status: 'online', endpointHints: [] }
        }
      });
    } finally {
      await server.close();
    }
  });

  it('publishes dry-run metadata without contacting the coordinator', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'ponswarp-cli-runtime-'));
    const file = join(tempDir, 'demo.bin');
    await writeFile(file, Buffer.alloc(10, 7));
    const server = await startCoordinatorStub((_request, response) => notFound(response));
    try {
      await runPublish({
        command: 'publish',
        file,
        coordinator: server.origin,
        workspace: 'ws',
        nodeId: 'node-a',
        pieceSize: 4,
        json: true,
        dryRun: true
      });

      expect(server.requests).toHaveLength(0);
      const output = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]));
      expect(output).toMatchObject({ ok: true, command: 'publish', dryRun: true, data: { name: 'demo.bin', size: 10, pieceSize: 4, pieceCount: 3 } });
      expect(output.data.fileId).toMatch(/^file_[a-f0-9]{24}$/);
      expect(output.data.manifest).not.toHaveProperty('sourcePath');
    } finally {
      await server.close();
    }
  });

  it('lists files and builds a coordinator-backed download candidate plan', async () => {
    const server = await startCoordinatorStub((request, response) => {
      if (request.method === 'GET' && request.url === '/api/grid/v1/workspaces/ws/files') return json(response, { files: [{ fileId: 'file-1', name: 'demo.bin' }] });
      if (request.method === 'GET' && request.url === '/api/grid/v1/workspaces/ws/files/file-1/candidates') return json(response, { candidates: [{ nodeId: 'node-a', online: true }] });
      return notFound(response);
    });
    try {
      await runFiles({ command: 'files', coordinator: server.origin, workspace: 'ws', json: true });
      await runDownload({ command: 'download', coordinator: server.origin, workspace: 'ws', fileId: 'file-1', outDir: 'downloads', json: true, dryRun: false });

      expect(server.requests.map(request => `${request.method} ${request.path}`)).toEqual([
        'GET /api/grid/v1/workspaces/ws/files',
        'GET /api/grid/v1/workspaces/ws/files/file-1/candidates'
      ]);
      const output = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]));
      expect(output).toMatchObject({ ok: true, command: 'download', data: { fileId: 'file-1', outDir: 'downloads', status: 'planned', discovery: 'coordinator' } });
      expect(output.data.candidates).toMatchObject({ candidates: [{ nodeId: 'node-a', online: true }] });
    } finally {
      await server.close();
    }
  });

  it('prints download dry-run plan without contacting the coordinator', async () => {
    const server = await startCoordinatorStub((_request, response) => notFound(response));
    try {
      await runDownload({ command: 'download', coordinator: server.origin, workspace: 'ws', fileId: 'file-1', outDir: 'downloads', json: true, dryRun: true });

      expect(server.requests).toHaveLength(0);
      const output = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]));
      expect(output).toMatchObject({
        ok: true,
        command: 'download',
        dryRun: true,
        data: {
          fileId: 'file-1',
          outDir: 'downloads',
          status: 'planned',
          discovery: 'dry-run-skipped',
          candidates: { candidates: [] }
        }
      });
    } finally {
      await server.close();
    }
  });

  it('shares a file by creating workspace, publishing metadata, and registering a share code', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'ponswarp-cli-share-'));
    const file = join(tempDir, 'demo.bin');
    await writeFile(file, Buffer.alloc(9, 3));
    const server = await startCoordinatorStub((request, response, recorded) => {
      if (request.method === 'POST' && request.url === '/api/grid/v1/workspaces') return json(response, { workspaceId: (recorded.body as { workspaceId: string }).workspaceId });
      if (request.method === 'POST' && request.url === '/api/grid/v1/workspaces/ws/files') return json(response, { published: recorded.body });
      if (request.method === 'POST' && request.url === '/api/grid/v1/workspaces/ws/shares') return json(response, { code: '8F3K-22Q9', fileId: (recorded.body as { fileId: string }).fileId });
      return notFound(response);
    });
    try {
      await runShare({ command: 'share', coordinator: server.origin, workspace: 'ws', file, nodeId: 'node-a', pieceSize: 4, ttlSeconds: 3600, json: true, dryRun: false });

      expect(server.requests.map(request => `${request.method} ${request.path}`)).toEqual([
        'POST /api/grid/v1/workspaces',
        'POST /api/grid/v1/workspaces/ws/files',
        'POST /api/grid/v1/workspaces/ws/shares'
      ]);
      expect(server.requests[1]?.body).toMatchObject({ name: 'demo.bin', size: 9, pieceSize: 4, pieceCount: 3 });
      expect(server.requests[2]?.body).toMatchObject({ createdByNodeId: 'node-a', ttlSeconds: 3600 });
      const output = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]));
      expect(output).toMatchObject({ ok: true, command: 'share', data: { code: '8F3K-22Q9', status: 'ready', name: 'demo.bin' } });
      expect(output.data.link).toContain('/get/8F3K-22Q9');
    } finally {
      await server.close();
    }
  });

  it('resolves get share links to coordinator candidate plans', async () => {
    const server = await startCoordinatorStub((request, response) => {
      if (request.method === 'GET' && request.url === '/api/grid/v1/shares/8F3K-22Q9') return json(response, { code: '8F3K-22Q9', fileId: 'file-1', name: 'demo.bin', sizeBytes: 9 });
      if (request.method === 'GET' && request.url === '/api/grid/v1/shares/8F3K-22Q9/candidates') return json(response, { candidates: [{ nodeId: 'node-a', online: true }] });
      return notFound(response);
    });
    try {
      await runGet({ command: 'get', coordinator: server.origin, workspace: 'default', code: 'https://warp.ponslink.com/get/8f3k-22q9', outDir: 'downloads', json: true, dryRun: false });

      expect(server.requests.map(request => `${request.method} ${request.path}`)).toEqual([
        'GET /api/grid/v1/shares/8F3K-22Q9',
        'GET /api/grid/v1/shares/8F3K-22Q9/candidates'
      ]);
      const output = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]));
      expect(output).toMatchObject({ ok: true, command: 'get', data: { code: '8F3K-22Q9', fileId: 'file-1', outDir: 'downloads', discovery: 'coordinator' } });
      expect(output.data.candidates).toMatchObject({ candidates: [{ nodeId: 'node-a', online: true }] });
    } finally {
      await server.close();
    }
  });

  it('executes direct join when coordinator candidates expose a transfer hint', async () => {
    const executed: unknown[] = [];
    const restoreRunner = setDirectTransferRunnerForTest(async command => {
      executed.push(command);
      return 0;
    });
    const joinDescriptor = testJoinDescriptor('file-1', 9);
    const server = await startCoordinatorStub((request, response) => {
      if (request.method === 'GET' && request.url === '/api/grid/v1/shares/8F3K-22Q9') return json(response, { code: '8F3K-22Q9', fileId: 'file-1', name: 'demo.bin', sizeBytes: 9 });
      if (request.method === 'GET' && request.url === '/api/grid/v1/shares/8F3K-22Q9/candidates') return json(response, { providers: [{ nodeId: 'node-a', online: true, endpointHints: [{ kind: 'ponswarp-join', value: joinDescriptor, peer: 'ponswarp-peer://seed' }] }] });
      return notFound(response);
    });
    try {
      await runGet({ command: 'get', coordinator: server.origin, workspace: 'default', code: '8F3K-22Q9', outDir: 'downloads', json: true, dryRun: false });

      expect(executed).toEqual([expect.objectContaining({ command: 'join', session: joinDescriptor, peer: 'ponswarp-peer://seed', outDir: 'downloads', seedAfterComplete: false })]);
      const output = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]));
      expect(output.data).toMatchObject({ code: '8F3K-22Q9', fileId: 'file-1', name: 'demo.bin', sizeBytes: 9, outDir: 'downloads', discovery: 'coordinator', execution: 'direct-join', status: 'complete' });
    } finally {
      restoreRunner();
      await server.close();
    }
  });

  it('rejects coordinator provider descriptors that do not match resolved file metadata', async () => {
    const server = await startCoordinatorStub((request, response) => {
      if (request.method === 'GET' && request.url === '/api/grid/v1/shares/8F3K-22Q9') return json(response, { code: '8F3K-22Q9', fileId: 'file-expected', name: 'demo.bin', sizeBytes: 9 });
      if (request.method === 'GET' && request.url === '/api/grid/v1/shares/8F3K-22Q9/candidates') return json(response, { providers: [{ nodeId: 'node-a', online: true, endpointHints: [{ kind: 'ponswarp-join', value: testJoinDescriptor('file-other', 9) }] }] });
      return notFound(response);
    });
    try {
      await expect(runGet({ command: 'get', coordinator: server.origin, workspace: 'default', code: '8F3K-22Q9', outDir: 'downloads', json: true, dryRun: false })).rejects.toThrow(/file mismatch/);
    } finally {
      await server.close();
    }
  });

  it('returns an unavailable plan without executing direct join when candidates have no hint', async () => {
    const executed: unknown[] = [];
    const restoreRunner = setDirectTransferRunnerForTest(async command => {
      executed.push(command);
      return 0;
    });
    const server = await startCoordinatorStub((request, response) => {
      if (request.method === 'GET' && request.url === '/api/grid/v1/shares/8F3K-22Q9') return json(response, { code: '8F3K-22Q9', fileId: 'file-1', name: 'demo.bin', sizeBytes: 9 });
      if (request.method === 'GET' && request.url === '/api/grid/v1/shares/8F3K-22Q9/candidates') return json(response, { providers: [{ nodeId: 'node-a', online: true, endpointHints: [] }] });
      return notFound(response);
    });
    try {
      await runGet({ command: 'get', coordinator: server.origin, workspace: 'default', code: '8F3K-22Q9', outDir: 'downloads', json: true, dryRun: false });

      expect(executed).toEqual([]);
      const output = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]));
      expect(output.data).toMatchObject({ code: '8F3K-22Q9', fileId: 'file-1', name: 'demo.bin', sizeBytes: 9, outDir: 'downloads', discovery: 'coordinator', execution: 'unavailable', status: 'planned', candidates: { providers: [{ nodeId: 'node-a', online: true, endpointHints: [] }] } });
    } finally {
      restoreRunner();
      await server.close();
    }
  });

  it('uses the computed node id consistently when share omits --node-id', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'ponswarp-cli-share-default-node-'));
    const file = join(tempDir, 'demo.bin');
    await writeFile(file, Buffer.alloc(3, 5));
    const server = await startCoordinatorStub((request, response, recorded) => {
      if (request.method === 'POST' && request.url === '/api/grid/v1/workspaces') return json(response, { workspaceId: 'default' });
      if (request.method === 'POST' && request.url === '/api/grid/v1/workspaces/default/files') return json(response, { published: recorded.body });
      if (request.method === 'POST' && request.url === '/api/grid/v1/workspaces/default/shares') return json(response, { code: 'ABCD-1234', fileId: (recorded.body as { fileId: string }).fileId });
      return notFound(response);
    });
    try {
      await runShare({ command: 'share', coordinator: server.origin, workspace: 'default', file, pieceSize: 4, json: true, dryRun: false });

      const publishNodeId = ((server.requests[1]?.body as { availability: { nodeId: string } }).availability.nodeId);
      const shareNodeId = (server.requests[2]?.body as { createdByNodeId: string }).createdByNodeId;
      const output = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]));
      expect(publishNodeId).toMatch(/^node_[a-f0-9]{12}$/);
      expect(shareNodeId).toBe(publishNodeId);
      expect(output.data.nodeId).toBe(publishNodeId);
    } finally {
      await server.close();
    }
  });

  it('rejects malformed get codes as usage errors', async () => {
    await expect(runGet({ command: 'get', coordinator: 'http://127.0.0.1:8787', workspace: 'default', code: 'not-a-code', outDir: '.', json: true, dryRun: true })).rejects.toThrow(/share code/);
  });

  it('detects direct join hints from online coordinator candidates', () => {
    expect(findDirectTransferHint({}, {
      providers: [
        { nodeId: 'offline', online: false, endpointHints: ['ponswarp://join/offline'] },
        { nodeId: 'node-a', online: true, endpointHints: [{ kind: 'ponswarp-join', value: 'ponswarp://join/owner', peer: 'ponswarp-peer://seed' }] }
      ]
    })).toEqual({ join: 'ponswarp://join/owner', peer: 'ponswarp-peer://seed' });

    expect(findDirectTransferHint({ capabilities: { directTransfer: { join: 'ponswarp://join/from-capabilities' } } }, { providers: [] })).toBeUndefined();
  });
});

async function startCoordinatorStub(handler: (request: IncomingMessage, response: ServerResponse, recorded: RecordedRequest) => void | Promise<void>): Promise<{ origin: string; requests: RecordedRequest[]; close: () => Promise<void> }> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    const bodyText = await readRequestBody(request);
    const recorded = { method: request.method ?? 'GET', path: request.url ?? '/', body: bodyText ? JSON.parse(bodyText) : undefined };
    requests.push(recorded);
    await handler(request, response, recorded);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected server address');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise(resolve => server.close(() => resolve()))
  };
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function json(response: ServerResponse, payload: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function notFound(response: ServerResponse): void {
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: 'not_found' }));
}
