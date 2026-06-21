/// <reference types="vite/client" />
// =============================================================================
// vite-env.d.ts — Vite クライアント環境の型宣言(`*.vue` import と env 変数)
// =============================================================================

declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

interface ImportMetaEnv {
  /** データソース: 'rest' は SQL Server backend, それ以外は local(既定)。 */
  readonly VITE_API_MODE?: 'local' | 'rest';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
