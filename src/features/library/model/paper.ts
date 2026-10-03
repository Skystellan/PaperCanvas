import type { CodeReview, ResearchPaper } from "../../research/research";

export interface Paper {
  id: string;
  title: string;
  authors: string | null;
  year: number | null;
  filePath: string | null;
  domainId: string | null;
  createdAt: number;
  githubUrl?: string | null;
  githubStars?: number | null;
  codeReview?: CodeReview & { checkedAt: number };
  research?: ResearchPaper;
}
