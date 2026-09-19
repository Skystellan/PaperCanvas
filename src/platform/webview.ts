import { getCurrentWebview as tauriWebview } from "@tauri-apps/api/webview";
import type { EventCallback } from "@tauri-apps/api/event";

type Position = { x: number; y: number };
type DragPayload =
  | { type: "enter" | "drop"; paths: string[]; position: Position }
  | { type: "over"; position: Position }
  | { type: "leave" };

export function getCurrentWebview() {
  const bridge = window.paperCanvas;
  if (!bridge) return tauriWebview();
  return {
    async onDragDropEvent(handler: EventCallback<DragPayload>) {
      let depth = 0;
      const emit = (payload: DragPayload) => handler({ event: "drag-drop", id: 0, payload });
      const position = (event: DragEvent) => ({ x: event.clientX, y: event.clientY });
      const enter = (event: DragEvent) => {
        event.preventDefault();
        if (depth++ === 0) emit({ type: "enter", paths: [], position: position(event) });
      };
      const over = (event: DragEvent) => {
        event.preventDefault();
        emit({ type: "over", position: position(event) });
      };
      const leave = () => {
        depth = Math.max(0, depth - 1);
        if (depth === 0) emit({ type: "leave" });
      };
      const drop = (event: DragEvent) => {
        event.preventDefault();
        depth = 0;
        const paths = Array.from(event.dataTransfer?.files ?? [])
          .map((file) => bridge.getPathForFile(file)).filter(Boolean);
        emit({ type: "drop", paths, position: position(event) });
      };
      const end = () => { depth = 0; emit({ type: "leave" }); };
      window.addEventListener("dragenter", enter);
      window.addEventListener("dragover", over);
      window.addEventListener("dragleave", leave);
      window.addEventListener("drop", drop);
      window.addEventListener("dragend", end);
      return () => {
        window.removeEventListener("dragenter", enter);
        window.removeEventListener("dragover", over);
        window.removeEventListener("dragleave", leave);
        window.removeEventListener("drop", drop);
        window.removeEventListener("dragend", end);
      };
    },
  };
}
