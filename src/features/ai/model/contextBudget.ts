import type { ChatMessage, StoredPaperText } from "./ai";

export const MAX_ESTIMATED_INPUT_TOKENS = 120_000;

export interface ContextBudget {
  estimatedTokens: number;
  limit: number;
  fits: boolean;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Codex tokenization is byte based. Counting UTF-8 bytes is deliberately a
  // conservative upper bound (at most one token per byte), so CJK and other
  // multibyte text cannot slip past the preflight budget.
  return new TextEncoder().encode(text).byteLength;
}

export function measureContextBudget({
  messages,
  paperTexts,
  prompt,
}: {
  messages: readonly Pick<ChatMessage, "content" | "role">[];
  paperTexts: readonly StoredPaperText[];
  prompt: string;
}): ContextBudget {
  const input = [
    prompt,
    ...messages.map((message) => `${message.role}: ${message.content}`),
    ...paperTexts.map((paper) => paper.content ?? ""),
  ].join("\n\n");
  const estimatedTokens = estimateTokens(input);
  return {
    estimatedTokens,
    fits: estimatedTokens <= MAX_ESTIMATED_INPUT_TOKENS,
    limit: MAX_ESTIMATED_INPUT_TOKENS,
  };
}
