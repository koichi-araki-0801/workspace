// =============================================================================
// jinjaTokens.ts — テスト用: Jinja のトークン列を取り出す(往復の前後を比べるため)
// =============================================================================
import { JINJA_TOKEN_RE } from '../../src/lib/jinjaAttrs';

/** テンプレ文字列から Jinja のトークン(`{{ }}` / `{% %}` / `{# #}`)を出現順に取り出す。 */
export function extractJinjaTokens(s: string): string[] {
  return s.match(JINJA_TOKEN_RE) ?? [];
}
