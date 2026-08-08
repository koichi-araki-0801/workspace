// =============================================================================
// buildWorkerServer.ts — 実プロセス版 PDF ビルドワーカー + プール singleton
// =============================================================================
// `buildWorkerPool.ts`(純粋・DI)に対する実体側。`child_process.fork` で常駐ワーカー
// (`scripts/pdf-build-worker-daemon.mjs`)を起こし、IPC でジョブを往復させる `BuildWorker` を
// 提供する。`previewManager.ts`(純粋) と `previewServer.ts`(実 cli starter) の分割に倣い、
// 実プロセス依存はここへ閉じる(coverage 対象外)。
import { type ChildProcess, fork, spawn } from 'node:child_process';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { type BuildWorker, BuildWorkerPool } from './buildWorkerPool.js';

/** daemon の IPC 応答(`pdf-build-worker-daemon.mjs` の契約)。 */
interface WorkerReply {
  id: number;
  ok: boolean;
  error?: string;
}

/**
 * `fork` した常駐 daemon を 1 プロセス内包する `BuildWorker`。プールが直列化するため、同時に
 * 1 ジョブのみ in-flight になる(`pending` は最大 1 件)。
 */
class ForkedBuildWorker implements BuildWorker {
  private readonly child: ChildProcess;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  private readonly exitCbs: ((err?: Error) => void)[] = [];
  private dead = false;

  constructor(script: string) {
    // stdio: stdin 無視 / stdout・stderr は親へ継承(vivliostyle ログ可視) / IPC チャネル。
    this.child = fork(script, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    this.child.on('message', (raw) => {
      const msg = raw as WorkerReply;
      const p = this.pending.get(msg?.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve();
      else p.reject(new Error(msg.error || 'PDFの生成に失敗しました'));
    });
    this.child.on('exit', () => this.onDead());
    this.child.on('error', (e) => this.onDead(e));
  }

  run(opts: unknown): Promise<void> {
    if (this.dead) return Promise.reject(new Error('PDF build worker は終了しています'));
    const id = ++this.seq;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ id, opts }, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  kill(): void {
    if (this.dead) return;
    this.dead = true;
    // daemon は `@vivliostyle/cli` の `build()` 経由で headless chromium を *子プロセス* として
    // 起こす。Windows の `child.kill('SIGKILL')` は当該プロセスのみを殺し子孫へ伝播しないため、
    // daemon だけ消えて chromium が孤児化する。OS 標準の `taskkill /T`(ツリー)/`/F`(強制) で
    // 子孫ごと一掃する(`tree-kill` npm 追加はオフラインバンドル方針に反するため不採用)。
    const pid = this.child.pid;
    if (process.platform === 'win32' && pid) {
      // fire-and-forget。`taskkill` 不在等の起動失敗で出る `'error'` を握り潰さないと
      // unhandled となり親 server 全体が落ちるため、必ずハンドラを付ける。起動に失敗した
      // ときは最終手段として daemon 本体だけでも SIGKILL で確実に落とす(ツリーは殺せず
      // chromium 子孫の孤児化は残るが、daemon 生存でプールが再起動を繰り返す最悪を防ぐ)。
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' }).on('error', () => {
        this.child.kill('SIGKILL');
      });
      return;
    }
    this.child.kill('SIGKILL');
  }

  onExit(cb: (err?: Error) => void): void {
    this.exitCbs.push(cb);
  }

  /** プロセス消滅(自然 exit/クラッシュ/kill)を 1 度だけ処理: 保留ジョブを reject し通知する。 */
  private onDead(err?: Error): void {
    if (this.dead) {
      // kill() 由来。保留があれば後始末だけ行う(onExit cb は呼ばない=プールが除去済み)。
      this.rejectPending(err);
      return;
    }
    this.dead = true;
    this.rejectPending(err);
    for (const cb of this.exitCbs) cb(err);
  }

  private rejectPending(err?: Error): void {
    const e = err ?? new Error('PDFの生成に失敗しました: ワーカーが異常終了しました');
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }
}

/**
 * プロセス全体で共有する PDF ビルドワーカープール。実 daemon を fork する factory を注入する。
 * `build.ts` の `runBuildWorker` がここへ委譲し、`app.ts` の shutdown が `disposeAll()` を呼ぶ。
 */
export const buildWorkerPool = new BuildWorkerPool({
  poolSize: config.vivliostyle.build.poolSize,
  idleTtlMs: config.vivliostyle.build.idleTtlMs,
  timeoutMs: config.vivliostyle.build.timeoutMs,
  maxQueue: config.vivliostyle.build.maxQueue,
  factory: () => {
    logger.info('[pdf] ウォームワーカーを起動します(@vivliostyle/cli を読込)');
    return new ForkedBuildWorker(config.pdf.workerDaemonScript);
  },
});
