import type {
  PartCatalogItem,
  PartClassificationQuery,
  PartHistoryEntry,
  PartRepository,
} from '@editor/shared';
import { attempt } from './attempt';
import { delay, K, partCatalog, read, uniq } from './store';

export const localPartRepo: PartRepository = {
  getPartClassificationOptions: (query: PartClassificationQuery) =>
    attempt(() => {
      const items = partCatalog;
      const c = (i: PartCatalogItem) => i.classification;
      const matchCat = (i: PartCatalogItem) => !query.category || c(i).category === query.category;
      const matchMajor = (i: PartCatalogItem) =>
        matchCat(i) && (!query.majorClass || c(i).majorClass === query.majorClass);
      const matchMiddle = (i: PartCatalogItem) =>
        matchMajor(i) && (!query.middleClass || c(i).middleClass === query.middleClass);
      return delay({
        categories: uniq(items.map((i) => c(i).category)),
        majorClasses: uniq(items.filter(matchCat).map((i) => c(i).majorClass)),
        middleClasses: uniq(items.filter(matchMajor).map((i) => c(i).middleClass)),
        minorClasses: uniq(items.filter(matchMiddle).map((i) => c(i).minorClass)),
      });
    }),

  listParts: (query: PartClassificationQuery) =>
    attempt(() =>
      delay(
        partCatalog.filter(
          (i) =>
            (!query.category || i.classification.category === query.category) &&
            (!query.majorClass || i.classification.majorClass === query.majorClass) &&
            (!query.middleClass || i.classification.middleClass === query.middleClass) &&
            (!query.minorClass || i.classification.minorClass === query.minorClass),
        ),
      ),
    ),

  getPartHistory: (templateId: string, partId: string) =>
    attempt(() => {
      const all = read<PartHistoryEntry[]>(K.partHist, []);
      return delay(all.filter((e) => e.templateId === templateId && e.partId === partId));
    }),
};
