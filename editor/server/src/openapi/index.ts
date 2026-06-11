/**
 * OpenAPI docs router: serves the generated spec and the Swagger UI.
 *
 * Mounted under `/api`, so it exposes:
 *   GET /api/openapi.json  — the OpenAPI 3.1 document (JSON)
 *   GET /api/docs          — Swagger UI
 */

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
