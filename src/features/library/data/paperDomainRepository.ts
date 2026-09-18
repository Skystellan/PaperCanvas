import type { PaperDomain } from "../model/paperDomain";

export interface PaperDomainRepository {
  list(): Promise<PaperDomain[]>;
  create(name: string): Promise<PaperDomain>;
  rename(domainId: string, name: string): Promise<void>;
  delete(domainId: string): Promise<void>;
  assignPaper(paperId: string, domainId: string | null): Promise<void>;
}
