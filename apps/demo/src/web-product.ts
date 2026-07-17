/** Normalize share codes to 8 A–Z / 2–9 characters without separators. */
export function normalizeShareCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Parse a share code from raw input, links, or legacy XXXX-XXXX form.
 * Canonical form is 8 characters with no dash (e.g. MVAYCQW3).
 */
export function parseShareCode(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  // Hash / path forms: #/get/CODE, /get/CODE, ponswarp://get/CODE
  const pathMatch = trimmed.match(/(?:#\/get\/|\/get\/|ponswarp:\/\/get\/)([A-Z0-9-]{4,16})(?:[?#/].*)?/i);
  if (pathMatch?.[1]) {
    const normalized = normalizeShareCode(pathMatch[1]);
    if (normalized.length === 8) return normalized;
  }

  // Bare code: prefer continuous 8, accept legacy dashed
  const bare = trimmed.match(/^([A-Z0-9]{4}-[A-Z0-9]{4}|[A-Z0-9]{8})$/i);
  if (bare?.[1]) {
    const normalized = normalizeShareCode(bare[1]);
    if (normalized.length === 8) return normalized;
  }

  // Last path segment fallback
  const segment = trimmed.split(/[/?#]/).filter(Boolean).pop() ?? '';
  const normalized = normalizeShareCode(segment);
  return normalized.length === 8 ? normalized : '';
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 bytes';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** 8-character share code without dash (Crockford-ish alphabet). */
export function createShareCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export function isLocalShareMatch(activeCode: string | undefined, requestedCode: string): boolean {
  if (!activeCode) return false;
  return normalizeShareCode(activeCode) === normalizeShareCode(requestedCode);
}

export interface ReceiveMetadataCandidate {
  fileName?: string;
  sizeBytes?: number;
}

export function resolveReceiveDisplayMetadata(
  localShare: ReceiveMetadataCandidate | null | undefined,
  coordinatorShare: ReceiveMetadataCandidate | null | undefined
): { fileName: string; sizeBytes?: number } {
  const fileName = localShare?.fileName ?? coordinatorShare?.fileName ?? 'Shared file';
  const sizeBytes = localShare?.sizeBytes ?? coordinatorShare?.sizeBytes;
  return { fileName, sizeBytes };
}
