// =============================================================================
// previewOwnership.test.ts — プレビューセッションの所有者検査(IDOR)
// =============================================================================
// `list()` が全ユーザーのセッション id と url を返し、`get`/`stop`/`portOf` が
// 所有者を見ない形では、「UUID は秘密だから実質守られる」という緩和は `list()` がある限り
// 成立しない。しかも `stop` は `cleanupProject` まで行うので、他人の作業ディレクトリを
// 消せてしまう。ここでは**他人からは存在しないように見える**ことを主張する(403 ではなく空振り =
// ルート側で 404 に合流し、存在オラクルを与えない)。
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type PreviewActor,
  PreviewManager,
  type PreviewServerHandle,
  type PreviewSpec,
} from '../src/vivliostyle/previewManager.js';

const TTL = 1000;
const ALICE: PreviewActor = { loginId: 'alice', isAdmin: false };
const BOB: PreviewActor = { loginId: 'bob', isAdmin: false };
const ADMIN: PreviewActor = { loginId: 'root', isAdmin: true };
/** ローカルモード(`requireAuth=false`)のセンチネル。ルートの `actorOf` と同じ値。 */
const LOCAL: PreviewActor = { loginId: '@local', isAdmin: true };

function makeManager(maxSessions = 3) {
  const handles: Array<PreviewServerHandle & { close: ReturnType<typeof vi.fn> }> = [];
  let nextPort = 13000;
  const starter = vi.fn(async (_spec: PreviewSpec) => {
    const h = { port: nextPort++, close: vi.fn(async () => {}) };
    handles.push(h);
    return h;
  });
  return {
    mgr: new PreviewManager({ idleTtlMs: TTL, maxSessions, host: '127.0.0.1', starter }),
    handles,
  };
}

async function startAs(
  mgr: PreviewManager,
  owner: PreviewActor,
): Promise<{ id: string; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prev-own-'));
  const meta = await mgr.start(
    { mode: 'inline', input: 'x', workDir: dir, docBase: '/vivliostyle' },
    owner,
  );
  return { id: meta.id, dir };
}

describe('PreviewManager の所有者検査', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('他人のセッションは一覧に現れない', async () => {
    const { mgr } = makeManager();
    await startAs(mgr, ALICE);
    await startAs(mgr, BOB);
    expect(mgr.list(ALICE)).toHaveLength(1);
    expect(mgr.list(BOB)).toHaveLength(1);
    expect(mgr.list(ADMIN)).toHaveLength(2);
    await mgr.disposeAll();
  });

  it('id を知っていても他人からは get / resolveFor が空振りする', async () => {
    const { mgr } = makeManager();
    const a = await startAs(mgr, ALICE);
    expect(mgr.get(a.id, BOB)).toBeUndefined();
    expect(mgr.resolveFor(a.id, BOB)).toBeUndefined();
    expect(mgr.resolveFor(a.id, ALICE)).toEqual({ port: 13000, docBase: '/vivliostyle' });
    await mgr.disposeAll();
  });

  it('他人の stop は空振りし、作業ディレクトリも消えない', async () => {
    const { mgr, handles } = makeManager();
    const a = await startAs(mgr, ALICE);
    expect(await mgr.stop(a.id, BOB)).toBe(false);
    expect(existsSync(a.dir)).toBe(true);
    expect(handles[0].close).not.toHaveBeenCalled();
    expect(mgr.get(a.id, ALICE)).toBeDefined();
    await mgr.disposeAll();
  });

  it('admin は他人のセッションも見えるし止められる', async () => {
    const { mgr } = makeManager();
    const a = await startAs(mgr, ALICE);
    expect(mgr.get(a.id, ADMIN)).toBeDefined();
    expect(await mgr.stop(a.id, ADMIN)).toBe(true);
    expect(existsSync(a.dir)).toBe(false);
  });

  it('TTL 失効と容量超過の退避は所有者に関係なく効く(資源管理は認可判定ではない)', async () => {
    const { mgr, handles } = makeManager(2);
    const a = await startAs(mgr, ALICE);
    await vi.advanceTimersByTimeAsync(10);
    const b = await startAs(mgr, BOB);
    await vi.advanceTimersByTimeAsync(10);
    mgr.touch(a.id);
    // 容量 2 の状態で 3 つ目 → LRU の b(別人のセッション)が退避される。
    await startAs(mgr, ALICE);
    expect(mgr.get(b.id, BOB)).toBeUndefined();
    expect(handles[1].close).toHaveBeenCalledOnce();
    expect(existsSync(b.dir)).toBe(false);

    // TTL 失効も同じく所有者を問わない。
    await vi.advanceTimersByTimeAsync(TTL);
    expect(mgr.list(ADMIN)).toHaveLength(0);
  });

  it('ローカルモードのセンチネル actor は全一致する(意図的な素通しを契約として固定する)', async () => {
    // `requireAuth=false` は単一端末利用が前提で、ここは意図的に素通しである。将来
    // 「なぜか通る」と読まれないよう、素通しであること自体をテストで宣言しておく。
    const { mgr } = makeManager();
    const a = await startAs(mgr, LOCAL);
    expect(mgr.get(a.id, LOCAL)).toBeDefined();
    expect(mgr.list(LOCAL)).toHaveLength(1);
    await mgr.disposeAll();
  });
});
