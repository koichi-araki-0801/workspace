import type {
  PartCatalogItem,
  PartClassificationOptions,
  PartClassificationQuery,
  PartRepository,
  Result,
} from '@editor/shared';
import { usePartRepo } from '@/api/repositories';

/** Parts-catalog reads for the editor left pane. */
export interface PartCatalogService {
  getOptions(query: PartClassificationQuery): Promise<Result<PartClassificationOptions>>;
  list(query: PartClassificationQuery): Promise<Result<PartCatalogItem[]>>;
}

export function createPartCatalogService(repo: PartRepository): PartCatalogService {
  return {
    getOptions: (query) => repo.getPartClassificationOptions(query),
    list: (query) => repo.listParts(query),
  };
}

export const usePartCatalogService = (): PartCatalogService =>
  createPartCatalogService(usePartRepo());
