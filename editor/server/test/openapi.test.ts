import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../src/openapi/document.js';

describe('openapi document', () => {
  const doc = buildOpenApiDocument();

  it('builds a valid OpenAPI 3.1 document without throwing', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('editor API');
  });

  it('covers the full repository contract across all tags', () => {
    const representativePaths = [
      '/health',
      '/auth/login',
      '/auth/me',
      '/templates',
      '/templates/{id}',
      '/templates/{id}/draft',
      '/generate',
      '/funds/{fundCode}/sample-data',
      '/parts',
      '/templates/{templateId}/parts/{partId}/history',
      '/history/edit',
      '/snapshots/{historyId}',
      '/build',
      '/preview',
      '/users',
      '/users/{id}',
    ];
    for (const p of representativePaths) {
      expect(doc.paths, `missing path ${p}`).toHaveProperty([p]);
    }
  });

  it('registers reusable component schemas', () => {
    const schemas = doc.components?.schemas ?? {};
    for (const id of ['Template', 'TemplateMeta', 'User', 'AppError', 'PartCatalogItem']) {
      expect(schemas, `missing component ${id}`).toHaveProperty([id]);
    }
  });

  it('declares the session-cookie security scheme and applies it by default', () => {
    expect(doc.components?.securitySchemes).toHaveProperty(['sessionCookie']);
    expect(doc.security).toEqual([{ sessionCookie: [] }]);
  });

  it('leaves public endpoints (health, login) unauthenticated', () => {
    // biome-ignore lint/suspicious/noExplicitAny: traversing the generated doc
    const health = (doc.paths?.['/health'] as any)?.get;
    // biome-ignore lint/suspicious/noExplicitAny: traversing the generated doc
    const login = (doc.paths?.['/auth/login'] as any)?.post;
    expect(health.security).toEqual([]);
    expect(login.security).toEqual([]);
  });

  it('resolves every $ref to a defined component schema', () => {
    const schemas = doc.components?.schemas ?? {};
    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const v of node) walk(v);
        return;
      }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k === '$ref' && typeof v === 'string') refs.push(v);
          else walk(v);
        }
      }
    };
    walk(doc.paths);
    walk(doc.components);

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const name = ref.replace('#/components/schemas/', '');
      expect(schemas, `unresolved $ref ${ref}`).toHaveProperty([name]);
    }
  });
});
