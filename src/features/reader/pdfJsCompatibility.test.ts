import { describe, expect, it } from "vitest";
import { installPdfJsCompatibility } from "./pdfJsCompatibility";

type AbortSignalConstructorWithAny = typeof AbortSignal & {
  any?: (signals: Iterable<AbortSignal>) => AbortSignal;
};

describe("installPdfJsCompatibility", () => {
  it("combines abort signals on WebKit versions without AbortSignal.any", () => {
    const abortSignal = AbortSignal as AbortSignalConstructorWithAny;
    const originalAny = abortSignal.any;
    Object.defineProperty(abortSignal, "any", {
      configurable: true,
      value: undefined,
      writable: true,
    });

    try {
      installPdfJsCompatibility();
      const first = new AbortController();
      const second = new AbortController();
      const combined = abortSignal.any!([first.signal, second.signal]);

      expect(combined.aborted).toBe(false);
      second.abort("finished");
      expect(combined.aborted).toBe(true);
      expect(combined.reason).toBe("finished");
    } finally {
      Object.defineProperty(abortSignal, "any", {
        configurable: true,
        value: originalAny,
        writable: true,
      });
    }
  });
});
