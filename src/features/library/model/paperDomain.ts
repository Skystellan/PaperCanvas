export const MAX_PAPER_DOMAIN_NAME_LENGTH = 80;

export interface PaperDomain {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export function normalizePaperDomainName(name: string): string {
  const normalized = name.trim();
  const characterCount = Array.from(normalized).length;
  if (
    characterCount === 0 ||
    characterCount > MAX_PAPER_DOMAIN_NAME_LENGTH
  ) {
    throw new Error("领域名称必须为 1 到 80 个字符。");
  }
  return normalized;
}
