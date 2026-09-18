export interface Paper {
  id: string;
  title: string;
  authors: string | null;
  year: number | null;
  filePath: string | null;
  domainId: string | null;
  createdAt: number;
}
