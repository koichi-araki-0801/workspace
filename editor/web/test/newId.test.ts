import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId, randomHex } from '@/lib/newId';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('newId', () => {
  it('randomUUID があればそれを使う', () => {
    vi.stubGlobal('crypto', {
      randomUUID: () => 'u',
      getRandomValues: (a: Uint8Array) => a,
    });
    expect(newId()).toBe('u');
  });

  it('randomUUID が無い(HTTP の LAN 公開)ときも UUID v4 の形を返す', () => {
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => a.fill(0xab) });
    expect(newId()).toMatch(V4);
  });

  it('代替経路の出力は RFC 4122 の v4 形式で、呼ぶたびに変わる', () => {
    let n = 0;
    vi.stubGlobal('crypto', {
      getRandomValues: (a: Uint8Array) => {
        for (let i = 0; i < a.length; i++) a[i] = (n++ * 37) & 0xff;
        return a;
      },
    });
    const a = newId();
    const b = newId();
    expect(a).toMatch(V4);
    expect(a).not.toBe(b);
  });
});

describe('randomHex', () => {
  it('n バイトぶんの小文字 hex(2n 桁)を返し、バイトは 0 埋めする', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (a: Uint8Array) => {
        a.set([0x01, 0xab, 0x00, 0xff].slice(0, a.length));
        return a;
      },
    });
    expect(randomHex(4)).toBe('01ab00ff');
    expect(randomHex(2)).toBe('01ab');
  });

  it('実際の乱数でも桁数と文字種が合う', () => {
    expect(randomHex(8)).toMatch(/^[0-9a-f]{16}$/);
  });
});
