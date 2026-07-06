export function parseShareCode(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/(?:\/get\/|ponswarp:\/\/get\/)?([A-Z0-9]{4}-[A-Z0-9]{4})(?:[?#].*)?$/i);
  return match?.[1].toUpperCase() ?? '';
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

export function createShareCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rand = (n: number) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${rand(4)}-${rand(4)}`;
}

export function isLocalShareMatch(activeCode: string | undefined, requestedCode: string): boolean {
  return Boolean(activeCode && activeCode.toUpperCase() === requestedCode.toUpperCase());
}
