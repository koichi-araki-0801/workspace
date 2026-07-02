// =============================================================================
// schemas.test-d.ts — Zod スキーマと手書き型の「意図的差分」を固定する型テスト
// =============================================================================
// `index.ts` の 1:1 型は `z.infer` 導出なので同期は構造的に保証される。ここでは導出
// できない(= 手書きを残した)型とスキーマの関係を型レベルで固定し、どちらかを変更した
// ときに CI(vitest typecheck モード)が即座に落ちるようにする。
import { describe, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type { AppError, AppErrorKind, ConfirmSaveRequest } from '../src/index.js';
import type * as sch from '../src/schemas.js';

describe('schemas と手書き型の意図的差分', () => {
  it('AppError: ワイヤ形式はログ専用の cause を除いた形(クライアントへ送らない)', () => {
    expectTypeOf<z.infer<typeof sch.AppError>>().toEqualTypeOf<Omit<AppError, 'cause'>>();
    expectTypeOf<z.infer<typeof sch.AppErrorKind>>().toEqualTypeOf<AppErrorKind>();
  });

  it('ConfirmSaveBody: templateId はパス・filledHtml は申請経路のみが運ぶ HTTP 派生', () => {
    expectTypeOf<z.infer<typeof sch.ConfirmSaveBody>>().toEqualTypeOf<
      Omit<ConfirmSaveRequest, 'templateId' | 'filledHtml'>
    >();
  });
});
