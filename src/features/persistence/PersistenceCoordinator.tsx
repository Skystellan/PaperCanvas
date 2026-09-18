import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  PersistenceContext,
  type PersistenceCoordinatorApi,
  type PersistenceWriter,
} from "./persistenceContext";
import "./PersistenceCoordinator.css";

interface PersistenceCoordinatorProps {
  children: ReactNode;
}

interface RegisteredPersistenceWriter {
  token: symbol;
  writer: PersistenceWriter;
}

type PersistenceIssue =
  | { kind: "listener" }
  | { kind: "flush" }
  | { kind: "destroy"; skipFlush?: boolean };

const issueContent: Record<
  PersistenceIssue["kind"],
  { message: string; retryLabel: string }
> = {
  listener: {
    message:
      "Save-on-close protection is unavailable. Keep PaperCanvas open until changes finish saving.",
    retryLabel: "Retry close protection",
  },
  flush: {
    message:
      "Could not save all local changes. PaperCanvas stayed open so you can retry.",
    retryLabel: "Retry saving",
  },
  destroy: {
    message: "PaperCanvas could not close. You can retry safely.",
    retryLabel: "Retry close",
  },
};

export function PersistenceCoordinator({
  children,
}: PersistenceCoordinatorProps) {
  const writersRef = useRef(new Map<string, RegisteredPersistenceWriter>());
  const trackedOperationsRef = useRef(new Set<Promise<unknown>>());
  const flushOperationRef = useRef<Promise<void> | null>(null);
  const closeOperationRef = useRef<Promise<void> | null>(null);
  const destroyOperationRef = useRef<Promise<void> | null>(null);
  const isMountedRef = useRef(true);
  const [listenerAttempt, setListenerAttempt] = useState(0);
  const [issue, setIssue] = useState<PersistenceIssue | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const registerWriter = useCallback(
    (name: string, writer: PersistenceWriter) => {
      if (name.trim().length === 0) {
        throw new Error("Persistence writers require a non-empty name.");
      }
      if (writersRef.current.has(name)) {
        throw new Error(`A persistence writer named "${name}" is already registered.`);
      }

      const token = Symbol(name);
      writersRef.current.set(name, { token, writer });

      return () => {
        const current = writersRef.current.get(name);
        if (current?.token === token) {
          writersRef.current.delete(name);
        }
      };
    },
    [],
  );

  const getDirtyWriters = useCallback(() => {
    const dirtyWriters: PersistenceWriter[] = [];

    for (const { writer } of writersRef.current.values()) {
      if (writer.isDirty()) dirtyWriters.push(writer);
    }

    return dirtyWriters;
  }, []);

  const flushPending = useCallback(() => {
    if (flushOperationRef.current) return flushOperationRef.current;

    const operation = (async () => {
      while (true) {
        const dirtyWriters = getDirtyWriters();
        if (dirtyWriters.length === 0) return;

        await Promise.all(dirtyWriters.map((writer) => writer.flush()));
      }
    })();

    flushOperationRef.current = operation;
    const clearOperation = () => {
      if (flushOperationRef.current === operation) {
        flushOperationRef.current = null;
      }
    };
    void operation.then(clearOperation, clearOperation);

    return operation;
  }, [getDirtyWriters]);

  const trackOperation = useCallback(
    <T,>(operation: Promise<T>): Promise<T> => {
      trackedOperationsRef.current.add(operation);
      const clearOperation = () => {
        trackedOperationsRef.current.delete(operation);
      };
      void operation.then(clearOperation, clearOperation);
      return operation;
    },
    [],
  );

  const flushBeforeClose = useCallback(async () => {
    while (true) {
      await flushPending();
      const trackedOperations = [...trackedOperationsRef.current];
      if (trackedOperations.length === 0) return;
      await Promise.all(trackedOperations);
    }
  }, [flushPending]);

  const destroyCurrentWindow = useCallback(() => {
    if (destroyOperationRef.current) return destroyOperationRef.current;

    const destroy = Promise.resolve().then(() => getCurrentWindow().destroy());
    const operation = destroy.finally(() => {
      if (destroyOperationRef.current === operation) {
        destroyOperationRef.current = null;
      }
    });
    destroyOperationRef.current = operation;

    return operation;
  }, []);

  useEffect(() => {
    if (!isTauri()) return;

    const appWindow = getCurrentWindow();
    let isDisposed = false;
    let stopListening: (() => void) | undefined;

    void appWindow
      .onCloseRequested((event) => {
        let hasDirtyWriter: boolean;
        try {
          hasDirtyWriter = getDirtyWriters().length > 0;
        } catch {
          hasDirtyWriter = true;
        }

        const activeClose = closeOperationRef.current;
        const hasTrackedOperation = trackedOperationsRef.current.size > 0;
        if (!activeClose && !hasDirtyWriter && !hasTrackedOperation) return;

        event.preventDefault();
        if (activeClose) return activeClose;

        const closeOperation = (async () => {
          try {
            await flushBeforeClose();
          } catch {
            if (!isDisposed && isMountedRef.current) {
              setIssue({ kind: "flush" });
            }
            return;
          }

          if (isDisposed || !isMountedRef.current) return;

          try {
            await destroyCurrentWindow();
            if (isMountedRef.current) setIssue(null);
          } catch {
            if (!isDisposed && isMountedRef.current) {
              setIssue({ kind: "destroy" });
            }
          }
        })();

        closeOperationRef.current = closeOperation;
        void closeOperation.then(() => {
          if (closeOperationRef.current === closeOperation) {
            closeOperationRef.current = null;
          }
        });

        return closeOperation;
      })
      .then((unlisten) => {
        if (isDisposed) {
          unlisten();
          return;
        }

        stopListening = unlisten;
        setIssue((currentIssue) =>
          currentIssue?.kind === "listener" ? null : currentIssue,
        );
      })
      .catch(() => {
        if (!isDisposed && isMountedRef.current) {
          setIssue({ kind: "listener" });
        }
      });

    return () => {
      isDisposed = true;
      stopListening?.();
    };
  }, [
    destroyCurrentWindow,
    flushBeforeClose,
    getDirtyWriters,
    listenerAttempt,
  ]);

  const retry = useCallback(async () => {
    if (!issue || isRetrying) return;

    setIsRetrying(true);
    if (issue.kind === "listener") {
      setIssue(null);
      setListenerAttempt((attempt) => attempt + 1);
      setIsRetrying(false);
      return;
    }

    try {
      if (issue.kind !== "destroy" || !issue.skipFlush) {
        await flushBeforeClose();
      }
      if (issue.kind === "destroy") {
        await destroyCurrentWindow();
      }
      if (isMountedRef.current) setIssue(null);
    } catch {
      if (isMountedRef.current) setIssue(issue);
    } finally {
      if (isMountedRef.current) setIsRetrying(false);
    }
  }, [destroyCurrentWindow, flushBeforeClose, isRetrying, issue]);

  const closeWithoutSaving = useCallback(async () => {
    if (issue?.kind !== "flush" || isRetrying) return;

    setIsRetrying(true);
    try {
      await destroyCurrentWindow();
      if (isMountedRef.current) setIssue(null);
    } catch {
      if (isMountedRef.current) {
        setIssue({ kind: "destroy", skipFlush: true });
      }
    } finally {
      if (isMountedRef.current) setIsRetrying(false);
    }
  }, [destroyCurrentWindow, isRetrying, issue]);

  const api = useMemo<PersistenceCoordinatorApi>(
    () => ({ registerWriter, flushPending, trackOperation }),
    [flushPending, registerWriter, trackOperation],
  );
  const currentIssue = issue ? issueContent[issue.kind] : null;

  return (
    <PersistenceContext.Provider value={api}>
      {children}
      {currentIssue && (
        <div
          className="persistence-coordinator__error"
          role="alert"
          aria-live="assertive"
        >
          <span>{currentIssue.message}</span>
          {issue?.kind === "flush" && (
            <button
              type="button"
              disabled={isRetrying}
              onClick={() => void closeWithoutSaving()}
            >
              Close without saving
            </button>
          )}
          <button type="button" disabled={isRetrying} onClick={() => void retry()}>
            {isRetrying ? "Retrying…" : currentIssue.retryLabel}
          </button>
        </div>
      )}
    </PersistenceContext.Provider>
  );
}
