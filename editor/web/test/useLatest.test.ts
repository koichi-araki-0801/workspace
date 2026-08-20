import { describe, expect, it } from 'vitest';
import { useLatest } from '@/lib/useLatest';

describe('useLatest', () => {
  it('直近に開始した世代だけが最新と判定される', () => {
    const latest = useLatest();
    const first = latest.begin();
    expect(first()).toBe(true);

    const second = latest.begin();
    expect(first()).toBe(false); // 後発が始まった時点で旧世代は捨てる側になる
    expect(second()).toBe(true);
  });

  it('世代は生成器ごとに独立している', () => {
    const a = useLatest();
    const b = useLatest();
    const fromA = a.begin();
    b.begin();
    expect(fromA()).toBe(true);
  });

  it('後着の旧世代の応答を捨てられる', async () => {
    const latest = useLatest();
    const applied: string[] = [];
    // 先発は遅く、後発は速く返る(取り違えが起きる典型)。
    async function load(value: string, delayMs: number) {
      const isLatest = latest.begin();
      await new Promise((r) => setTimeout(r, delayMs));
      if (!isLatest()) return;
      applied.push(value);
    }
    const slow = load('old', 20);
    const fast = load('new', 0);
    await Promise.all([slow, fast]);
    expect(applied).toEqual(['new']);
  });
});
