// =============================================================================
// browserLaunchGuard.realBrowser.test.ts — 実ブラウザで WebRTC の ICE 候補が出ないこと(任意実行)
// =============================================================================
// フラグの名前を間違えても Chromium は黙って無視し、単体テストは通ってしまう。効き目は実ブラウザで
// しか確かめられないので、本物のワーカー(`pdf-build-worker.mjs`)で ICE 候補を列挙する文書を PDF に
// し、PDF の文字に候補が出ないことを見る。
//
// 既定では skip する(ブラウザの起動に数秒〜十数秒かかり、CI の既定の環境にブラウザがあるとは
// 限らない)。`EDITOR_REAL_BROWSER_TEST=1` のときだけ走る。ブラウザは
// `VIVLIOSTYLE_EXECUTABLE_BROWSER`、無ければ Windows の Edge の既定の置き場を使う。
// STUN の宛先は 127.0.0.1 にして、外のホストへは何も送らない。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const ENABLED = process.env.EDITOR_REAL_BROWSER_TEST === '1';

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const browser =
  process.env.VIVLIOSTYLE_EXECUTABLE_BROWSER ?? EDGE_CANDIDATES.find((p) => fs.existsSync(p));

/**
 * ICE 候補を本文へ書き出す文書。候補が 1 つでも出れば `cands:N` と候補(アドレスと種類)が
 * 並ぶ。フラグが効いていればプロキシの無い UDP は使われず、候補は出ない(`started` のまま)。
 */
const ICE_DOC = `<!doctype html><html><head><meta charset="utf-8"><title>ice</title></head>
<body><p id="r">x</p>
<script>
try {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:3478' }] });
  pc.createDataChannel('d');
  const c = [];
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    c.push(e.candidate.candidate.split(' ').slice(2, 8).join(' '));
    document.getElementById('r').textContent = 'cands:' + c.length + ' ' + c.join(' | ');
  };
  pc.createOffer().then((o) => pc.setLocalDescription(o));
  document.getElementById('r').textContent = 'started';
} catch (e) {
  document.getElementById('r').textContent = 'err ' + e;
}
</script></body></html>
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-real-browser-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** PDF の全ページの文字(CLI が持つ mupdf で読む)。 */
async function pdfText(file: string): Promise<string> {
  const { findPackageDir, importTargetOf } = await import('../scripts/browserLaunchGuard.mjs');
  const cliEntry = fs.realpathSync(new URL(import.meta.resolve('@vivliostyle/cli')));
  const dir = findPackageDir(cliEntry, 'mupdf');
  if (!dir) throw new Error('mupdf が見つかりません');
  const mupdf = await import(pathToFileURL(path.resolve(dir, importTargetOf(dir))).href);
  const doc = mupdf.Document.openDocument(fs.readFileSync(file), 'application/pdf');
  let text = '';
  for (let i = 0; i < doc.countPages(); i++) {
    text += doc.loadPage(i).toStructuredText().asText();
  }
  return text;
}

const d = ENABLED && browser ? describe : describe.skip;

d('実ブラウザの WebRTC(EDITOR_REAL_BROWSER_TEST=1 のときだけ)', () => {
  it('本物のワーカーで組んだ PDF に ICE 候補が 1 つも出ない', { timeout: 180_000 }, async () => {
    const input = path.join(tmp, 'ice.html');
    const output = path.join(tmp, 'ice.pdf');
    fs.writeFileSync(input, ICE_DOC, 'utf8');
    const worker = path.join(import.meta.dirname, '..', 'scripts', 'pdf-build-worker.mjs');
    await promisify(execFile)(
      process.execPath,
      [
        worker,
        JSON.stringify({
          input,
          output: [{ path: output, format: 'pdf' }],
          executableBrowser: browser,
          logLevel: 'silent',
        }),
      ],
      { timeout: 170_000 },
    );
    const text = await pdfText(output);
    // 文書の script は動いている(動かなければ `x` のまま)。
    expect(text).not.toMatch(/(^|\s)x(\s|$)/);
    expect(text).not.toContain('err ');
    // 候補が出ていない(host・srflx・mDNS のどれも)。
    expect(text).not.toMatch(/cands:[1-9]/);
    expect(text).not.toMatch(/\b(udp|tcp)\b/i);
    expect(text).toContain('started');
  });
});
