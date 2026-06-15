// lib/leader_geom.cjs (classic <script>) が生やす global `LeaderGeom` を ES モジュールへ橋渡しする。
// cjs 側は vitest(node) と ui.html(browser) で共有する UMD のため、ここでは取り込み・再エクスポートのみ。
const { parsePath, buildPath, parseTranslate, normColor, clampPointToBox } = window.LeaderGeom;

export { parsePath, buildPath, parseTranslate, normColor, clampPointToBox };
