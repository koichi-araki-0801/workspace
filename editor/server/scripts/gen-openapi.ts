/**
 * Emit the OpenAPI 3.1 document to `editor/server/openapi/openapi.json`
 * for static consumption (CI checks, codegen, sharing with the frontend).
 *
 * Run with: `pnpm --filter server openapi:gen`
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '../src/openapi/document.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '..', 'openapi');
const outFile = path.join(outDir, 'openapi.json');

const doc = buildOpenApiDocument();
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

const pathCount = Object.keys(doc.paths ?? {}).length;
const schemaCount = Object.keys(doc.components?.schemas ?? {}).length;
console.log(`[openapi] wrote ${outFile} (${pathCount} paths, ${schemaCount} component schemas)`);
