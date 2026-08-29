// =============================================================================
// index.ts — OpenAPI ドキュメントルータ(生成済み spec を配信)
// =============================================================================
// `/api` 配下にマウントされ、以下を公開する:
//   GET /api/openapi.json  — OpenAPI 3.1 ドキュメント(JSON)
// API リファレンス UI(`/api/docs`)は `docsRoutes.ts` が専用 CSP ごと受け持つ。
import type { FastifyInstance } from 'fastify';
import { getOpenApiDocument } from './document.js';

export async function openapiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/openapi.json', async () => getOpenApiDocument());
}

export { docsRoutes } from './docsRoutes.js';
export { getOpenApiDocument } from './document.js';
