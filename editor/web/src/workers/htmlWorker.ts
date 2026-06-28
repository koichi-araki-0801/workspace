// =============================================================================
// htmlWorker.ts — Comlink シェル(Worker エントリ)。実処理は htmlWorkerImpl が持つ
// =============================================================================
// Vite が `new Worker(new URL('./htmlWorker.ts', import.meta.url), {type:'module'})` で
// このファイルを Worker チャンクとしてバンドルする。重い diff/mask/render はメイン
// スレッドを塞がないよう、ここ(Worker)で linkedom により実行される。
import * as Comlink from 'comlink';
import { htmlWorkerImpl } from './htmlWorkerImpl';

Comlink.expose(htmlWorkerImpl);
