export const DEFAULT_TRANSFER_WINDOW = 1;
export const MAX_TRANSFER_WINDOW = 2;
export const RUNTIME_CONFIG_TIMEOUT_MS = 3_000;

export type RuntimeConfig = {
  schema: 'ponswarp-grid.runtime-config/v1';
  directTransfer: {
    window: 1 | 2;
    hold: boolean;
    allowDiagnosticWindow2: boolean;
    qaBuild: boolean;
    rolloutId: string;
  };
};
export type RuntimeConfigSource = { fetch: typeof globalThis.fetch };

const ROOT_KEYS = ['schema', 'directTransfer'] as const;
const DIRECT_TRANSFER_KEYS = ['window', 'hold', 'allowDiagnosticWindow2', 'qaBuild', 'rolloutId'] as const;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ROOT_KEYS) || record.schema !== 'ponswarp-grid.runtime-config/v1') return null;
  const directTransfer = record.directTransfer;
  if (!directTransfer || typeof directTransfer !== 'object' || Array.isArray(directTransfer)) return null;
  const direct = directTransfer as Record<string, unknown>;
  if (!hasExactKeys(direct, DIRECT_TRANSFER_KEYS)
    || (direct.window !== 1 && direct.window !== 2)
    || typeof direct.hold !== 'boolean'
    || typeof direct.qaBuild !== 'boolean'
    || typeof direct.allowDiagnosticWindow2 !== 'boolean'
    || typeof direct.rolloutId !== 'string'
    || !/^[A-Za-z0-9._-]{1,80}$/.test(direct.rolloutId)) return null;
  return record as RuntimeConfig;
}

export function resolveTransferWindow(config: RuntimeConfig | null | undefined, query: string | URLSearchParams = ''): number {
  const params = typeof query === 'string' ? new URLSearchParams(query) : query;
  if (!config || config.directTransfer.hold) return DEFAULT_TRANSFER_WINDOW;
  const diagnostic = params.get('transferWindow');
  if (diagnostic === '2') {
    return config.directTransfer.qaBuild && config.directTransfer.allowDiagnosticWindow2
      ? 2
      : DEFAULT_TRANSFER_WINDOW;
  }
  return config.directTransfer.window === 2 ? 2 : DEFAULT_TRANSFER_WINDOW;
}

export async function loadRuntimeConfig(source: RuntimeConfigSource, origin: string): Promise<RuntimeConfig | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = new URL('/runtime-config.json', origin);
    const request = source.fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('runtime config timeout')), RUNTIME_CONFIG_TIMEOUT_MS); });
    const response = await Promise.race([request, timeout]);
    if (!response.ok || new URL(response.url || url.href).origin !== new URL(origin).origin) return null;
    return parseRuntimeConfig(await response.json());
  } catch { return null; } finally { if (timer) clearTimeout(timer); }
}

export function resolveBrowserTransferWindow(config: RuntimeConfig | null | undefined, search = globalThis.location?.search ?? ''): number { return resolveTransferWindow(config, search); }
