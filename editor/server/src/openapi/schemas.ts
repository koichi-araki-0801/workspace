// =============================================================================
// schemas.ts — API 契約 Zod スキーマの再エクスポート(正典は @editor/shared/schemas)
// =============================================================================
// 正典は shared 側にある(web/server 共通のワイヤ契約であり、`api-paths.ts` と同じく
// shared に置く)。routes/document.ts の import パス(`../openapi/schemas.js`)を維持するための
// 互換レイヤであり、ここへスキーマを追加してはならない — 追加は `@editor/shared/schemas` へ。
export * from '@editor/shared/schemas';
