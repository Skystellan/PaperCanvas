import { describe, expect, it } from "vitest";
import {
  MAX_ESTIMATED_INPUT_TOKENS,
  estimateTokens,
  measureContextBudget,
} from "./contextBudget";

describe("context budget", () => {
  it("estimates text conservatively and includes messages and full papers", () => {
    expect(estimateTokens("12345")).toBe(5);
    expect(estimateTokens("论文")).toBe(6);
    expect(
      measureContextBudget({
        messages: [{ role: "user", content: "question" }],
        paperTexts: [
          {
            paperId: "paper-1",
            status: "ready",
            content: "paper text",
            pageCount: 1,
            charCount: 10,
            errorCode: null,
            updatedAt: 1,
          },
        ],
        prompt: "prompt",
      }).estimatedTokens,
    ).toBeGreaterThan(5);
  });

  it("blocks oversized context instead of truncating it", () => {
    const budget = measureContextBudget({
      messages: [],
      paperTexts: [],
      prompt: "x".repeat(MAX_ESTIMATED_INPUT_TOKENS + 1),
    });

    expect(budget.fits).toBe(false);
    expect(budget.estimatedTokens).toBe(MAX_ESTIMATED_INPUT_TOKENS + 1);
  });
});
