// =============================================================================
// useRep1Names.ts — 略称 → Rep1 の委託会社コード・ファンド名の共有リゾルバ
// =============================================================================
import { type CompanyOption, isErr } from '@editor/shared';
import { reactive } from 'vue';
import { useTemplateRepo } from '@/api/repositories';
import { formatCompanyLabel, UNREGISTERED } from '@/lib/companyLabel';

/**
 * 委託会社は `listCompanies`(sproc `テンプレート` の `委託会社一覧`)、ファンド名は
 * `listFunds(Rep1 の委託会社コード)`(`ファンド一覧`)から引く。Rep1 のファンド一覧は会社単位で
 * しか引けないので、ファンド名の解決には会社の略称(ファイル名の会社コード)が要る。
 *
 * 取得結果はモジュールで保持し(ページ再読込みまで)、複数行・複数画面で重複取得しない。
 * 失敗は保持しない — 次の解決要求で取り直す。取得前・取得中・失敗の間は「未登録」と言わない
 * (通信の不調で全行が未登録に見えるのを避ける)。
 */

type Load<T> = { state: 'loading' } | { state: 'ok'; value: T };

const state = reactive({
  /** 略称(小文字) → 委託会社。 */
  companies: undefined as Load<Map<string, CompanyOption>> | undefined,
  /** Rep1 の委託会社コード → (ファンドコード → ファンド名)。 */
  funds: new Map<string, Load<Map<string, string>>>(),
});

/** 会社一覧の取得を待っている間にファンド名を求められた略称(取得後にファンドを引く)。 */
const fundsAwaitingCompanies = new Set<string>();

/** テスト用: 保持している取得結果を捨てる。 */
export function resetRep1NamesForTest(): void {
  state.companies = undefined;
  state.funds.clear();
  fundsAwaitingCompanies.clear();
}

export function useRep1Names() {
  const repo = useTemplateRepo();

  /** undefined = まだ分からない(取得前・取得中・失敗)、null = Rep1 に無い。 */
  function companyOf(companyCode: string): CompanyOption | null | undefined {
    if (state.companies?.state !== 'ok') return undefined;
    return state.companies.value.get(companyCode.toLowerCase()) ?? null;
  }

  function resolveCompanies(): void {
    if (state.companies) return;
    state.companies = { state: 'loading' };
    repo
      .listCompanies()
      .then((res) => {
        if (isErr(res)) throw res.error;
        const byAbbr = new Map<string, CompanyOption>();
        for (const c of res.value) {
          const key = c.companyCode.toLowerCase();
          if (!byAbbr.has(key)) byAbbr.set(key, c);
        }
        state.companies = { state: 'ok', value: byAbbr };
        const waiting = [...fundsAwaitingCompanies];
        fundsAwaitingCompanies.clear();
        for (const code of waiting) resolveFunds(code);
      })
      .catch(() => {
        state.companies = undefined;
        fundsAwaitingCompanies.clear();
      });
  }

  function resolveFunds(companyCode: string): void {
    const c = companyOf(companyCode);
    if (c === undefined) {
      fundsAwaitingCompanies.add(companyCode);
      resolveCompanies();
      return;
    }
    if (c === null || state.funds.has(c.rep1CompanyCode)) return;
    const rep1 = c.rep1CompanyCode;
    state.funds.set(rep1, { state: 'loading' });
    repo
      .listFunds(rep1)
      .then((res) => {
        if (isErr(res)) throw res.error;
        state.funds.set(rep1, {
          state: 'ok',
          value: new Map(res.value.map((f) => [f.fundCode, f.fundName])),
        });
      })
      .catch(() => state.funds.delete(rep1));
  }

  /** `AM01（0001）`。Rep1 に無ければ `AM01（未登録）`、まだ分からなければ略称だけ。 */
  function companyLabel(companyCode: string): string {
    const c = companyOf(companyCode);
    if (c === undefined) return companyCode;
    return c === null
      ? `${companyCode}${UNREGISTERED}`
      : formatCompanyLabel(companyCode, c.rep1CompanyCode);
  }

  /** ファンド名。Rep1 に無ければ `（未登録）`、まだ分からなければ空文字。 */
  function fundName(companyCode: string, fundCode: string): string {
    const c = companyOf(companyCode);
    if (c === undefined) return '';
    if (c === null) return UNREGISTERED;
    const funds = state.funds.get(c.rep1CompanyCode);
    if (funds?.state !== 'ok') return '';
    return funds.value.get(fundCode) ?? UNREGISTERED;
  }

  return { resolveCompanies, resolveFunds, companyLabel, fundName };
}
