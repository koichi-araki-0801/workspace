// =============================================================================
// resourceLimits.test.ts — 契約の段で本文の大きさを縛れていることの検証
// =============================================================================
// editor は単一プロセスで、本文を同期で走査する経路が複数ある。上限が無い契約は
// 「グローバル `bodyLimit` だけが天井」になり、経路ごとの上限引き上げがそのまま各走査の
// 上限引き上げになる。ここで主張するのは**速さではなく「上限が効くこと」**である。
import { describe, expect, it } from 'vitest';
import {
  AddNoteRequest,
  BuildInlineRequest,
  BuildMergeDocument,
  FundAssetRef,
  MAX_DOCUMENT_CSS_CHARS,
  MAX_DOCUMENT_HTML_CHARS,
  MAX_NOTE_CONTENT_CHARS,
  MAX_NOTE_PATH_KEY_CHARS,
  RecordPdfExportRequest,
  SubmitReviewBody,
} from '../src/schemas.js';

const chars = (n: number): string => 'a'.repeat(n);

describe('上限値の固定(変更に「テストを直す」意思決定を伴わせる)', () => {
  it('文書とメモの上限', () => {
    expect(MAX_DOCUMENT_HTML_CHARS).toBe(4 * 1024 * 1024);
    expect(MAX_DOCUMENT_CSS_CHARS).toBe(1024 * 1024);
    expect(MAX_NOTE_CONTENT_CHARS).toBe(64 * 1024);
    expect(MAX_NOTE_PATH_KEY_CHARS).toBe(512);
  });
});

describe('build の本文上限', () => {
  it('inline: html / css とも上限ちょうどは通り、1 文字超で落ちる', () => {
    expect(
      BuildInlineRequest.safeParse({ html: chars(MAX_DOCUMENT_HTML_CHARS), css: '' }).success,
    ).toBe(true);
    expect(
      BuildInlineRequest.safeParse({ html: chars(MAX_DOCUMENT_HTML_CHARS + 1), css: '' }).success,
    ).toBe(false);
    expect(
      BuildInlineRequest.safeParse({ html: '<p>x</p>', css: chars(MAX_DOCUMENT_CSS_CHARS + 1) })
        .success,
    ).toBe(false);
  });

  it('merge の 1 文書も同じ上限を持つ(文書数上限だけでは天井にならない)', () => {
    expect(
      BuildMergeDocument.safeParse({ html: chars(MAX_DOCUMENT_HTML_CHARS + 1), css: '' }).success,
    ).toBe(false);
  });
});

describe('確定保存申請の本文上限', () => {
  const base = {
    templateId: 'AM01_510037_20240710_交付版',
    css: '',
    fundCode: '510037',
    origin: 'edit' as const,
  };

  it('html / css / filledHtml に上限がある', () => {
    expect(SubmitReviewBody.safeParse({ ...base, html: '<p>x</p>' }).success).toBe(true);
    expect(
      SubmitReviewBody.safeParse({ ...base, html: chars(MAX_DOCUMENT_HTML_CHARS + 1) }).success,
    ).toBe(false);
    expect(
      SubmitReviewBody.safeParse({
        ...base,
        html: '<p>x</p>',
        css: chars(MAX_DOCUMENT_CSS_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(
      SubmitReviewBody.safeParse({
        ...base,
        html: '<p>x</p>',
        filledHtml: chars(MAX_DOCUMENT_HTML_CHARS + 1),
      }).success,
    ).toBe(false);
  });
});

describe('PDF 監査記録の templateId', () => {
  // 読み側は末尾 4MiB しか読まないので、読み窓より長い 1 行を書けるだけで
  // それ以前の履歴が API の視界から落ちる(= 監査フィードの消去)。
  it('id 規約に一致する値だけを受ける(素の文字列ではない)', () => {
    expect(
      RecordPdfExportRequest.safeParse({ templateId: 'AM01_510037_20240710_交付版' }).success,
    ).toBe(true);
    expect(RecordPdfExportRequest.safeParse({ templateId: chars(8 * 1024 * 1024) }).success).toBe(
      false,
    );
    expect(RecordPdfExportRequest.safeParse({ templateId: 'notatemplate' }).success).toBe(false);
  });
});

describe('メモ追加の上限', () => {
  it('pathKey / content とも上限を超えると落ちる', () => {
    expect(AddNoteRequest.safeParse({ pathKey: 'p0/p1', content: 'メモ' }).success).toBe(true);
    expect(
      AddNoteRequest.safeParse({ pathKey: chars(MAX_NOTE_PATH_KEY_CHARS + 1), content: 'x' })
        .success,
    ).toBe(false);
    expect(
      AddNoteRequest.safeParse({ pathKey: 'p0', content: chars(MAX_NOTE_CONTENT_CHARS + 1) })
        .success,
    ).toBe(false);
  });
});

describe('文字数の数え方', () => {
  // zod 4.6 から `.max(N)` はコードポイントで数える。local の上限判定(`noteRepo.ts`)と
  // 揃える前提なので、ここで固定しておく(zod の数え方が戻ると両者がずれる)。
  it('`.max(N)` は 𠮷 / 絵文字を 1 文字と数える', () => {
    expect(
      AddNoteRequest.safeParse({ pathKey: 'p0', content: '𠮷'.repeat(MAX_NOTE_CONTENT_CHARS) })
        .success,
    ).toBe(true);
    expect(
      AddNoteRequest.safeParse({ pathKey: '😀'.repeat(MAX_NOTE_PATH_KEY_CHARS), content: 'x' })
        .success,
    ).toBe(true);
  });
});

describe('画像の参照の名前の上限', () => {
  // ファイル名とフォルダ名は NTFS の 1 要素あたり 255 単位(UTF-16)が上限。`.max(255)` は
  // コードポイントで数えるので、サロゲートペアの名前だけ別に縛らないと 256 単位以上が通る。
  it('UTF-16 で 255 単位を超える名前は拒否する', () => {
    expect(FundAssetRef.safeParse({ dir: null, file: '𠮷'.repeat(127) }).success).toBe(true);
    expect(FundAssetRef.safeParse({ dir: null, file: '𠮷'.repeat(128) }).success).toBe(false);
    expect(FundAssetRef.safeParse({ dir: '𠮷'.repeat(128), file: 'a.png' }).success).toBe(false);
    expect(FundAssetRef.safeParse({ dir: 'a'.repeat(255), file: 'a'.repeat(255) }).success).toBe(
      true,
    );
  });
});
