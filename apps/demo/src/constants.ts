export const DEFAULT_STUN_URL = 'stun:stun.l.google.com:19302';
export const SHARE_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const PIECE_PROGRESS_TIMEOUT_MS = 30_000;
export const PROGRESS_POLL_INTERVAL_MS = 100;
export const DEFAULT_BROWSER_TRANSFER_WINDOW = 2;
export const MAX_BROWSER_TRANSFER_WINDOW = 8;
export const SMALL_FILE_PIECE_SIZE = 256 * 1024;
export const MEDIUM_FILE_PIECE_SIZE = 1024 * 1024;
export const LARGE_FILE_PIECE_SIZE = 2 * 1024 * 1024;
export const VERY_LARGE_FILE_PIECE_SIZE = 4 * 1024 * 1024;
export const SMALL_FILE_THRESHOLD = 1024 * 1024;
export const MEDIUM_FILE_THRESHOLD = 16 * 1024 * 1024;
export const LARGE_FILE_THRESHOLD = 128 * 1024 * 1024;
export const DEFAULT_SAMPLE_FILE_NAME = 'sample.txt';
export const DEFAULT_SAMPLE_PAYLOAD = 'PonsWarp Grid sample payload';

export function calculatePieceSize(file: Blob): number {
  const explicit = Number(new URLSearchParams(location.search).get('pieceSize'));
  if (Number.isSafeInteger(explicit) && explicit >= SMALL_FILE_PIECE_SIZE) return explicit;
  if (file.size <= SMALL_FILE_THRESHOLD) return SMALL_FILE_PIECE_SIZE;
  if (file.size <= MEDIUM_FILE_THRESHOLD) return MEDIUM_FILE_PIECE_SIZE;
  if (file.size <= LARGE_FILE_THRESHOLD) return LARGE_FILE_PIECE_SIZE;
  return VERY_LARGE_FILE_PIECE_SIZE;
}
