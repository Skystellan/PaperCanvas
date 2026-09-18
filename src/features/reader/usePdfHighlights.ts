import { useCallback, useEffect, useRef, useState } from "react";
import {
  createPdfHighlightId,
  type PdfHighlight,
  type PdfHighlightRepository,
} from "./model/pdfHighlight";
import type { PdfSelectionNoteRequest } from "./model/pdfSelection";

function sortHighlights(highlights: PdfHighlight[]): PdfHighlight[] {
  return [...highlights].sort(
    (left, right) =>
      left.pageNumber - right.pageNumber || left.createdAt - right.createdAt,
  );
}

export function usePdfHighlights(
  paperId: string,
  repository: PdfHighlightRepository,
) {
  const [highlights, setHighlights] = useState<PdfHighlight[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const loaded = await repository.load(paperId);
      if (loadSequence.current !== sequence) return;
      setHighlights(sortHighlights(loaded));
    } catch {
      if (loadSequence.current !== sequence) return;
      setErrorMessage("Your highlights could not be loaded.");
    } finally {
      if (loadSequence.current === sequence) setIsLoading(false);
    }
  }, [paperId, repository]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void load();
    });
    return () => {
      active = false;
      loadSequence.current += 1;
    };
  }, [load]);

  const save = useCallback(
    async ({ comment, selection }: PdfSelectionNoteRequest) => {
      const timestamp = Date.now();
      const highlight: PdfHighlight = {
        comment,
        createdAt: timestamp,
        id: createPdfHighlightId(),
        pageNumber: selection.pageNumber,
        paperId,
        rects: selection.rects,
        text: selection.text,
        updatedAt: timestamp,
      };
      setErrorMessage(null);
      try {
        await repository.save(highlight);
      } catch (error) {
        setErrorMessage("Your highlight could not be saved.");
        throw error;
      }
      setHighlights((current) => sortHighlights([...current, highlight]));
      return highlight;
    },
    [paperId, repository],
  );

  const remove = useCallback(
    async (highlight: PdfHighlight) => {
      setErrorMessage(null);
      try {
        await repository.remove(paperId, highlight.id);
      } catch (error) {
        setErrorMessage("Your highlight could not be deleted.");
        throw error;
      }
      setHighlights((current) =>
        current.filter(({ id }) => id !== highlight.id),
      );
    },
    [paperId, repository],
  );

  return {
    errorMessage,
    highlights,
    isLoading,
    load,
    remove,
    save,
  };
}
