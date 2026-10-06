import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from '@/lib/newId';

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
