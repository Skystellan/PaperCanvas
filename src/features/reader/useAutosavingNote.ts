import { useEffect, useMemo, useSyncExternalStore } from "react";
import { usePersistenceWriter } from "../persistence";
import {
  NoteAutosaveController,
  type NoteRepository,
} from "./model/noteAutosaveController";

export function useAutosavingNote(
  paperId: string,
  repository: NoteRepository,
) {
  const controller = useMemo(
    () => new NoteAutosaveController(paperId, repository),
    [paperId, repository],
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  usePersistenceWriter(`paper-note:${paperId}`, {
    flush: controller.flush,
    isDirty: controller.isDirty,
  });

  useEffect(() => {
    void controller.load();
    return () => controller.dispose();
  }, [controller]);

  return {
    ...snapshot,
    hasUnsavedChanges: controller.isDirty(),
    flush: controller.flush,
    retryLoad: controller.load,
    reload: () => controller.load(true),
    setDraft: controller.setDraft,
    append: (text: string) => {
      const draft = controller.getSnapshot().draft;
      controller.setDraft(`${draft.trimEnd()}${draft.trim() ? "\n\n" : ""}${text}\n`);
    },
  };
}
