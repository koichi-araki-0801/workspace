// =============================================================================
// types/subset-font.d.ts — `subset-font` の型宣言(公式の型は無い)
// -----------------------------------------------------------------------------
// 実体は `module.exports = (...args) => limiter(() => subsetFont(...args))` の CJS で、
// 本プロジェクトが使うのは `(buffer, chars, { targetFormat })` の 1 形だけ。全 option を
// 写すと本家の変更に追随できないので、使う分だけ宣言する。
// =============================================================================

declare module 'subset-font' {
  const subsetFont: (
    font: Buffer,
    text: string,
    options: { targetFormat: string },
  ) => Promise<Buffer>;
  export default subsetFont;
}
