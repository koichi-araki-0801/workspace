// =============================================================================
// index.ts — OpenAPI ドキュメントルータ(生成済み spec と Swagger UI を配信)
// =============================================================================
// `/api` 配下にマウントされ、以下を公開する:
//   GET /api/openapi.json  — OpenAPI 3.1 ドキュメント(JSON)
//   GET /api/docs          — Swagger UI
import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { getOpenApiDocument } from './document.js';

export const openapiRouter = Router();

openapiRouter.get('/openapi.json', (_req, res) => {
  res.json(getOpenApiDocument());
});

openapiRouter.use('/docs', swaggerUi.serve);
openapiRouter.get(
  '/docs',
  swaggerUi.setup(getOpenApiDocument(), {
    customSiteTitle: 'editor API',
    swaggerOptions: { docExpansion: 'list', defaultModelsExpandDepth: 1 },
  }),
);

export { buildOpenApiDocument, getOpenApiDocument } from './document.js';
