/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

interface ImportMetaEnv {
  /** Data source: 'rest' uses the SQL Server backend, else local (default). */
  readonly VITE_API_MODE?: 'local' | 'rest';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
