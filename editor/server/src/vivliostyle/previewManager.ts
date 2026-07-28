// =============================================================================
// previewManager.ts — vivliostyle プレビューセッションの管理(cli 非依存・DI)
// =============================================================================
import crypto from 'node:crypto';
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

/** 何をプレビューするか、加えて停止時に manager が削除すべき temp ディレクトリ。 */
export interface PreviewSpec {
  mode: 'inline' | 'project';
  /** エントリファイル(inline html、または config 不在時のプロジェクトエントリ)。 */
  input?: string;
  /** `vivliostyle.config.*` のパス(project・優先)。 */
  configPath?: string;
  /** エントリファイルからビルドする際のプロジェクトルート(cwd)。 */
  cwd?: string;
  size?: string;
  singleDoc?: boolean;
  /** セッション停止時に削除する temp ディレクトリ。 */
  workDir: string;
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
    this.opts = opts;
  }

  /** プレビューを開始する。容量到達時は least-recently-used セッションを退避する。 */
  async start(spec: PreviewSpec): Promise<PreviewSessionMeta> {
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
    });
    return meta;
  }

  /** プロキシ用の listen ポート。セッションが不明なら undefined。 */
  portOf(id: string): number | undefined {
    return this.sessions.get(id)?.handle.port;
  }

  get(id: string): PreviewSessionMeta | undefined {
    return this.sessions.get(id)?.meta;
  }

  list(): PreviewSessionMeta[] {
    return [...this.sessions.values()].map((s) => s.meta);
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

  /** セッションを停止する: タイマー解除、サーバ終了、temp ディレクトリ削除。 */
  async stop(id: string): Promise<boolean> {
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
    await Promise.allSettled(ids.map((id) => this.stop(id)));
  }

  private arm(id: string): NodeJS.Timeout {
    const t = setTimeout(() => void this.stop(id), this.opts.idleTtlMs);
    // アイドルなプレビューが単独でプロセスを生かし続けてはならない。
    t.unref?.();
    return t;
  }

  private async evictOldest(): Promise<void> {
    let oldest: Session | undefined;
    for (const s of this.sessions.values()) {
      if (!oldest || s.lastAccessMs < oldest.lastAccessMs) oldest = s;
    }
    if (oldest) await this.stop(oldest.meta.id);
  }
}
