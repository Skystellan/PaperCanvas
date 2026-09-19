import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NoteAutosaveController,
  type NoteRepository,
} from "./noteAutosaveController";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createRepository(overrides: Partial<NoteRepository> = {}): NoteRepository {
  return {
    load: vi.fn().mockResolvedValue(""),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("NoteAutosaveController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("loads the paper's existing primary note", async () => {
    const repository = createRepository({
      load: vi.fn().mockResolvedValue("Existing note"),
    });
    const controller = new NoteAutosaveController("paper-1", repository);

    await controller.load();

    expect(controller.getSnapshot()).toMatchObject({
      draft: "Existing note",
      isLoading: false,
      loadError: null,
    });
    expect(repository.load).toHaveBeenCalledWith("paper-1");
  });

  it("keeps an edit made while the initial load is pending", async () => {
    const pendingLoad = deferred<string>();
    const repository = createRepository({
      load: vi.fn(() => pendingLoad.promise),
    });
    const controller = new NoteAutosaveController("paper-1", repository);
    const load = controller.load();

    controller.setDraft("local edit wins");
    pendingLoad.resolve("stale database value");
    await load;

    expect(controller.getSnapshot()).toMatchObject({
      draft: "local edit wins",
      isLoading: false,
    });
    expect(controller.isDirty()).toBe(true);
  });

  it("does not write an unchanged draft and resolves a clean flush", async () => {
    const repository = createRepository({
      load: vi.fn().mockResolvedValue("same"),
    });
    const controller = new NoteAutosaveController("paper-1", repository);
    await controller.load();

    controller.setDraft("same");
    await controller.flush();

    expect(repository.save).not.toHaveBeenCalled();
  });

  it("debounces edits for 500ms", async () => {
    const repository = createRepository();
    const controller = new NoteAutosaveController("paper-1", repository);
    await controller.load();

    controller.setDraft("one");
    await vi.advanceTimersByTimeAsync(300);
    controller.setDraft("two");
    await vi.advanceTimersByTimeAsync(499);
    expect(repository.save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(repository.save).toHaveBeenCalledWith("paper-1", "two");
    await controller.flush();
    expect(controller.isDirty()).toBe(false);
  });

  it("serializes writes and persists an edit made during an active save", async () => {
    const firstSave = deferred<void>();
    const save = vi
      .fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValueOnce(undefined);
    const controller = new NoteAutosaveController(
      "paper-1",
      createRepository({ save }),
    );
    await controller.load();

    controller.setDraft("first");
    const flush = controller.flush();
    await Promise.resolve();
    controller.setDraft("latest");

    expect(save).toHaveBeenCalledTimes(1);
    firstSave.resolve();
    await flush;

    expect(save.mock.calls).toEqual([
      ["paper-1", "first"],
      ["paper-1", "latest"],
    ]);
    expect(controller.isDirty()).toBe(false);
  });

  it("shares one flush operation while a write is in flight", async () => {
    const pendingSave = deferred<void>();
    const controller = new NoteAutosaveController(
      "paper-1",
      createRepository({ save: vi.fn(() => pendingSave.promise) }),
    );
    await controller.load();
    controller.setDraft("one intent");

    const first = controller.flush();
    const second = controller.flush();
    expect(second).toBe(first);

    pendingSave.resolve();
    await first;
  });

  it("retains the latest draft after failure and retries it", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    const controller = new NoteAutosaveController(
      "paper-1",
      createRepository({ save }),
    );
    await controller.load();
    controller.setDraft("keep me");

    await expect(controller.flush()).rejects.toThrow("disk full");
    expect(controller.getSnapshot()).toMatchObject({
      draft: "keep me",
      saveError: "Your note could not be saved. Retry when local storage is available.",
    });
    expect(controller.isDirty()).toBe(true);

    await controller.flush();
    expect(save).toHaveBeenLastCalledWith("paper-1", "keep me");
    expect(controller.getSnapshot().saveError).toBeNull();
    expect(controller.isDirty()).toBe(false);
  });

  it("reloads an external file after a failed reload without losing the draft on failure", async () => {
    const load = vi.fn().mockResolvedValueOnce("original")
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce("external edit");
    const controller = new NoteAutosaveController("paper-1", createRepository({ load }));
    await controller.load();
    controller.setDraft("local draft");
    await controller.load(true);
    expect(controller.getSnapshot().draft).toBe("local draft");
    expect(controller.getSnapshot().loadError).not.toBeNull();
    await controller.load();
    expect(controller.getSnapshot()).toMatchObject({ draft: "external edit", loadError: null, saveError: null });
    expect(controller.isDirty()).toBe(false);
    controller.dispose();
  });

  it("ignores a stale load after disposal", async () => {
    const pendingLoad = deferred<string>();
    const controller = new NoteAutosaveController(
      "paper-1",
      createRepository({ load: vi.fn(() => pendingLoad.promise) }),
    );
    const listener = vi.fn();
    controller.subscribe(listener);
    const load = controller.load();
    listener.mockClear();

    controller.dispose();
    pendingLoad.resolve("too late");
    await load;

    expect(listener).not.toHaveBeenCalled();
  });
});
