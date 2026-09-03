// =============================================================================
// draftOwner.ts — 下書きがどのブラウザタブ(セッション)に属するか
// =============================================================================
// 編集セッションはブラウザタブの寿命。閉じる瞬間にサーバへ破棄を届ける手段は不確実
// (`beforeunload` 内の通信はベストエフォートで、クラッシュや電源断では何も送れない)ため、
// 「次回オープン時に、前のタブが残した下書きを破棄する」形で成立させる。
//   - セッショントークン: `sessionStorage`(タブを閉じると消え、リロードとタブ内遷移では残る)
//   - 下書きの所属: `localStorage` の `Record<templateId, token>`(ユーザー別キー)
// 判定はすべて「わからなければ別セッション」へ倒す — 古い下書きを黙って復元するより、
// 確定版から開き直す方が規則に沿う。唯一の例外は所属キーがまだ端末に無いとき(旧ビルドからの
// 移行直後)で、そこだけは 1 回限りの猶予として引き継ぐ(`belongsToSession` を見よ)。
import { draftOwnerKey } from './storageKeys';

const SESSION_TOKEN_KEY = 'editor:tab-session';

/** 下書きの所属を扱う操作の束。service が受け取る差し替え点(テストはフェイクを渡す)。 */
export interface DraftOwner {
  /** 下書きを現在のセッションのものとして記録する(下書きを書くたびに呼ぶ)。 */
  claim(templateId: string): void;
  /** 所属の記録を消す(下書きの破棄と対にする)。 */
  release(templateId: string): void;
  /**
   * 下書きが現在のセッションのものか。記録が無い・別セッションのものなら false。
   * 所属キーがまだ端末に無いときだけは移行の猶予として引き継ぎ(claim して true)、
   * 以後は通常判定に戻る。
   */
  belongsToSession(templateId: string): boolean;
}

function newToken(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** 現在のブラウザタブのセッショントークン。無ければ生成して `sessionStorage` に置く。 */
export function sessionToken(): string {
  try {
    const current = sessionStorage.getItem(SESSION_TOKEN_KEY);
    if (current) return current;
    const token = newToken();
    sessionStorage.setItem(SESSION_TOKEN_KEY, token);
    return token;
  } catch {
    // storage が使えない環境では毎回別トークン = 常に「前のタブの下書き」として破棄される。
    return newToken();
  }
}

function readMap(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(draftOwnerKey()) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, string>): void {
  try {
    localStorage.setItem(draftOwnerKey(), JSON.stringify(map));
  } catch {
    // quota 等。記録できなければ次回オープン時に破棄側へ倒れるだけで、編集は止めない。
  }
}

export const draftOwner: DraftOwner = {
  claim(templateId) {
    const map = readMap();
    map[templateId] = sessionToken();
    writeMap(map);
  },
  release(templateId) {
    const map = readMap();
    if (!(templateId in map)) return;
    delete map[templateId];
    writeMap(map);
  },
  belongsToSession(templateId) {
    // 旧ビルドは所属を記録しない。所属キー自体が無い = この端末でまだ一度も新ビルドが
    // 下書きを書いていない、ということなので、ここで破棄側へ倒すとデプロイ後の最初の
    // リロードで作業中の下書きが一斉に消える。最初に開いた下書きを現在のセッションのものと
    // して引き継ぐ(claim でキーが生まれるため猶予は 1 回限り。キーがあって記録が無い・
    // 記録が壊れている場合は従来どおり別セッション扱い)。
    try {
      if (localStorage.getItem(draftOwnerKey()) === null) {
        draftOwner.claim(templateId);
        return true;
      }
    } catch {
      // storage が読めない環境では猶予を与えず通常判定(= 別セッション扱い)へ落とす。
    }
    return readMap()[templateId] === sessionToken();
  },
};
