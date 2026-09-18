import { useEffect, useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PersistenceCoordinator } from "./PersistenceCoordinator";
import {
  usePersistenceCoordinator,
  usePersistenceWriter,
} from "./usePersistenceCoordinator";
import type {
  PersistenceCoordinatorApi,
  PersistenceWriter,
} from "./persistenceContext";

type CloseHandler = (event: {
  preventDefault: () => void;
}) => void | Promise<void>;

const nativeWindow = vi.hoisted(() => ({
  isTauri: vi.fn(),
  onCloseRequested: vi.fn(),
  destroy: vi.fn(),
  closeHandler: undefined as CloseHandler | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: nativeWindow.isTauri,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: nativeWindow.onCloseRequested,
    destroy: nativeWindow.destroy,
  }),
}));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function RegisteredWriter({
  name,
  writer,
}: {
  name: string;
  writer: PersistenceWriter;
}) {
  usePersistenceWriter(name, writer);
  return null;
}

function ManualFlush({ onComplete }: { onComplete: () => void }) {
  const { flushPending } = usePersistenceCoordinator();

  return (
    <button
      type="button"
      onClick={() => {
        void flushPending().then(onComplete);
      }}
    >
      Save now
    </button>
  );
}

function CaptureApi({
  onReady,
}: {
  onReady: (api: PersistenceCoordinatorApi) => void;
}) {
  const api = usePersistenceCoordinator();

  useEffect(() => onReady(api), [api, onReady]);
  return null;
}

function createWriter(dirty = true): PersistenceWriter & {
  isDirty: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
} {
  let hasChanges = dirty;

  return {
    isDirty: vi.fn(() => hasChanges),
    flush: vi.fn(async () => {
      hasChanges = false;
    }),
  };
}

describe("PersistenceCoordinator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeWindow.closeHandler = undefined;
    nativeWindow.isTauri.mockReturnValue(true);
    nativeWindow.onCloseRequested.mockImplementation(
      async (handler: CloseHandler) => {
        nativeWindow.closeHandler = handler;
        return vi.fn();
      },
    );
    nativeWindow.destroy.mockReset().mockResolvedValue(undefined);
  });

  it("owns one native close listener and removes it on unmount", async () => {
    const stopListening = vi.fn();
    nativeWindow.onCloseRequested.mockImplementationOnce(
      async (handler: CloseHandler) => {
        nativeWindow.closeHandler = handler;
        return stopListening;
      },
    );

    const { unmount } = render(
      <PersistenceCoordinator>
        <span>Workspace</span>
      </PersistenceCoordinator>,
    );

    await waitFor(() => {
      expect(nativeWindow.onCloseRequested).toHaveBeenCalledOnce();
    });
    unmount();

    expect(stopListening).toHaveBeenCalledOnce();
  });

  it("does not install a native listener in a browser preview", async () => {
    nativeWindow.isTauri.mockReturnValue(false);

    render(
      <PersistenceCoordinator>
        <span>Workspace</span>
      </PersistenceCoordinator>,
    );
    await act(async () => Promise.resolve());

    expect(nativeWindow.onCloseRequested).not.toHaveBeenCalled();
  });

  it("unlistens if registration completes after the provider unmounts", async () => {
    const registration = createDeferred<() => void>();
    const stopListening = vi.fn();
    nativeWindow.onCloseRequested.mockImplementationOnce(
      async (handler: CloseHandler) => {
        nativeWindow.closeHandler = handler;
        return registration.promise;
      },
    );
    const { unmount } = render(
      <PersistenceCoordinator>
        <span>Workspace</span>
      </PersistenceCoordinator>,
    );
    await waitFor(() => {
      expect(nativeWindow.onCloseRequested).toHaveBeenCalledOnce();
    });

    unmount();
    await act(async () => {
      registration.resolve(stopListening);
      await registration.promise;
    });

    expect(stopListening).toHaveBeenCalledOnce();
  });

  it("allows the native close to proceed when every writer is clean", async () => {
    const writer = createWriter(false);
    render(
      <PersistenceCoordinator>
        <RegisteredWriter name="whiteboard" writer={writer} />
      </PersistenceCoordinator>,
    );
    await waitFor(() => expect(nativeWindow.closeHandler).toBeTypeOf("function"));

    const preventDefault = vi.fn();
    await nativeWindow.closeHandler?.({ preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(writer.flush).not.toHaveBeenCalled();
    expect(nativeWindow.destroy).not.toHaveBeenCalled();
  });

  it("prevents close, flushes a dirty writer, then destroys the window", async () => {
    let dirty = true;
    const save = createDeferred<void>();
    const writer: PersistenceWriter = {
      isDirty: () => dirty,
      flush: vi.fn(async () => {
        await save.promise;
        dirty = false;
      }),
    };
    render(
      <PersistenceCoordinator>
        <RegisteredWriter name="whiteboard" writer={writer} />
      </PersistenceCoordinator>,
    );
    await waitFor(() => expect(nativeWindow.closeHandler).toBeTypeOf("function"));

    const preventDefault = vi.fn();
    const closePromise = Promise.resolve(
      nativeWindow.closeHandler?.({ preventDefault }),
    );

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(writer.flush).toHaveBeenCalledOnce();
    expect(nativeWindow.destroy).not.toHaveBeenCalled();

    await act(async () => {
      save.resolve();
      await closePromise;
    });

    expect(nativeWindow.destroy).toHaveBeenCalledOnce();
  });

  it("waits for tracked library operations before closing", async () => {
    const operation = createDeferred<void>();
    let api: PersistenceCoordinatorApi | undefined;
    render(
      <PersistenceCoordinator>
        <CaptureApi onReady={(value) => { api = value; }} />
      </PersistenceCoordinator>,
    );
    await waitFor(() => {
      expect(api).toBeDefined();
      expect(nativeWindow.closeHandler).toBeTypeOf("function");
    });

    void api?.trackOperation(operation.promise);
    const preventDefault = vi.fn();
    const closePromise = Promise.resolve(
      nativeWindow.closeHandler?.({ preventDefault }),
    );

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(nativeWindow.destroy).not.toHaveBeenCalled();

    await act(async () => {
      operation.resolve();
      await closePromise;
    });
    expect(nativeWindow.destroy).toHaveBeenCalledOnce();
  });

  it("starts all dirty writer flushes concurrently", async () => {
    let boardDirty = true;
    let noteDirty = true;
    const boardSave = createDeferred<void>();
    const noteSave = createDeferred<void>();
    const boardWriter: PersistenceWriter = {
      isDirty: () => boardDirty,
      flush: vi.fn(async () => {
        await boardSave.promise;
        boardDirty = false;
      }),
    };
    const noteWriter: PersistenceWriter = {
      isDirty: () => noteDirty,
      flush: vi.fn(async () => {
        await noteSave.promise;
        noteDirty = false;
      }),
    };
    render(
      <PersistenceCoordinator>
        <RegisteredWriter name="whiteboard" writer={boardWriter} />
        <RegisteredWriter name="note" writer={noteWriter} />
      </PersistenceCoordinator>,
    );
    await waitFor(() => expect(nativeWindow.closeHandler).toBeTypeOf("function"));

    const closePromise = Promise.resolve(
      nativeWindow.closeHandler?.({ preventDefault: vi.fn() }),
    );

    expect(boardWriter.flush).toHaveBeenCalledOnce();
    expect(noteWriter.flush).toHaveBeenCalledOnce();
    expect(nativeWindow.destroy).not.toHaveBeenCalled();

    await act(async () => {
      boardSave.resolve();
      noteSave.resolve();
      await closePromise;
    });

    expect(nativeWindow.destroy).toHaveBeenCalledOnce();
  });

  it("drains changes created while an earlier flush is running", async () => {
    let revision = 1;
    let persistedRevision = 0;
    const firstSave = createDeferred<void>();
    const writer: PersistenceWriter = {
      isDirty: () => revision !== persistedRevision,
      flush: vi.fn(async () => {
        const targetRevision = revision;
        if (targetRevision === 1) await firstSave.promise;
        persistedRevision = targetRevision;
      }),
    };
    render(
      <PersistenceCoordinator>
        <RegisteredWriter name="note" writer={writer} />
      </PersistenceCoordinator>,
    );
    await waitFor(() => expect(nativeWindow.closeHandler).toBeTypeOf("function"));

    const closePromise = Promise.resolve(
      nativeWindow.closeHandler?.({ preventDefault: vi.fn() }),
    );
    revision = 2;

    await act(async () => {
      firstSave.resolve();
      await closePromise;
    });

    expect(writer.flush).toHaveBeenCalledTimes(2);
    expect(persistedRevision).toBe(2);
    expect(nativeWindow.destroy).toHaveBeenCalledOnce();
  });

  it("shares an in-progress explicit flush between callers", async () => {
    let dirty = true;
    const save = createDeferred<void>();
    const writer: PersistenceWriter = {
      isDirty: () => dirty,
      flush: vi.fn(async () => {
        await save.promise;
        dirty = false;
      }),
    };
    const firstComplete = vi.fn();
    const secondComplete = vi.fn();
    const user = userEvent.setup();
    render(
      <PersistenceCoordinator>
        <RegisteredWriter name="note" writer={writer} />
        <ManualFlush onComplete={firstComplete} />
        <ManualFlush onComplete={secondComplete} />
      </PersistenceCoordinator>,
    );

    const saveButtons = screen.getAllByRole("button", { name: "Save now" });
    await user.click(saveButtons[0]);
    await user.click(saveButtons[1]);
    expect(writer.flush).toHaveBeenCalledOnce();

    await act(async () => {
      save.resolve();
      await save.promise;
    });
    await waitFor(() => {
      expect(firstComplete).toHaveBeenCalledOnce();
      expect(secondComplete).toHaveBeenCalledOnce();
    });
  });

  it("coalesces overlapping close requests into one flush and destroy", async () => {
    let dirty = true;
    const save = createDeferred<void>();
    const writer: PersistenceWriter = {
      isDirty: () => dirty,
      flush: vi.fn(async () => {
        await save.promise;
        dirty = false;
      }),
    };
    render(
      <PersistenceCoordinator>
        <RegisteredWriter name="note" writer={writer} />
      </PersistenceCoordinator>,
    );
    await waitFor(() => expect(nativeWindow.closeHandler).toBeTypeOf("function"));

    const firstPreventDefault = vi.fn();
    const secondPreventDefault = vi.fn();
    const firstClose = Promise.resolve(
      nativeWindow.closeHandler?.({ preventDefault: firstPreventDefault }),
    );
    const secondClose = Promise.resolve(
      nativeWindow.closeHandler?.({ preventDefault: secondPreventDefault }),
    );

    expect(firstPreventDefault).toHaveBeenCalledOnce();
    expect(secondPreventDefault).toHaveBeenCalledOnce();
    expect(writer.flush).toHaveBeenCalledOnce();

    await act(async () => {
      save.resolve();
      await Promise.all([firstClose, secondClose]);
    });

    expect(nativeWindow.destroy).toHaveBeenCalledOnce();
  });

  it("keeps the window open after a save failure and lets the user retry", async () => {
    const user = userEvent.setup();
    let dirty = true;
    const writer: PersistenceWriter = {
      isDirty: () => dirty,
      flush: vi
        .fn()
        .mockRejectedValueOnce(new Error("disk busy"))
        .mockImplementationOnce(async () => {
          dirty = false;
        }),
    };
    render(
      <PersistenceCoordinator>
        <RegisteredWriter name="note" writer={writer} />
      </PersistenceCoordinator>,
    );
    await waitFor(() => expect(nativeWindow.closeHandler).toBeTypeOf("function"));

    await act(async () => {
      await nativeWindow.closeHandler?.({ preventDefault: vi.fn() });
    });

    expect(nativeWindow.destroy).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save all local changes",
    );

    await user.click(screen.getByRole("button", { name: "Retry saving" }));

    await waitFor(() => {
      expect(writer.flush).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    expect(nativeWindow.destroy).not.toHaveBeenCalled();
  });

  it("continues to expose a save error when retry also fails", async () => {
    const user = userEvent.setup();
    const writer: PersistenceWriter = {
      isDirty: () => true,
      flush: vi.fn().mockRejectedValue(new Error("disk busy")),
    };
    render(
      <PersistenceCoordinator>
        <RegisteredWriter name="note" writer={writer} />
      </PersistenceCoordinator>,
    );
    await waitFor(() => expect(nativeWindow.closeHandler).toBeTypeOf("function"));
    await act(async () => {
      await nativeWindow.closeHandler?.({ preventDefault: vi.fn() });
    });

    await user.click(screen.getByRole("button", { name: "Retry saving" }));

    await waitFor(() => expect(writer.flush).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not save all local changes",
    );
    expect(nativeWindow.destroy).not.toHaveBeenCalled();
  });

  it("lets the user explicitly close after a save and retry both fail", async () => {
    const user = userEvent.setup();
    const writer: PersistenceWriter = {
      isDirty: () => true,
      flush: vi.fn().mockRejectedValue(new Error("disk busy")),
    };
    render(
      <PersistenceCoordinator>
        <RegisteredWriter name="note" writer={writer} />
      </PersistenceCoordinator>,
    );
    await waitFor(() => expect(nativeWindow.closeHandler).toBeTypeOf("function"));
    await act(async () => {
      await nativeWindow.closeHandler?.({ preventDefault: vi.fn() });
    });

    await user.click(screen.getByRole("button", { name: "Retry saving" }));
    await waitFor(() => expect(writer.flush).toHaveBeenCalledTimes(2));
    await user.click(
      screen.getByRole("button", { name: "Close without saving" }),
    );

    await waitFor(() => expect(nativeWindow.destroy).toHaveBeenCalledOnce());
    expect(writer.flush).toHaveBeenCalledTimes(2);
  });

  it("does not claim failed changes were saved when close-without-saving also fails", async () => {
    const user = userEvent.setup();
    const writer: PersistenceWriter = {
      isDirty: () => true,
      flush: vi.fn().mockRejectedValue(new Error("disk busy")),
    };
    nativeWindow.destroy
      .mockRejectedValueOnce(new Error("window busy"))
      .mockResolvedValueOnce(undefined);
    render(
      <PersistenceCoordinator>
        <RegisteredWriter name="note" writer={writer} />
      </PersistenceCoordinator>,
    );
    await waitFor(() => expect(nativeWindow.closeHandler).toBeTypeOf("function"));
    await act(async () => {
      await nativeWindow.closeHandler?.({ preventDefault: vi.fn() });
    });

    await user.click(
      screen.getByRole("button", { name: "Close without saving" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "PaperCanvas could not close. You can retry safely.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "changes were saved",
    );
    await user.click(screen.getByRole("button", { name: "Retry close" }));
    await waitFor(() => expect(nativeWindow.destroy).toHaveBeenCalledTimes(2));
  });

  it("treats a writer dirty-state exception as unsafe to close", async () => {
    const writer: PersistenceWriter = {
      isDirty: vi.fn(() => {
        throw new Error("writer unavailable");
      }),
      flush: vi.fn(),
    };
    render(
      <PersistenceCoordinator>
        <RegisteredWriter name="note" writer={writer} />
      </PersistenceCoordinator>,
    );
    await waitFor(() => expect(nativeWindow.closeHandler).toBeTypeOf("function"));

    const preventDefault = vi.fn();
    await act(async () => {
      await nativeWindow.closeHandler?.({ preventDefault });
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save all local changes",
    );
    expect(nativeWindow.destroy).not.toHaveBeenCalled();
  });

  it("reports close-listener registration failure and retries protection", async () => {
    const user = userEvent.setup();
    nativeWindow.onCloseRequested
      .mockRejectedValueOnce(new Error("listener unavailable"))
      .mockImplementationOnce(async (handler: CloseHandler) => {
        nativeWindow.closeHandler = handler;
        return vi.fn();
      });

    render(
      <PersistenceCoordinator>
        <span>Workspace</span>
      </PersistenceCoordinator>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Save-on-close protection is unavailable",
    );
    await user.click(
      screen.getByRole("button", { name: "Retry close protection" }),
    );

    await waitFor(() => {
      expect(nativeWindow.onCloseRequested).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("reports a destroy failure and retries the requested close", async () => {
    const user = userEvent.setup();
    const writer = createWriter();
    nativeWindow.destroy
      .mockRejectedValueOnce(new Error("window busy"))
      .mockResolvedValueOnce(undefined);
    render(
      <PersistenceCoordinator>
        <RegisteredWriter name="note" writer={writer} />
      </PersistenceCoordinator>,
    );
    await waitFor(() => expect(nativeWindow.closeHandler).toBeTypeOf("function"));

    await act(async () => {
      await nativeWindow.closeHandler?.({ preventDefault: vi.fn() });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "PaperCanvas could not close. You can retry safely.",
    );
    await user.click(screen.getByRole("button", { name: "Retry close" }));

    await waitFor(() => {
      expect(nativeWindow.destroy).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("does not destroy after the coordinator unmounts during a close flush", async () => {
    let dirty = true;
    const save = createDeferred<void>();
    const writer: PersistenceWriter = {
      isDirty: () => dirty,
      flush: vi.fn(async () => {
        await save.promise;
        dirty = false;
      }),
    };
    const { unmount } = render(
      <PersistenceCoordinator>
        <RegisteredWriter name="note" writer={writer} />
      </PersistenceCoordinator>,
    );
    await waitFor(() => expect(nativeWindow.closeHandler).toBeTypeOf("function"));

    const closePromise = Promise.resolve(
      nativeWindow.closeHandler?.({ preventDefault: vi.fn() }),
    );
    unmount();
    await act(async () => {
      save.resolve();
      await closePromise;
    });

    expect(nativeWindow.destroy).not.toHaveBeenCalled();
  });

  it("unregisters a writer when its owner unmounts", async () => {
    const writer = createWriter();

    function Harness() {
      const [visible, setVisible] = useState(true);
      return (
        <PersistenceCoordinator>
          {visible && <RegisteredWriter name="note" writer={writer} />}
          <button type="button" onClick={() => setVisible(false)}>
            Leave reader
          </button>
        </PersistenceCoordinator>
      );
    }

    const user = userEvent.setup();
    render(<Harness />);
    await waitFor(() => expect(nativeWindow.closeHandler).toBeTypeOf("function"));
    await user.click(screen.getByRole("button", { name: "Leave reader" }));

    const preventDefault = vi.fn();
    await nativeWindow.closeHandler?.({ preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(writer.flush).not.toHaveBeenCalled();
  });

  it("rejects empty and duplicate writer names", async () => {
    let api: PersistenceCoordinatorApi | undefined;
    const onReady = (coordinator: PersistenceCoordinatorApi) => {
      api = coordinator;
    };
    render(
      <PersistenceCoordinator>
        <CaptureApi onReady={onReady} />
      </PersistenceCoordinator>,
    );
    await waitFor(() => expect(api).toBeDefined());

    expect(() => api?.registerWriter(" ", createWriter())).toThrow(
      "Persistence writers require a non-empty name",
    );
    const unregister = api?.registerWriter("note", createWriter());
    expect(() => api?.registerWriter("note", createWriter())).toThrow(
      'A persistence writer named "note" is already registered',
    );
    unregister?.();
  });

  it("exposes an explicit flush operation to workspace navigation", async () => {
    const writer = createWriter();
    const onComplete = vi.fn();
    const user = userEvent.setup();
    render(
      <PersistenceCoordinator>
        <RegisteredWriter name="note" writer={writer} />
        <ManualFlush onComplete={onComplete} />
      </PersistenceCoordinator>,
    );

    await user.click(screen.getByRole("button", { name: "Save now" }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(writer.flush).toHaveBeenCalledOnce();
    expect(nativeWindow.destroy).not.toHaveBeenCalled();
  });

  it("requires persistence hooks to be rendered inside the coordinator", () => {
    expect(() =>
      render(<RegisteredWriter name="note" writer={createWriter()} />),
    ).toThrow(
      "Persistence hooks must be used within a PersistenceCoordinator",
    );
  });
});
