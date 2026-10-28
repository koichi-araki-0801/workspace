/// <reference types="vite/client" />
// =============================================================================
// vite-env.d.ts — Vite クライアント環境の型宣言(`*.vue` import)
// =============================================================================

declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
