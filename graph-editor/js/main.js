// =============================================================================
    // SVG ラベル位置 ビジュアル編集 — クライアント (バニラ JS, 依存ゼロ)
    // ローカルの小さな HTTP サーバ (app.py) から http://127.0.0.1 で配信され、OS の Edge を
    // アプリモードで開いて動作する。ファイル I/O はブラウザの File System Access API
    // (showOpenFilePicker / showSaveFilePicker) でネイティブダイアログを使う (localhost は
    // secure context なので利用可)。非対応ブラウザでは input/ダウンロードへフォールバックする。
    //
    // 構成: 状態 + ライフサイクル + 描画は Editor クラスに集約し、1ラベル分の状態と
    // DOM 同期は LabelState クラスが持つ。描画はホットパス (ドラッグ中の pointermove)
    // で個別の renderX を直呼びせず markDirty() で dirty フラグを立て、requestAnimationFrame
    // で 1 フレーム最大 1 回へ合流させる (描画スケジューラ)。インスペクタ/オーバーレイは
    // 構造シグネチャが変わった時だけ作り直し、通常フレームは読出し値/座標だけを更新する。
    // =============================================================================

import { dom } from "./dom.js";
import { drawIcons } from "./icons.js";
import { hasFsAccess } from "./utils.js";
import { STATUS_READY } from "./constants.js";
import { Editor } from "./editor.js";

// ---------------------------------------------------------------------------
    // 起動
    // ---------------------------------------------------------------------------

    // 静的マークアップ内のアイコンを描画
    drawIcons(document);

    const editor = new Editor(dom);
    editor.bindEvents();
    editor.updateToolbar();
    editor.goPhase(1);   // 最初は「ファイルを開く」画面
    // E2E テスト用フック (本番動作には無害)。Playwright から editor を操作するため公開。
    window.__editor = editor;

    // ローカルサーバから配信され、即操作可能。Edge(Chromium) なら FS Access API でネイティブ I/O。
    if (hasFsAccess()) {
      editor.setStatus(STATUS_READY);
    } else {
      editor.setStatus("簡易モード: 選択=ファイル選択 / 保存=ダウンロード (Edge 推奨)");
    }

    // 窓/タブを閉じたらローカルサーバへ終了を通知 (常駐プロセスを残さない)。
    window.addEventListener("pagehide", () => {
      try { navigator.sendBeacon("/quit"); } catch { /* 失敗してもプロセス監視側で終了する */ }
    });

    // 生存ハートビート。Edge アプリ窓ではプロセス監視で終了するが、既定ブラウザ(フォールバック)
    // 経路にはプロセスハンドルが無く、終了契機が pagehide ビーコンのみになる。ビーコン不達/タブ
    // クラッシュ時にサーバ側 watchdog が自動終了できるよう、定期的に生存を知らせる。
    setInterval(() => { fetch("/ping", { method: "POST", keepalive: true }).catch(() => { }); }, 10000);