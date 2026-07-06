export type CliCommandName = 'send' | 'join' | 'serve-signal' | 'status' | 'clean' | 'node-start' | 'publish' | 'files' | 'download' | 'share' | 'get' | 'help' | 'version';
export { NodeFileStorageAdapter, openNodeFileSource, toArrayBuffer, type NodeFileSource, type NodeFileStorageOptions } from './node-file-storage.js';
export { NodePeerEndpointRegistry, NodeWebSocketTransport, type NodeWebSocketTransportOptions, type PeerEndpoint } from './node-websocket-transport.js';
export { decodeJoinDescriptor, decodePeerDescriptor, encodeJoinDescriptor, encodePeerDescriptor, runJoin, runSend, type CliPeerDescriptor, type CliSessionDescriptor } from './cli-runtime.js';

export interface BaseCommand { command: CliCommandName }

export interface SendCommand extends BaseCommand {
  command: 'send';
  file: string;
  signal: string;
  listen: string;
  advertise?: string;
  pieceSize: number;
  session?: string;
  keepOpen: boolean;
}

export interface JoinCommand extends BaseCommand {
  command: 'join';
  session: string;
  signal: string;
  listen: string;
  advertise?: string;
  peer?: string;
  outDir: string;
  seedAfterComplete: boolean;
  maxPeers: number;
}

export interface ServeSignalCommand extends BaseCommand {
  command: 'serve-signal';
  host: string;
  port: number;
}

export interface StatusCommand extends BaseCommand { command: 'status'; session: string }
export interface CleanCommand extends BaseCommand { command: 'clean'; session: string }
export interface HelpCommand extends BaseCommand { command: 'help' }
export interface VersionCommand extends BaseCommand { command: 'version' }

export interface CoordinatorOptions {
  coordinator: string;
  workspace: string;
  json: boolean;
  dryRun: boolean;
}

export interface NodeStartCommand extends BaseCommand, CoordinatorOptions {
  command: 'node-start';
  nodeId: string;
  displayName: string;
  publicKey: string;
  directJoin?: string;
}

export interface PublishCommand extends BaseCommand, CoordinatorOptions {
  command: 'publish';
  file: string;
  nodeId: string;
  pieceSize: number;
}

export interface FilesCommand extends BaseCommand, Omit<CoordinatorOptions, 'dryRun'> {
  command: 'files';
}

export interface DownloadCommand extends BaseCommand, CoordinatorOptions {
  command: 'download';
  fileId: string;
  outDir: string;
}

export interface ShareCommand extends BaseCommand, CoordinatorOptions {
  command: 'share';
  file: string;
  nodeId?: string;
  pieceSize: number;
  ttlSeconds?: number;
}

export interface GetCommand extends BaseCommand, CoordinatorOptions {
  command: 'get';
  code: string;
  outDir: string;
}

export type ParsedCliCommand = SendCommand | JoinCommand | ServeSignalCommand | StatusCommand | CleanCommand | NodeStartCommand | PublishCommand | FilesCommand | DownloadCommand | ShareCommand | GetCommand | HelpCommand | VersionCommand;

export class CliUsageError extends Error {
  constructor(message: string) { super(message); this.name = 'CliUsageError'; }
}

const DEFAULT_SIGNAL = 'ws://127.0.0.1:8787/ws';
const DEFAULT_LISTEN = '127.0.0.1:0';
const DEFAULT_PIECE_SIZE = 1024 * 1024;
const DEFAULT_OUT_DIR = '.';
const DEFAULT_MAX_PEERS = 8;
const DEFAULT_COORDINATOR = process.env.PONSWARP_COORDINATOR_URL ?? 'https://grid.ponslink.com';
const TCP_PORT_MAX = 65535;


export function parseCliArgs(argv: readonly string[]): ParsedCliCommand {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') return { command: 'help' };
  if (command === '--version' || command === '-v' || command === 'version') return { command: 'version' };

  if (command === 'node') return parseNode(rest);
  switch (command) {
    case 'send': return parseSend(rest);
    case 'join': return parseJoin(rest);
    case 'serve-signal': return parseServeSignal(rest);
    case 'status': return parseSessionOnly('status', rest);
    case 'clean': return parseSessionOnly('clean', rest);
    case 'publish': return parsePublish(rest);
    case 'files': return parseFiles(rest);
    case 'download': return parseDownload(rest);
    case 'share': return parseShare(rest);
    case 'get': return parseGet(rest);
    default: throw new CliUsageError(`Unknown command: ${command}`);
  }
}

function parseSend(args: readonly string[]): SendCommand {
  const positionals: string[] = [];
  const options = parseOptions(args, positionals, new Set(['signal', 'listen', 'advertise', 'piece-size', 'session', 'keep-open']));
  const file = positionals[0];
  if (!file) throw new CliUsageError('send requires <file>');
  if (positionals.length > 1) throw new CliUsageError(`send accepts one file, got ${positionals.length}`);
  return {
    command: 'send',
    file,
    signal: stringOption(options, 'signal', DEFAULT_SIGNAL),
    listen: stringOption(options, 'listen', DEFAULT_LISTEN),
    advertise: optionalStringOption(options, 'advertise'),
    pieceSize: positiveIntegerOption(options, 'piece-size', DEFAULT_PIECE_SIZE),
    session: optionalStringOption(options, 'session'),
    keepOpen: booleanOption(options, 'keep-open')
  };
}

function parseJoin(args: readonly string[]): JoinCommand {
  const positionals: string[] = [];
  const options = parseOptions(args, positionals, new Set(['signal', 'listen', 'advertise', 'out', 'peer', 'seed-after-complete', 'max-peers']));
  const session = positionals[0];
  if (!session) throw new CliUsageError('join requires <session-or-url>');
  if (positionals.length > 1) throw new CliUsageError(`join accepts one session, got ${positionals.length}`);
  return {
    command: 'join',
    session,
    signal: stringOption(options, 'signal', DEFAULT_SIGNAL),
    listen: stringOption(options, 'listen', DEFAULT_LISTEN),
    advertise: optionalStringOption(options, 'advertise'),
    outDir: stringOption(options, 'out', DEFAULT_OUT_DIR),
    peer: optionalStringOption(options, 'peer'),
    seedAfterComplete: booleanOption(options, 'seed-after-complete'),
    maxPeers: positiveIntegerOption(options, 'max-peers', DEFAULT_MAX_PEERS)
  };
}

function parseServeSignal(args: readonly string[]): ServeSignalCommand {
  const positionals: string[] = [];
  const options = parseOptions(args, positionals, new Set(['host', 'port']));
  if (positionals.length > 0) throw new CliUsageError('serve-signal does not accept positional arguments');
  return {
    command: 'serve-signal',
    host: stringOption(options, 'host', '0.0.0.0'),
    port: tcpPortOption(options, 'port', 8787)
  };
}

function parseSessionOnly(command: 'status' | 'clean', args: readonly string[]): StatusCommand | CleanCommand {
  const positionals: string[] = [];
  const options = parseOptions(args, positionals, new Set<string>());
  if (options.size > 0) throw new CliUsageError(`${command} does not accept options yet`);
  const session = positionals[0];
  if (!session) throw new CliUsageError(`${command} requires <session>`);
  if (positionals.length > 1) throw new CliUsageError(`${command} accepts one session, got ${positionals.length}`);
  return command === 'status' ? { command, session } : { command, session };
}

function parseNode(args: readonly string[]): NodeStartCommand {
  const [subcommand, ...rest] = args;
  if (subcommand !== 'start') throw new CliUsageError('node requires subcommand: start');
  const positionals: string[] = [];
  const options = parseOptions(rest, positionals, new Set(['coordinator', 'workspace', 'node-id', 'display-name', 'public-key', 'direct-join', 'json', 'dry-run']));
  if (positionals.length > 0) throw new CliUsageError('node start does not accept positional arguments');
  return {
    command: 'node-start',
    coordinator: stringOption(options, 'coordinator', DEFAULT_COORDINATOR),
    workspace: requiredStringOption(options, 'workspace'),
    nodeId: requiredStringOption(options, 'node-id'),
    displayName: stringOption(options, 'display-name', requiredStringOption(options, 'node-id')),
    publicKey: requiredStringOption(options, 'public-key'),
    directJoin: optionalStringOption(options, 'direct-join'),
    json: booleanOption(options, 'json'),
    dryRun: booleanOption(options, 'dry-run')
  };
}

function parsePublish(args: readonly string[]): PublishCommand {
  const positionals: string[] = [];
  const options = parseOptions(args, positionals, new Set(['coordinator', 'workspace', 'node-id', 'piece-size', 'json', 'dry-run']));
  const file = positionals[0];
  if (!file) throw new CliUsageError('publish requires <file>');
  if (positionals.length > 1) throw new CliUsageError(`publish accepts one file, got ${positionals.length}`);
  return {
    command: 'publish',
    file,
    coordinator: stringOption(options, 'coordinator', DEFAULT_COORDINATOR),
    workspace: requiredStringOption(options, 'workspace'),
    nodeId: requiredStringOption(options, 'node-id'),
    pieceSize: positiveIntegerOption(options, 'piece-size', DEFAULT_PIECE_SIZE),
    json: booleanOption(options, 'json'),
    dryRun: booleanOption(options, 'dry-run')
  };
}

function parseFiles(args: readonly string[]): FilesCommand {
  const positionals: string[] = [];
  const options = parseOptions(args, positionals, new Set(['coordinator', 'workspace', 'json']));
  if (positionals.length > 0) throw new CliUsageError('files does not accept positional arguments');
  return {
    command: 'files',
    coordinator: stringOption(options, 'coordinator', DEFAULT_COORDINATOR),
    workspace: requiredStringOption(options, 'workspace'),
    json: booleanOption(options, 'json')
  };
}

function parseDownload(args: readonly string[]): DownloadCommand {
  const positionals: string[] = [];
  const options = parseOptions(args, positionals, new Set(['coordinator', 'workspace', 'out', 'json', 'dry-run']));
  const fileId = positionals[0];
  if (!fileId) throw new CliUsageError('download requires <file-id>');
  if (positionals.length > 1) throw new CliUsageError(`download accepts one file id, got ${positionals.length}`);
  return {
    command: 'download',
    fileId,
    coordinator: stringOption(options, 'coordinator', DEFAULT_COORDINATOR),
    workspace: requiredStringOption(options, 'workspace'),
    outDir: stringOption(options, 'out', DEFAULT_OUT_DIR),
    json: booleanOption(options, 'json'),
    dryRun: booleanOption(options, 'dry-run')
  };
}

function parseShare(args: readonly string[]): ShareCommand {
  const positionals: string[] = [];
  const options = parseOptions(args, positionals, new Set(['coordinator', 'workspace', 'node-id', 'piece-size', 'ttl-seconds', 'json', 'dry-run']));
  const file = positionals[0];
  if (!file) throw new CliUsageError('share requires <file>');
  if (positionals.length > 1) throw new CliUsageError(`share accepts one file, got ${positionals.length}`);
  return {
    command: 'share',
    file,
    coordinator: stringOption(options, 'coordinator', DEFAULT_COORDINATOR),
    workspace: stringOption(options, 'workspace', 'default'),
    nodeId: optionalStringOption(options, 'node-id'),
    pieceSize: positiveIntegerOption(options, 'piece-size', DEFAULT_PIECE_SIZE),
    ttlSeconds: optionalPositiveIntegerOption(options, 'ttl-seconds'),
    json: booleanOption(options, 'json'),
    dryRun: booleanOption(options, 'dry-run')
  };
}

function parseGet(args: readonly string[]): GetCommand {
  const positionals: string[] = [];
  const options = parseOptions(args, positionals, new Set(['coordinator', 'workspace', 'out', 'json', 'dry-run']));
  const code = positionals[0];
  if (!code) throw new CliUsageError('get requires <share-code-or-link>');
  if (positionals.length > 1) throw new CliUsageError(`get accepts one share code or link, got ${positionals.length}`);
  return {
    command: 'get',
    code,
    coordinator: stringOption(options, 'coordinator', DEFAULT_COORDINATOR),
    workspace: stringOption(options, 'workspace', 'default'),
    outDir: stringOption(options, 'out', DEFAULT_OUT_DIR),
    json: booleanOption(options, 'json'),
    dryRun: booleanOption(options, 'dry-run')
  };
}

function parseOptions(args: readonly string[], positionals: string[], allowed: ReadonlySet<string>): Map<string, string | true> {
  const options = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') { positionals.push(...args.slice(index + 1)); break; }
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const withoutPrefix = arg.slice(2);
    const eq = withoutPrefix.indexOf('=');
    if (eq >= 0) {
      const key = withoutPrefix.slice(0, eq);
      const value = withoutPrefix.slice(eq + 1);
      if (!key) throw new CliUsageError(`Invalid option: ${arg}`);
      setKnownOption(options, allowed, key, value);
      continue;
    }
    const key = withoutPrefix;
    if (!key) throw new CliUsageError(`Invalid option: ${arg}`);
    if (isBooleanFlag(key)) { setKnownOption(options, allowed, key, true); continue; }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new CliUsageError(`Missing value for --${key}`);
    setKnownOption(options, allowed, key, value);
    index += 1;
  }
  return options;
}

function setKnownOption(options: Map<string, string | true>, allowed: ReadonlySet<string>, key: string, value: string | true): void {
  if (!allowed.has(key)) throw new CliUsageError(`Unknown option: --${key}`);
  options.set(key, value);
}

function isBooleanFlag(key: string): boolean {
  return key === 'keep-open' || key === 'seed-after-complete' || key === 'json' || key === 'dry-run';
}

function stringOption(options: Map<string, string | true>, key: string, fallback: string): string {
  const value = options.get(key);
  if (value === undefined) return fallback;
  if (value === true || value.length === 0) throw new CliUsageError(`--${key} requires a value`);
  return value;
}

function optionalStringOption(options: Map<string, string | true>, key: string): string | undefined {
  const value = options.get(key);
  if (value === undefined) return undefined;
  if (value === true || value.length === 0) throw new CliUsageError(`--${key} requires a value`);
  return value;
}

function requiredStringOption(options: Map<string, string | true>, key: string): string {
  const value = optionalStringOption(options, key);
  if (!value) throw new CliUsageError(`--${key} is required`);
  return value;
}

function booleanOption(options: Map<string, string | true>, key: string): boolean {
  const value = options.get(key);
  if (value === undefined) return false;
  if (value !== true) throw new CliUsageError(`--${key} does not take a value`);
  return true;
}

function positiveIntegerOption(options: Map<string, string | true>, key: string, fallback: number): number {
  const raw = options.get(key);
  if (raw === undefined) return fallback;
  if (raw === true) throw new CliUsageError(`--${key} requires a value`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new CliUsageError(`--${key} must be a positive integer`);
  return value;
}

function optionalPositiveIntegerOption(options: Map<string, string | true>, key: string): number | undefined {
  const raw = options.get(key);
  if (raw === undefined) return undefined;
  if (raw === true) throw new CliUsageError(`--${key} requires a value`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new CliUsageError(`--${key} must be a positive integer`);
  return value;
}

function tcpPortOption(options: Map<string, string | true>, key: string, fallback: number): number {
  const value = positiveIntegerOption(options, key, fallback);
  if (value > TCP_PORT_MAX) throw new CliUsageError(`--${key} must be between 1 and ${TCP_PORT_MAX}`);
  return value;
}

export function usage(): string {
  return `PonsWarp Grid CLI

Usage:
  ponswarp send <file> [--signal ws://host:8787/ws] [--listen host:port] [--advertise ws://host:port] [--piece-size bytes] [--session id] [--keep-open]
  ponswarp join <session-or-url> --out <dir> [--signal ws://host:8787/ws] [--listen host:port] [--advertise ws://host:port] [--peer ponswarp-peer://...] [--seed-after-complete] [--max-peers n]
  ponswarp serve-signal [--host 0.0.0.0] [--port 8787]
  ponswarp node start --workspace <id> --node-id <id> --public-key <key> [--coordinator http://host] [--display-name name] [--direct-join ponswarp://join/...] [--json] [--dry-run]
  ponswarp publish <file> --workspace <id> --node-id <id> [--coordinator http://host] [--piece-size bytes] [--json] [--dry-run]
  ponswarp files --workspace <id> [--coordinator http://host] [--json]
  ponswarp download <file-id> --workspace <id> --out <dir> [--coordinator http://host] [--json] [--dry-run]
  ponswarp share <file> [--workspace id] [--node-id id] [--coordinator http://host] [--piece-size bytes] [--ttl-seconds n] [--json] [--dry-run]
  ponswarp get <share-code-or-link> [--workspace id] [--out <dir>] [--coordinator http://host] [--json] [--dry-run]
  ponswarp status <session>
  ponswarp clean <session>
`;
}
