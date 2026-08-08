// =============================================================================
// previewManager.ts — vivliostyle プレビューセッションの管理(cli 非依存・DI)
// =============================================================================
import crypto from 'node:crypto';
import type { SafeProjectConfig } from './projectConfig.js';
import { cleanupProject } from './projectInput.js';

/** 起動中のプレビューサーバ。manager を cli 非依存(DI)に保つため抽象化する。 */
export interface PreviewServerHandle {
  /** プレビュー(Vite)サーバが実際に listen するポート。 */
  port: number;
  /**
   * cli が生成した絶対 viewer URL(origin + `/__vivliostyle-viewer/...`
   * `#src=<絶対ソース URL>`)。manager はその origin をプロキシ接頭辞へ書き換え、
   * ブラウザが viewer とそのソースの双方へ公開ポート(:24680)経由で到達できるようにする。
   */
  viewerUrl?: string;
  /** サーバを停止しポートを解放する。 */
  close: () => Promise<void>;
}

/**
 * cli の絶対 viewer URL を書き換え、同一 origin の参照(viewer ページと `#src=`
 * ドキュメント)がすべてリバースプロキシ接頭辞を指すようにする。viewer URL を
 * 捕捉できなかった場合はプロキシのルートにフォールバックする。
 */
export function proxyViewerUrl(id: string, viewerUrl: string | undefined): string {
  const prefix = `/api/preview/${id}`;
  if (!viewerUrl) return `${prefix}/`;
  try {
    const origin = new URL(viewerUrl).origin;
    return viewerUrl.split(origin).join(prefix);
  } catch {
    return `${prefix}/`;
  }
}

/** セッション id の字面(`crypto.randomUUID` の生成形)。生成と検査を 1 箇所で対にする。 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 何をプレビューするか、加えて停止時に manager が削除すべき temp ディレクトリ。 */
export interface PreviewSpec {
  mode: 'inline' | 'project';
  /** エントリファイル(inline html、または config 不在時のプロジェクトエントリ)。 */
  input?: string;
  /**
   * 許可リストで組み直した config(project・優先)。CLI へは `configData` で渡すので、
   * ファイルパスは持ち回らない(`projectConfig.ts` を見よ)。
   */
  config?: SafeProjectConfig;
  /** エントリファイルからビルドする際のプロジェクトルート(cwd)。 */
  cwd?: string;
  size?: string;
  singleDoc?: boolean;
  /** セッション停止時に削除する temp ディレクトリ。 */
  workDir: string;
  /**
   * 文書と資産が配信される path 接頭辞(cli の `config.base`)。プロキシの許可リストは
   * これと `/__vivliostyle-viewer` だけを通すので、セッションの属性として持ち回る。
   */
  docBase: string;
}

/**
 * プレビュー操作の主体。所有者検査(IDOR)にだけ使うので、監査ログ用の `actorFromReq`
 * (未認証を `anonymous` へ潰す)は流用しない — 認可判定で未認証を 1 つの名前へ畳むのは危険。
 */
export interface PreviewActor {
  loginId: string;
  isAdmin: boolean;
}

/** spec に対しプレビューサーバを起動する。テストが実ブラウザを避けられるよう注入する。 */
type PreviewStarter = (spec: PreviewSpec, host: string) => Promise<PreviewServerHandle>;

/** プレビューセッションの公開・直列化可能なビュー(サーバ内部を含まない)。 */
interface PreviewSessionMeta {
  id: string;
  mode: 'inline' | 'project';
  createdAt: string;
  expiresAt: string;
  url: string;
}

interface Session {
  meta: PreviewSessionMeta;
  handle: PreviewServerHandle;
  workDir: string;
  lastAccessMs: number;
  timer: NodeJS.Timeout;
  /**
   * 作成者の loginId。`PreviewSessionMeta`(外部契約)へは載せない — 他人に見せる必要が
   * 無く、`list()` で絞る方が漏れない。
   */
  owner: string;
  docBase: string;
}

/** プロキシが 1 回の lookup で必要とする値。port と docBase を別々に引くと、その間に
 * TTL 失効や `evictOldest` が走って「別セッションの docBase で別セッションの port へ
 * 転送する」形が理論上作れるため、1 つにまとめる。 */
export interface PreviewTarget {
  port: number;
  docBase: string;
}

interface PreviewManagerOptions {
  idleTtlMs: number;
  maxSessions: number;
  host: string;
  starter: PreviewStarter;
}

/**
 * 起動中の vivliostyle プレビューサーバを追跡する: 件数の上限、アイドル自動失効、
 * サーバと temp ディレクトリ双方の決定的なクリーンアップ。インメモリのみで、セッションは
 * プロセス再起動を跨いで残らない(単一筐体デプロイなら問題ない)。
 */
export class PreviewManager {
  private readonly sessions = new Map<string, Session>();
  private readonly opts: PreviewManagerOptions;

  constructor(opts: PreviewManagerOptions) {
    // `maxSessions` が NaN だと `size >= NaN` が常に false になり eviction が一切
    // 起きない(各セッションは Vite サーバをメモリに保持するので無制限に積める)。
    // config 側の env parse だけを直すのは「入口 1 つを塞ぐ」形なので、値を使う側でも
    // 不変則として要求する。`idleTtlMs` も NaN だと setTimeout が 1ms 扱いになる。
    for (const key of ['maxSessions', 'idleTtlMs'] as const) {
      const v = opts[key];
      if (!Number.isInteger(v) || v <= 0)
        throw new Error(`[previewManager] ${key} は正の整数である必要があります(受領値: ${v})`);
    }
    this.opts = opts;
  }

  /** プレビューを開始する。容量到達時は least-recently-used セッションを退避する。 */
  async start(spec: PreviewSpec, owner: PreviewActor): Promise<PreviewSessionMeta> {
    if (this.sessions.size >= this.opts.maxSessions) await this.evictOldest();

    let handle: PreviewServerHandle;
    try {
      handle = await this.opts.starter(spec, this.opts.host);
    } catch (e) {
      // サーバが起動しなかった。受け取った temp ディレクトリを破棄する。
      await cleanupProject(spec.workDir);
      throw e;
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const meta: PreviewSessionMeta = {
      id,
      mode: spec.mode,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.opts.idleTtlMs).toISOString(),
      url: proxyViewerUrl(id, handle.viewerUrl),
    };
    this.sessions.set(id, {
      meta,
      handle,
      workDir: spec.workDir,
      lastAccessMs: now,
      timer: this.arm(id),
      owner: owner.loginId,
      docBase: spec.docBase,
    });
    return meta;
  }

  /**
   * 所有者検査を通したセッションを引く。**不一致は「セッションが無い」と同じ扱い**にして、
   * ルートが一律 404 を返せるようにする(403 は存在オラクルになる)。
   */
  private owned(id: string, actor: PreviewActor): Session | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    return s.owner === actor.loginId || actor.isAdmin ? s : undefined;
  }

  /** プロキシが必要とする port + docBase。不明・他人のセッションなら undefined。 */
  resolveFor(id: string, actor: PreviewActor): PreviewTarget | undefined {
    const s = this.owned(id, actor);
    return s ? { port: s.handle.port, docBase: s.docBase } : undefined;
  }

  get(id: string, actor: PreviewActor): PreviewSessionMeta | undefined {
    return this.owned(id, actor)?.meta;
  }

  list(actor: PreviewActor): PreviewSessionMeta[] {
    return [...this.sessions.values()]
      .filter((s) => actor.isAdmin || s.owner === actor.loginId)
      .map((s) => s.meta);
  }

  /** アクセス時にアイドル TTL を更新する(プロキシが呼ぶ)。不明なら false。 */
  touch(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    clearTimeout(s.timer);
    const now = Date.now();
    s.lastAccessMs = now;
    s.meta.expiresAt = new Date(now + this.opts.idleTtlMs).toISOString();
    s.timer = this.arm(id);
    return true;
  }

  /**
   * セッションを停止する(公開経路)。他人のセッションは空振り(false)にして、`workDir` も
   * 消さない — `stop` は `cleanupProject` まで行うので、素通しすると他人の作業を消せる。
   */
  async stop(id: string, actor: PreviewActor): Promise<boolean> {
    if (!this.owned(id, actor)) return false;
    return this.stopInternal(id);
  }

  /**
   * 所有者を問わない内部停止。TTL 失効・容量超過の退避・プロセス終了は資源管理であって
   * 認可判定ではないので、こちらを使う。
   */
  private async stopInternal(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.sessions.delete(id);
    clearTimeout(s.timer);
    await Promise.allSettled([s.handle.close(), cleanupProject(s.workDir)]);
    return true;
  }

  /** すべてのセッションを停止する(プロセス終了時)。 */
  async disposeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.allSettled(ids.map((id) => this.stopInternal(id)));
  }

  private arm(id: string): NodeJS.Timeout {
    const t = setTimeout(() => void this.stopInternal(id), this.opts.idleTtlMs);
    // アイドルなプレビューが単独でプロセスを生かし続けてはならない。
    t.unref?.();
    return t;
  }

  private async evictOldest(): Promise<void> {
    let oldest: Session | undefined;
    for (const s of this.sessions.values()) {
      if (!oldest || s.lastAccessMs < oldest.lastAccessMs) oldest = s;
    }
    if (oldest) await this.stopInternal(oldest.meta.id);
  }
}
