// =============================================================================
// partRepo.ts — パーツ分類カスケードとパーツ履歴の local 実装
// =============================================================================
import type {
  PartCatalogItem,
  PartClassificationQuery,
  PartHistoryEntry,
  PartRepository,
} from '@editor/shared';
import { attempt } from './attempt';
import { currentUser, delay, K, now, partCatalog, read, uid, uniqStable, write } from './store';

// 分類フィルタは「上位が一致して初めて下位を見る」cascade。各段の述語を 1 か所に
// 定義し、候補生成(段階別)と一覧(最下位まで)の両方で共有する。
const cls = (i: PartCatalogItem) => i.classification;
const matchCat = (i: PartCatalogItem, q: PartClassificationQuery) =>
  !q.category || cls(i).category === q.category;
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
        categories: uniqStable(partCatalog.map((i) => cls(i).category)),
        majorClasses: uniqStable(
          partCatalog.filter((i) => matchCat(i, query)).map((i) => cls(i).majorClass),
        ),
        middleClasses: uniqStable(
          partCatalog.filter((i) => matchMajor(i, query)).map((i) => cls(i).middleClass),
        ),
        minorClasses: uniqStable(
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

  recordPartChange: (templateId: string, partKey: string, change: string) =>
    attempt(() => {
      const all = read<PartHistoryEntry[]>(K.partHist, []);
      all.unshift({
        id: uid('ph'),
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
