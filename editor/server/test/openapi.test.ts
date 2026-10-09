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

  it('does not expose init-password as a public endpoint', () => {
    // 未認証で開けていた頃は任意アカウントのパスワードを書き換えられた。`security: []` が
    // 戻ってきたらここで落とす(ルート側の `requireAuth` と対で守る)。
    // biome-ignore lint/suspicious/noExplicitAny: traversing the generated doc
    const initPassword = (doc.paths?.['/auth/init-password'] as any)?.post;
    expect(initPassword).toBeTruthy();
    expect(initPassword.security).toBeUndefined();
  });

  it('documents the one-shot temporary password channel on user create / reset', () => {
    // 一時パスワードの平文は「この応答 1 回だけ」しか運ばれない(サーバは保存も再表示も
    // しない)。document が旧契約(201=User / 204 空)へ戻ると外部クライアントは払い出し値を
    // 取り損ね、初期パスワード=ログインID の運用へ逆戻りする。ルート実装と対で固定する。
    // biome-ignore lint/suspicious/noExplicitAny: traversing the generated doc
    const create = (doc.paths?.['/users'] as any)?.post;
    expect(create.responses['201'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/CreatedUser',
    );
    // biome-ignore lint/suspicious/noExplicitAny: traversing the generated doc
    const reset = (doc.paths?.[toOpenApiPath(apiPaths.userResetPassword)] as any)?.post;
    expect(reset.responses['204']).toBeUndefined();
    expect(reset.responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/PasswordResetResult',
    );
  });

  it('documents 403 on vivliostyle routes guarded by requireEditor, and 413 on zip preview', () => {
    // biome-ignore lint/suspicious/noExplicitAny: traversing the generated doc
    const paths = doc.paths as any;
    expect(paths['/build/project'].post.responses['403']).toBeTruthy();
    expect(paths['/preview'].post.responses['403']).toBeTruthy();
    expect(paths['/preview'].post.responses['413']).toBeTruthy();
    expect(paths[toOpenApiPath(apiPaths.previewById)].delete.responses['403']).toBeTruthy();
  });

  it('describes external <script src> as inlined on /build and /build/merge', () => {
    // biome-ignore lint/suspicious/noExplicitAny: traversing the generated doc
    const paths = doc.paths as any;
    for (const p of ['/build', '/build/merge']) {
      const description: string = paths[p].post.description;
      expect(description).not.toContain('404 になり');
      expect(description).toContain('インライン展開');
    }
  });

  it('documents the self-change 403 and the last-admin 409 on user update', () => {
    // biome-ignore lint/suspicious/noExplicitAny: traversing the generated doc
    const update = (doc.paths?.[toOpenApiPath(apiPaths.userById)] as any)?.patch;
    expect(update.responses['403'].description).toContain('USER_SELF_CHANGE');
    expect(update.responses['409'].description).toContain('LAST_ADMIN');
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
