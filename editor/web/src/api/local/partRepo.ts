// =============================================================================
// partRepo.ts — パーツ分類カスケードとパーツ履歴の local 実装
// =============================================================================
import type {
  PartCatalogItem,
  PartClassificationQuery,
  PartHistoryEntry,
  PartRepository,
} from '@editor/shared';
import { uniq } from '@editor/shared';
import { attempt } from './attempt';
import { currentUser, delay, K, now, partCatalog, read, uid, write } from './store';

// 分類フィルタは「上位が一致して初めて下位を見る」cascade。各段の述語を 1 か所に
// 定義し、候補生成(段階別)と一覧(最下位まで)の両方で共有する。
const cls = (i: PartCatalogItem) => i.classification;
// 版種が空なら全件。そうでなければ対象版種なし(両版共通)か一致するものだけを通す。
const matchEdition = (i: PartCatalogItem, q: PartClassificationQuery) =>
  !q.editionType || i.targetEdition == null || i.targetEdition === q.editionType;
const matchCat = (i: PartCatalogItem, q: PartClassificationQuery) =>
  matchEdition(i, q) && (!q.category || cls(i).category === q.category);
const matchMajor = (i: PartCatalogItem, q: PartClassificationQuery) =>
  matchCat(i, q) && (!q.majorClass || cls(i).majorClass === q.majorClass);
const matchMiddle = (i: PartCatalogItem, q: PartClassificationQuery) =>
  matchMajor(i, q) && (!q.middleClass || cls(i).middleClass === q.middleClass);
const matchMinor = (i: PartCatalogItem, q: PartClassificationQuery) =>
  matchMiddle(i, q) && (!q.minorClass || cls(i).minorClass === q.minorClass);

export const localPartRepo: PartRepository = {
  getPartClassificationOptions: (query: PartClassificationQuery) =>
    attempt(() =>
      delay({
        categories: uniq(
          partCatalog.filter((i) => matchEdition(i, query)).map((i) => cls(i).category),
        ),
        majorClasses: uniq(
          partCatalog.filter((i) => matchCat(i, query)).map((i) => cls(i).majorClass),
        ),
        middleClasses: uniq(
          partCatalog.filter((i) => matchMajor(i, query)).map((i) => cls(i).middleClass),
        ),
        minorClasses: uniq(
          partCatalog.filter((i) => matchMiddle(i, query)).map((i) => cls(i).minorClass),
        ),
      }),
    ),

  listParts: (query: PartClassificationQuery) =>
    attempt(() => delay(partCatalog.filter((i) => matchMinor(i, query)))),

  listPartHistory: (templateId: string) =>
    attempt(() => {
      const all = read<PartHistoryEntry[]>(K.partHist, []);
      // partKey 絞りは呼び出し側で in-memory に行う(版インスタンス単位で全件返す)。
      return delay(all.filter((e) => e.templateId === templateId));
    }),

  recordPartChange: (templateId: string, partKey: string, change: string, id?: string) =>
    attempt(() => {
      const all = read<PartHistoryEntry[]>(K.partHist, []);
      all.unshift({
        id: id ?? uid('ph'),
        templateId,
        partKey,
        user: currentUser()?.displayName ?? '不明',
        timestamp: now(),
        change,
      });
      write(K.partHist, all);
      return delay(undefined);
    }),
};
