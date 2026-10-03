import type { ResearchPaper } from "../../research/research";

export interface Paper {
  id: string;
  title: string;
  authors: string | null;
  year: number | null;
  filePath: string | null;
  domainId: string | null;
  createdAt: number;
  research?: ResearchPaper;
}
