// =============================================================================
// notes.routes.test.ts — メモ API の権限宣言と本文検証
// =============================================================================
// 変更系ルートは `ROUTE_POLICY` へ宣言されていなければ起動時に落ちる。ここでは 4 経路が
// 宣言されていること(GET は閲覧可・変更系は editor 以上)と、空文字の本文を受け付けない
// ことを主張する。
import { apiPaths } from '@editor/shared';
import { AddNoteRequest, UpdateNoteRequest } from '@editor/shared/schemas';
import { describe, expect, it } from 'vitest';
import { ROUTE_POLICY } from '../src/routes/routeGuards.js';

describe('メモ API の権限宣言', () => {
  it('4 経路すべてが宣言されている', () => {
    expect(ROUTE_POLICY[`GET /api${apiPaths.notes}`]).toBe('auth');
    expect(ROUTE_POLICY[`POST /api${apiPaths.notes}`]).toBe('editor');
    expect(ROUTE_POLICY[`PATCH /api${apiPaths.noteEntry}`]).toBe('editor');
    expect(ROUTE_POLICY[`DELETE /api${apiPaths.noteEntry}`]).toBe('editor');
  });

  it('旧 PUT 経路は宣言から消えている', () => {
    expect(ROUTE_POLICY[`PUT /api${apiPaths.notes}`]).toBeUndefined();
  });
});

describe('本文の検証', () => {
  it('空文字は追加・編集とも拒否する(削除は DELETE で明示する)', () => {
    expect(AddNoteRequest.safeParse({ pathKey: 'p', content: '   ' }).success).toBe(true);
    expect(AddNoteRequest.safeParse({ pathKey: 'p', content: '' }).success).toBe(false);
    expect(UpdateNoteRequest.safeParse({ content: '' }).success).toBe(false);
  });

  it('追加は返信先と種別を受け、種別の既定は note', () => {
    const parsed = AddNoteRequest.parse({ pathKey: 'p', content: 'x', replyTo: 'p1' });
    expect(parsed.kind).toBe('note');
    expect(parsed.replyTo).toBe('p1');
  });

  it('更新は本文か状態のどちらかが要る', () => {
    expect(UpdateNoteRequest.safeParse({}).success).toBe(false);
    expect(UpdateNoteRequest.safeParse({ status: 'resolved' }).success).toBe(true);
  });
});
