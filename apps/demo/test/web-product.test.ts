import { describe, expect, it } from 'vitest';
import { createShareCode, formatBytes, isLocalShareMatch, normalizeShareCode, parseShareCode, resolveReceiveDisplayMetadata } from '../src/web-product';

describe('web product helpers', () => {
  it('parses continuous and legacy dashed share codes from links', () => {
    expect(parseShareCode('https://warp.ponslink.com/get/8f3k22q9')).toBe('8F3K22Q9');
    expect(parseShareCode('https://warp.ponslink.com/get/8f3k-22q9')).toBe('8F3K22Q9');
    expect(parseShareCode('ponswarp://get/abcd1234')).toBe('ABCD1234');
    expect(parseShareCode('https://grid.ponslink.com/#/get/demo1a2b?session=sess_signal_1')).toBe('DEMO1A2B');
    expect(parseShareCode('https://grid.ponslink.com/#/get/MVAY-CQW3')).toBe('MVAYCQW3');
    expect(parseShareCode('MVAYCQW3')).toBe('MVAYCQW3');
    expect(parseShareCode('MVAY-CQW3')).toBe('MVAYCQW3');
    expect(parseShareCode('nope')).toBe('');
    expect(parseShareCode('SHORT')).toBe('');
    expect(parseShareCode('TOO-LONG-CODE-HERE')).toBe('');
    expect(parseShareCode('')).toBe('');
  });

  it('keeps QR get links parseable when they include an embedded session query', () => {
    const qrLink = 'https://grid.ponslink.com/#/get/C0DE1234?session=sess_signal_123';
    expect(parseShareCode(qrLink)).toBe('C0DE1234');
  });

  it('uses only real receive metadata instead of fabricated archive details', () => {
    expect(resolveReceiveDisplayMetadata(null, null)).toEqual({
      fileName: 'Shared file',
      sizeBytes: undefined
    });
    expect(resolveReceiveDisplayMetadata(null, {
      fileName: 'field-recording.mov',
      sizeBytes: 734_003_200
    })).toEqual({
      fileName: 'field-recording.mov',
      sizeBytes: 734_003_200
    });
  });

  it('formats small and large file sizes for the share/get cards', () => {
    expect(formatBytes(26)).toBe('26 bytes');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10.0 MB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
  });

  it('generates 8-character share codes without dashes', () => {
    const code = createShareCode();
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect(code).not.toContain('-');
    expect(code).not.toContain('DEMO');
    expect(normalizeShareCode('AB12-CD34')).toBe('AB12CD34');
  });

  it('allows the browser MVP to distinguish local downloadable shares from remote planning states', () => {
    expect(isLocalShareMatch('ABCDEFGH', 'abcdefgh')).toBe(true);
    expect(isLocalShareMatch('ABCD-EFGH', 'abcdefgh')).toBe(true);
    expect(isLocalShareMatch('ABCDEFGH', 'WXYZ9999')).toBe(false);
    expect(isLocalShareMatch(undefined, 'WXYZ9999')).toBe(false);
  });

  it('share codes round-trip through parseShareCode', () => {
    for (let i = 0; i < 20; i++) {
      const code = createShareCode();
      expect(parseShareCode(code)).toBe(code);
      expect(parseShareCode(`https://grid.ponslink.com/#/get/${code.toLowerCase()}?session=sess_1`)).toBe(code);
      // legacy dashed links still normalize
      const dashed = `${code.slice(0, 4)}-${code.slice(4)}`;
      expect(parseShareCode(dashed)).toBe(code);
    }
  });
});
