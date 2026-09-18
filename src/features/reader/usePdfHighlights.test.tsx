import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  PdfHighlight,
  PdfHighlightRepository,
} from "./model/pdfHighlight";
import { usePdfHighlights } from "./usePdfHighlights";

const persisted: PdfHighlight = {
  comment: "Later page",
  createdAt: 2,
  id: "persisted",
  pageNumber: 7,
  paperId: "paper-1",
  rects: [{ height: 0.02, left: 0.1, top: 0.2, width: 0.3 }],
  text: "Persisted passage",
  updatedAt: 2,
};

function createRepository(): PdfHighlightRepository {
  return {
    load: vi.fn().mockResolvedValue([persisted]),
    remove: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

describe("usePdfHighlights", () => {
  it("loads, sorts, creates, and removes paper-scoped highlights", async () => {
    const repository = createRepository();
    const { result } = renderHook(() =>
      usePdfHighlights("paper-1", repository),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.highlights).toEqual([persisted]);

    await act(() =>
      result.current.save({
        comment: "Earlier page",
        selection: {
          anchor: { x: 20, y: 30 },
          pageNumber: 2,
          rects: [{ height: 0.02, left: 0.2, top: 0.3, width: 0.4 }],
          text: "New selection",
        },
      }),
    );
    expect(result.current.highlights.map(({ pageNumber }) => pageNumber)).toEqual([
      2, 7,
    ]);

    await act(() => result.current.remove(persisted));
    expect(repository.remove).toHaveBeenCalledWith("paper-1", "persisted");
    expect(result.current.highlights).toHaveLength(1);
  });

  it("surfaces load failures and recovers through an explicit retry", async () => {
    const repository = createRepository();
    vi.mocked(repository.load)
      .mockRejectedValueOnce(new Error("database locked"))
      .mockResolvedValueOnce([]);
    const { result } = renderHook(() =>
      usePdfHighlights("paper-1", repository),
    );

    await waitFor(() =>
      expect(result.current.errorMessage).toBe(
        "Your highlights could not be loaded.",
      ),
    );
    await act(() => result.current.load());
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.highlights).toEqual([]);
  });

  it("does not mutate visible highlights when a save or delete fails", async () => {
    const repository = createRepository();
    vi.mocked(repository.save).mockRejectedValue(new Error("disk full"));
    vi.mocked(repository.remove).mockRejectedValue(new Error("database busy"));
    const { result } = renderHook(() =>
      usePdfHighlights("paper-1", repository),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await expect(
        result.current.save({
          comment: "Unsaved draft",
          selection: {
            anchor: { x: 20, y: 30 },
            pageNumber: 1,
            rects: [{ height: 0.02, left: 0.2, top: 0.3, width: 0.4 }],
            text: "Do not lose this",
          },
        }),
      ).rejects.toThrow("disk full");
    });
    expect(result.current.highlights).toEqual([persisted]);
    expect(result.current.errorMessage).toBe("Your highlight could not be saved.");

    await act(async () => {
      await expect(result.current.remove(persisted)).rejects.toThrow(
        "database busy",
      );
    });
    expect(result.current.highlights).toEqual([persisted]);
    expect(result.current.errorMessage).toBe(
      "Your highlight could not be deleted.",
    );
  });
});
