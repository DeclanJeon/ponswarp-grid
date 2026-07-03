import { describe, expect, it } from 'vitest';
import { createShareCode, formatBytes, isLocalShareMatch, parseShareCode } from '../src/web-product';

describe('web product helpers', () => {
  it('extracts a share code from links and custom URLs', () => {
    expect(parseShareCode('https://warp.ponslink.com/get/8f3k-22q9')).toBe('8F3K-22Q9');
    expect(parseShareCode('ponswarp://get/abcd-1234')).toBe('ABCD-1234');
    expect(parseShareCode('DEMO-1A2B')).toBe('DEMO-1A2B');
    expect(parseShareCode('not-a-code')).toBe('');
    expect(parseShareCode('')).toBe('');
  });

  it('formats small and large file sizes for the share/get cards', () => {
    expect(formatBytes(26)).toBe('26 bytes');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10.0 MB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
  });

  it('uses deterministic human-readable demo share codes in tests', () => {
    expect(createShareCode(Number.parseInt('zzzz', 36))).toBe('DEMO-ZZZZ');
  });

  it('allows the browser MVP to distinguish local downloadable shares from remote planning states', () => {
    expect(isLocalShareMatch('DEMO-ABCD', 'demo-abcd')).toBe(true);
    expect(isLocalShareMatch('DEMO-ABCD', 'DEMO-WXYZ')).toBe(false);
    expect(isLocalShareMatch(undefined, 'DEMO-WXYZ')).toBe(false);
  });
});
