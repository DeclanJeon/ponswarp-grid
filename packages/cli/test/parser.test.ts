import { describe, expect, it } from 'vitest';
import { CliUsageError, parseCliArgs, usage } from '../src/index';

describe('PonsWarp CLI parser', () => {
  it('parses help and version commands', () => {
    expect(parseCliArgs([])).toEqual({ command: 'help' });
    expect(parseCliArgs(['--help'])).toEqual({ command: 'help' });
    expect(parseCliArgs(['version'])).toEqual({ command: 'version' });
    expect(usage()).toContain('ponswarp send <file>');
  });

  it('parses send defaults and options', () => {
    expect(parseCliArgs(['send', 'demo.bin'])).toMatchObject({
      command: 'send',
      file: 'demo.bin',
      signal: 'auto',
      listen: '127.0.0.1:0',
      pieceSize: 1024 * 1024,
      keepOpen: false,
      pathKind: 'unknown'
    });

    expect(parseCliArgs([
      'send',
      'demo.bin',
      '--signal', 'ws://localhost:9999/ws',
      '--listen=0.0.0.0:5000',
      '--advertise', 'ws://10.0.0.2:5000',
      '--piece-size', '262144',
      '--session', 'sess_cli',
      '--keep-open'
    ])).toMatchObject({
      command: 'send',
      file: 'demo.bin',
      signal: 'ws://localhost:9999/ws',
      listen: '0.0.0.0:5000',
      advertise: 'ws://10.0.0.2:5000',
      pieceSize: 262144,
      session: 'sess_cli',
      keepOpen: true,
      pathKind: 'unknown'
    });

    expect(parseCliArgs(['send', 'demo.bin', '--path-kind', 'relay'])).toMatchObject({
      command: 'send',
      pathKind: 'relay'
    });
    expect(() => parseCliArgs(['send', 'demo.bin', '--path-kind', 'wifi'])).toThrow(/path-kind/);
  });

  it('parses join defaults and options', () => {
    expect(parseCliArgs(['join', 'sess_1'])).toMatchObject({
      command: 'join',
      session: 'sess_1',
      outDir: '.',
      seedAfterComplete: false,
      maxPeers: 8,
      pathKind: 'unknown'
    });

    expect(parseCliArgs(['join', 'ponswarp://join/sess_1', '--out', 'downloads', '--peer', 'ponswarp-peer://abc', '--seed-after-complete', '--max-peers', '3'])).toMatchObject({
      command: 'join',
      session: 'ponswarp://join/sess_1',
      outDir: 'downloads',
      seedAfterComplete: true,
      peer: 'ponswarp-peer://abc',
      maxPeers: 3
    });
  });

  it('parses explicit join transfer windows and rejects non-positive windows', () => {
    expect(parseCliArgs(['join', 'sess_1', '--transfer-window', '3'])).toMatchObject({
      command: 'join',
      session: 'sess_1',
      transferWindow: 3,
      pathKind: 'unknown'
    });
    expect(parseCliArgs(['join', 'sess_1', '--path-kind', 'host'])).toMatchObject({ pathKind: 'host' });

    expect(() => parseCliArgs(['join', 'sess_1', '--transfer-window', '0'])).toThrow(/positive integer/);
  });

  it('parses serve-signal status and clean', () => {
    expect(parseCliArgs(['serve-signal'])).toEqual({ command: 'serve-signal', host: '0.0.0.0', port: 8787 });
    expect(parseCliArgs(['serve-signal', '--host', '127.0.0.1', '--port', '9999'])).toEqual({ command: 'serve-signal', host: '127.0.0.1', port: 9999 });
    expect(parseCliArgs(['status', 'sess_1'])).toEqual({ command: 'status', session: 'sess_1' });
    expect(parseCliArgs(['clean', 'sess_1'])).toEqual({ command: 'clean', session: 'sess_1' });
  });

  it('parses coordinator product commands with json and dry-run options', () => {
    expect(parseCliArgs(['node', 'start', '--coordinator', 'http://127.0.0.1:8787', '--workspace', 'ws', '--node-id', 'node-a', '--display-name', 'Node A', '--public-key', 'ed25519:test', '--direct-join', 'ponswarp://join/provider', '--json', '--dry-run'])).toMatchObject({
      command: 'node-start',
      coordinator: 'http://127.0.0.1:8787',
      workspace: 'ws',
      nodeId: 'node-a',
      displayName: 'Node A',
      publicKey: 'ed25519:test',
      directJoin: 'ponswarp://join/provider',
      json: true,
      dryRun: true
    });
    expect(parseCliArgs(['publish', 'file.bin', '--workspace', 'ws', '--node-id', 'node-a', '--json'])).toMatchObject({ command: 'publish', file: 'file.bin', workspace: 'ws', nodeId: 'node-a', json: true });
    expect(parseCliArgs(['files', '--workspace', 'ws', '--json'])).toMatchObject({ command: 'files', workspace: 'ws', json: true });
    expect(parseCliArgs(['download', 'file-1', '--workspace', 'ws', '--out', 'downloads', '--dry-run', '--json'])).toMatchObject({ command: 'download', fileId: 'file-1', workspace: 'ws', outDir: 'downloads', dryRun: true, json: true });
    expect(parseCliArgs(['share', 'demo.bin', '--workspace', 'ws', '--node-id', 'node-a', '--ttl-seconds', '3600', '--json', '--dry-run'])).toMatchObject({
      command: 'share',
      file: 'demo.bin',
      workspace: 'ws',
      nodeId: 'node-a',
      ttlSeconds: 3600,
      json: true,
      dryRun: true
    });
    expect(parseCliArgs(['get', 'https://warp.ponslink.com/get/8F3K-22Q9', '--out', 'downloads', '--json', '--dry-run'])).toMatchObject({
      command: 'get',
      code: 'https://warp.ponslink.com/get/8F3K-22Q9',
      workspace: 'default',
      outDir: 'downloads',
      json: true,
      dryRun: true
    });
    expect(parseCliArgs(['share', 'demo.bin', '--workspace', 'ws', '--node-id', 'node-a', '--dry-run'])).toMatchObject({
      command: 'share',
      coordinator: 'https://grid.ponslink.com'
    });
  });

  it('rejects malformed input', () => {
    expect(() => parseCliArgs(['bogus'])).toThrow(CliUsageError);
    expect(() => parseCliArgs(['send'])).toThrow(/send requires/);
    expect(() => parseCliArgs(['send', 'a', 'b'])).toThrow(/one file/);
    expect(() => parseCliArgs(['join'])).toThrow(/join requires/);
    expect(() => parseCliArgs(['join', 'sess', '--max-peers', '0'])).toThrow(/positive integer/);
    expect(() => parseCliArgs(['serve-signal', '--port'])).toThrow(/Missing value/);
    expect(() => parseCliArgs(['serve-signal', '--port', '70000'])).toThrow(/between 1 and 65535/);
    expect(() => parseCliArgs(['send', 'demo.bin', '--singal', 'ws://typo'])).toThrow(/Unknown option/);
    expect(() => parseCliArgs(['join', 'sess', '--seed-after-complete=true'])).toThrow(/does not take a value|Unknown option/);
    expect(() => parseCliArgs(['status', 'sess', '--out', 'x'])).toThrow(/Unknown option/);
    expect(() => parseCliArgs(['share'])).toThrow(/share requires/);
    expect(() => parseCliArgs(['share', 'a', 'b'])).toThrow(/one file/);
    expect(() => parseCliArgs(['share', 'demo.bin', '--ttl-seconds', '0'])).toThrow(/positive integer/);
    expect(() => parseCliArgs(['get'])).toThrow(/get requires/);
    expect(() => parseCliArgs(['get', 'a', 'b'])).toThrow(/one share code/);
  });
});
