import type { Paper } from "../../library";
import type { AiRepository } from "../data/aiRepository";
import type { StoredPaperText } from "../model/ai";
import {
  extractFullPaperText,
  PaperTextExtractionCancelledError,
  PaperTextExtractionError,
} from "./paperTextExtractor";

type PaperTextStore = Pick<AiRepository, "getPaperText" | "savePaperText">;
type ExtractPaperText = typeof extractFullPaperText;

interface ExtractionFlight {
  controller: AbortController;
  operation: Promise<StoredPaperText>;
  settled: boolean;
  waiters: number;
}

const extractionFlights = new WeakMap<
  object,
  Map<string, ExtractionFlight>
>();

function flightsFor(repository: PaperTextStore): Map<string, ExtractionFlight> {
  let flights = extractionFlights.get(repository);
  if (!flights) {
    flights = new Map();
    extractionFlights.set(repository, flights);
  }
  return flights;
}

function waitForFlight(
  flight: ExtractionFlight,
  signal?: AbortSignal,
): Promise<StoredPaperText> {
  if (signal?.aborted) {
    if (flight.waiters === 0 && !flight.settled) flight.controller.abort();
    return Promise.reject(new PaperTextExtractionCancelledError());
  }

  flight.waiters += 1;
  return new Promise<StoredPaperText>((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener("abort", onAbort);
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) flight.controller.abort();
    };
    const onAbort = () => {
      release();
      reject(new PaperTextExtractionCancelledError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    flight.operation.then(
      (stored) => {
        release();
        resolve(stored);
      },
      (error: unknown) => {
        release();
        reject(error);
      },
    );
  });
}

export class PaperTextService {
  constructor(
    private readonly repository: PaperTextStore,
    private readonly extract: ExtractPaperText = extractFullPaperText,
    private readonly now: () => number = Date.now,
  ) {}

  async ensureReady(
    paper: Paper,
    signal?: AbortSignal,
  ): Promise<StoredPaperText> {
    if (signal?.aborted) throw new PaperTextExtractionCancelledError();
    const existing = await this.repository.getPaperText(paper.id);
    if (signal?.aborted) throw new PaperTextExtractionCancelledError();
    if (existing?.status === "ready") return existing;
    if (existing?.status === "too_large") {
      throw new PaperTextExtractionError(
        "too_large",
        "The complete paper exceeds the explicit Codex context limit.",
        existing.pageCount,
        existing.charCount,
      );
    }

    const flights = flightsFor(this.repository);
    let flight = flights.get(paper.id);
    if (flight?.controller.signal.aborted) flight = undefined;
    if (!flight) {
      const controller = new AbortController();
      const operation = this.extractAndStore(paper, controller.signal);
      flight = { controller, operation, settled: false, waiters: 0 };
      flights.set(paper.id, flight);
      const currentFlight = flight;
      const finish = () => {
        currentFlight.settled = true;
        if (flights.get(paper.id) === currentFlight) flights.delete(paper.id);
      };
      void operation.then(finish, finish);
    }
    return waitForFlight(flight, signal);
  }

  private async extractAndStore(
    paper: Paper,
    signal: AbortSignal,
  ): Promise<StoredPaperText> {
    try {
      if (signal.aborted) throw new PaperTextExtractionCancelledError();
      const extracted = await this.extract(paper, { signal });
      if (signal.aborted) throw new PaperTextExtractionCancelledError();
      const stored: StoredPaperText = {
        paperId: paper.id,
        status: "ready",
        content: extracted.content,
        pageCount: extracted.pageCount,
        charCount: extracted.content.length,
        errorCode: null,
        updatedAt: this.now(),
      };
      await this.repository.savePaperText(stored);
      return stored;
    } catch (error) {
      if (
        signal.aborted ||
        error instanceof PaperTextExtractionCancelledError
      ) {
        throw error instanceof PaperTextExtractionCancelledError
          ? error
          : new PaperTextExtractionCancelledError();
      }
      const extractionError =
        error instanceof PaperTextExtractionError
          ? error
          : new PaperTextExtractionError(
              "open_failed",
              "The local PDF could not be extracted.",
            );
      const failed: StoredPaperText = {
        paperId: paper.id,
        status: extractionError.code === "too_large" ? "too_large" : "failed",
        content: null,
        pageCount: extractionError.pageCount,
        charCount: extractionError.charCount,
        errorCode: extractionError.code,
        updatedAt: this.now(),
      };
      await this.repository.savePaperText(failed);
      throw extractionError;
    }
  }
}
