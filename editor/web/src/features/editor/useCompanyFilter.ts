// =============================================================================
// useCompanyFilter.ts — 開いているテンプレートの委託会社(Rep1 の委託会社コード)の解決
// =============================================================================
import { type Ref, ref, watch } from 'vue';
import { companyCodeOfTemplateId } from '@/lib/fundImages';
import { useRep1Names } from '@/lib/useRep1Names';
import type { CompanyFilter } from './PartCatalog.vue';

/**
 * テンプレート ID 先頭の略称を Rep1 の委託会社コードへ引く。引けるまでは pending、略称が取れない・
 * Rep1 に無い・重複・取得失敗は none(他社のパーツを見せないので全件にはしない)。
 * ID が解決中に変わったら、古い解決の結果は捨てる。
 */
export function useCompanyFilter(templateId: Ref<string>): Ref<CompanyFilter> {
  const { resolveRep1CompanyCode } = useRep1Names();
  const filter = ref<CompanyFilter>({ state: 'pending' });
  watch(
    templateId,
    async (id) => {
      filter.value = { state: 'pending' };
      const abbr = companyCodeOfTemplateId(id);
      const code = abbr ? await resolveRep1CompanyCode(abbr) : null;
      if (templateId.value !== id) return;
      filter.value = code ? { state: 'ok', code } : { state: 'none' };
    },
    { immediate: true },
  );
  return filter;
}
