// =============================================================================
// fundSample.ts — テスト用: `funds.json` の実名を共通サンプルへ被せたサンプル
// =============================================================================
// local の `getSampleData` と同じ組み立て(共通サンプル + 実名)。版種・基準日はファイル名由来の
// 属性を渡したときだけ被せる。
import {
  applyTemplateAttributes,
  buildSampleData,
  type SampleData,
  type SampleTemplateAttributes,
  sampleCommon,
} from '@editor/shared';
import fundMaster from '../../src/api/fixtures/funds.json';

interface FundFixture {
  name: string;
  company: { code: string; name: string };
}

export function fixtureSample(fundCode: string, attrs?: SampleTemplateAttributes): SampleData {
  const f = (fundMaster as Record<string, FundFixture>)[fundCode];
  const master = f && {
    fundName: f.name,
    companyCode: f.company.code,
    companyName: f.company.name,
  };
  const sample = buildSampleData(sampleCommon, master, fundCode);
  return attrs ? applyTemplateAttributes(sample, attrs) : sample;
}
