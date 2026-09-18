type AbortSignalConstructorWithAny = typeof AbortSignal & {
  any?: (signals: Iterable<AbortSignal>) => AbortSignal;
};

export function installPdfJsCompatibility(): void {
  if (typeof AbortSignal === "undefined") return;
  const abortSignal = AbortSignal as AbortSignalConstructorWithAny;
  if (typeof abortSignal.any === "function") return;

  Object.defineProperty(abortSignal, "any", {
    configurable: true,
    value: (signals: Iterable<AbortSignal>) => {
      const sources = Array.from(signals);
      const controller = new AbortController();
      const abortFrom = (source: AbortSignal) => {
        for (const candidate of sources) {
          candidate.removeEventListener("abort", listeners.get(candidate)!);
        }
        controller.abort(source.reason);
      };
      const listeners = new Map<AbortSignal, () => void>();
      for (const source of sources) {
        listeners.set(source, () => abortFrom(source));
      }
      for (const source of sources) {
        if (source.aborted) {
          abortFrom(source);
          break;
        }
        source.addEventListener("abort", listeners.get(source)!, {
          once: true,
        });
      }
      return controller.signal;
    },
    writable: true,
  });
}

installPdfJsCompatibility();
