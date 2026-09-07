// =============================================================================
// sea_runtime.test.ts — SEA(単一 exe)のアセット許可リストとモジュール解決封鎖
// -----------------------------------------------------------------------------
// 主張するのは「正しい入力が通ること」ではなく **迂回入力が失敗すること**。ここが緩むと、
// exe の隣や上位ディレクトリに置いた偽 `subset-font` / 偽フォントが署名の外から読み込まれる
// 許可リストは集合メンバシップと完全一致だけで書く約束なので、
// `startsWith` / `includes` / 拡張子判定へ緩めた実装がここで落ちるようにしてある。
// =============================================================================

import Module, { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HB_WASM_SENTINEL,
  HB_WASM_SPECIFIER,
  SEA_ASSET_KEYS,
  assertSeaAssetKey,
  installModuleResolutionBlock,
  installSeaGuards,
  isSea,
  readSeaAsset,
  resolveSeaRequest,
} from '../src/runtime/seaRuntime.js';

type Runtime = typeof import('../src/runtime/seaRuntime.js');
type ModuleLoad = (request: string, ...rest: unknown[]) => unknown;
const internals = Module as unknown as { _resolveFilename?: unknown; _load?: ModuleLoad };
const originalResolve = internals._resolveFilename;
const originalLoad = internals._load;

/**
 * SEA の ambient `require('node:sea')` の戻り値を装う。vitest(vite-node)はモジュールごとに
 * `createRequire(href)` で作った**本物の** require をラッパ関数のローカル引数として注入する
 * ため、`vi.stubGlobal('require', ...)` はこの引数に隠れて届かない(グローバルの `require` を
 * 差し替えても、実行中のモジュールはローカル引数の方を見る)。実 require が最終的に通す
 * `Module._load` を `'node:sea'` だけ差し替える形で装う(他の specifier は元の実装へ素通し)。
 */
function stubSeaRequire(api: unknown): void {
  internals._load = (request: string, ...rest: unknown[]) => {
    if (request === 'node:sea') {
      if (api instanceof Error) throw api;
      return api;
    }
    return (originalLoad as ModuleLoad)(request, ...rest);
  };
}

/** モジュール内 `guardsInstalled` フラグを毎回まっさらにする。 */
async function freshRuntime(): Promise<Runtime> {
  vi.resetModules();
  return import('../src/runtime/seaRuntime.js');
}

describe('SEA アセットの許可リスト', () => {
  it('許可キーはメンバシップ判定で受ける', () => {
    for (const key of SEA_ASSET_KEYS) {
      expect(() => assertSeaAssetKey(key)).not.toThrow();
    }
  });

  // 迂回の狙い所: basename 経由の間接指定・部分一致・型のすり替え。`cfg.embedFontPath` は
  // 外部から任意の値を渡せるため、その basename がそのままキーになりうる。
  const bypasses: Array<[string, unknown]> = [
    ['親ディレクトリへの遡り', '..\\..\\evil.woff2'],
    ['前方一致での通過狙い', 'BIZUDPGothic-Regular.woff2.bak'],
    ['後方一致での通過狙い', 'x/BIZUDPGothic-Regular.woff2'],
    ['末尾空白', 'BIZUDPGothic-Regular.woff2 '],
    ['大文字化', 'BIZUDPGOTHIC-REGULAR.WOFF2'],
    ['空文字', ''],
    ['絶対パス', 'C:\\Windows\\System32\\evil.woff2'],
    ['拡張子だけ一致', 'evil.wasm'],
    ['文字列でない', 123],
    ['null', null],
    ['undefined', undefined],
  ];
  for (const [label, key] of bypasses) {
    it(`許可リスト外を拒む: ${label}`, () => {
      expect(() => assertSeaAssetKey(key)).toThrow(/not in the allowlist/);
    });
  }

  it('許可リスト外は readSeaAsset の入口で落ちる(SEA 判定より前)', () => {
    // 非 SEA でも「許可リスト外」で落ちること。ここが SEA 判定の後ろに来ると、exe 内で
    // 任意キーの読み出しが試みられる形になる。
    expect(() => readSeaAsset('..\\..\\evil.woff2')).toThrow(/not in the allowlist/);
    // 許可キーは別の理由(非 SEA)で落ちる = 順序が正しいことの裏取り。
    expect(() => readSeaAsset('hb-subset.wasm')).toThrow(/only available inside/);
  });
});

describe('require.resolve の許可リスト shim', () => {
  it('唯一の許可 specifier だけが sentinel を返す', () => {
    expect(resolveSeaRequest(HB_WASM_SPECIFIER)).toBe(HB_WASM_SENTINEL);
  });

  // `.wasm` で終わるなら通す・部分一致で通すといった述語へ緩めると、ここが素通りになる。
  const rejected: unknown[] = [
    './hb-subset.wasm',
    'harfbuzzjs/hb-subset.wasm ',
    ' harfbuzzjs/hb-subset.wasm',
    'HARFBUZZJS/HB-SUBSET.WASM',
    'harfbuzzjs/hb-subset.wasm\0',
    'x/harfbuzzjs/hb-subset.wasm',
    'harfbuzzjs',
    'subset-font',
    'node:fs',
    '',
    42,
  ];
  for (const request of rejected) {
    it(`許可 specifier 以外を拒む: ${JSON.stringify(request)}`, () => {
      expect(() => resolveSeaRequest(request)).toThrow(/require\.resolve is disabled/);
    });
  }
});

describe('Module._resolveFilename の封鎖', () => {
  // 攻撃経路そのもの(`createRequire` による上位ディレクトリ遡り)で検査する。exe は
  // `createRequire(...)('subset-font')` の形で偽モジュールを掴まされていた。
  const req = createRequire(import.meta.url);

  it('builtin だけ通し、ファイル解決はすべて拒む', () => {
    const restore = installModuleResolutionBlock();
    try {
      // builtin は素通し(`node:sea` / `node:fs` などランタイム自身が要る)。
      expect(() => req.resolve('node:path')).not.toThrow();
      expect(() => req.resolve('path')).not.toThrow();
      // 実在パッケージも、相対パスも、絶対パスの偽物も一律で拒む。
      for (const request of [
        'subset-font',
        'lodash',
        './evil.js',
        '../../evil.js',
        'C:\\evil.js',
      ]) {
        expect(() => req.resolve(request)).toThrow(/external module resolution is disabled/);
      }
    } finally {
      restore();
    }
    // 復元後は元どおり(テストが後続のモジュール読み込みを壊さないことの確認)。
    expect(() => req.resolve('subset-font')).not.toThrow();
  });
});

describe('dev(非 SEA)では何もしない', () => {
  it('isSea は false で installSeaGuards は no-op', () => {
    const req = createRequire(import.meta.url);
    expect(isSea()).toBe(false);
    installSeaGuards();
    // 封鎖が dev に漏れると、テストや tsx 実行が丸ごと動かなくなる。
    expect(() => req.resolve('subset-font')).not.toThrow();
  });
});

// `Module._load` / `Module._resolveFilename` の書換えはプロセス全体へ波及するため、
// このブロックの各 it は必ず afterEach で両方を元に戻す(失敗時も afterEach は走るので
// 後続テストへ漏れない)。
afterEach(() => {
  internals._load = originalLoad;
  internals._resolveFilename = originalResolve;
});

describe('SEA 実行時の経路', () => {
  it('require が node:sea を投げれば非 SEA(dev と同じ振る舞い)', async () => {
    stubSeaRequire(new Error('no sea'));
    const rt = await freshRuntime();
    expect(rt.isSea()).toBe(false);
  });

  it('SEA では許可キーのアセットを getAsset のコピーで返す', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    stubSeaRequire({ isSea: () => true, getAsset: () => bytes.buffer.slice(0) });
    const rt = await freshRuntime();
    expect(rt.isSea()).toBe(true);
    expect([...rt.readSeaAsset('hb-subset.wasm')]).toEqual([1, 2, 3]);
    expect(() => rt.readSeaAsset('..\\evil.woff2')).toThrow(/not in the allowlist/);
  });

  it('SEA では installSeaGuards が解決封鎖を張り、2 度目は何もしない', async () => {
    // `req.resolve` に何が代入されたかは、production 側が握るローカル require の
    // オブジェクト同一性を外から観測できない(vite-node のラッパ引数のため)ので検証しない。
    // ここでは observable な副作用 = `Module._resolveFilename` の書換えだけを固定する。
    stubSeaRequire({ isSea: () => true, getAsset: () => new ArrayBuffer(0) });
    const rt = await freshRuntime();
    rt.installSeaGuards();
    expect(() => (internals._resolveFilename as (r: string) => string)('lodash')).toThrow(
      /external module resolution is disabled/,
    );
    // builtin は封鎖の後も解決できる(sentinel には「disabled」の文言が乗らないことだけ主張する)。
    expect(() => (internals._resolveFilename as (r: string) => string)('node:path')).not.toThrow(
      /disabled/,
    );
    const before = internals._resolveFilename;
    rt.installSeaGuards();
    expect(internals._resolveFilename).toBe(before);
  });

  it('Module._resolveFilename が無ければ封鎖を張れない事実を投げる(黙って素通しにしない)', async () => {
    const rt = await freshRuntime();
    internals._resolveFilename = undefined;
    expect(() => rt.installModuleResolutionBlock()).toThrow(/_resolveFilename is missing/);
  });
});
