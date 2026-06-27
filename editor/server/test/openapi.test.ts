import { apiPaths, toOpenApiPath } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../src/openapi/document.js';

// OpenAPI document に意図的に未記載のパス(設計ギャップ)。現状は無し。将来パスを先に
// 共有定数へ足して document を後追いにする場合のみ、ここへ一時的に列挙する。
const KNOWN_OPENAPI_GAPS: readonly string[] = [];

describe('openapi document', () => {
  const doc = buildOpenApiDocument();

  it('builds a valid OpenAPI 3.1 document without throwing', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('editor API');
  });

  it('covers the full repository contract across all tags', () => {
    // 代表パスは正典 `apiPaths` から OpenAPI 形へ導出する(手書きのパス文字列を排除)。
    const representativePaths = [
      apiPaths.health,
      apiPaths.authLogin,
      apiPaths.authMe,
      apiPaths.templates,
      apiPaths.templateById,
      apiPaths.templateDraft,
      apiPaths.generate,
      apiPaths.fundSampleData,
      apiPaths.parts,
      apiPaths.partHistory,
      apiPaths.historyEdit,
      apiPaths.snapshotById,
      apiPaths.build,
      apiPaths.preview,
      apiPaths.users,
      apiPaths.userById,
    ].map(toOpenApiPath);
    for (const p of representativePaths) {
      expect(doc.paths, `missing path ${p}`).toHaveProperty([p]);
    }
  });

  it('documents every canonical path except the known gaps', () => {
    // 正典の全パスが document に載っていることを保証し、漏れ(例: notes)を CI で可視化する。
    const documented = new Set(Object.keys(doc.paths ?? {}));
    const missing = Object.values(apiPaths)
      .filter((template) => !KNOWN_OPENAPI_GAPS.includes(template))
      .filter((template) => !documented.has(toOpenApiPath(template)));
    expect(missing, `paths missing from OpenAPI document: ${missing.join(', ')}`).toEqual([]);
    // ギャップが解消(document に追記)されたら allowlist からも外すよう促す。
    for (const gap of KNOWN_OPENAPI_GAPS) {
      expect(
        documented.has(toOpenApiPath(gap)),
        `gap ${gap} is now documented; remove it from KNOWN_OPENAPI_GAPS`,
      ).toBe(false);
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
