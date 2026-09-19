import { open as tauriOpen } from "@tauri-apps/plugin-dialog";

export const open: typeof tauriOpen = ((options) => {
  if (!window.paperCanvas) return tauriOpen(options);
  return window.paperCanvas.invoke<string[] | null>("open_pdf_dialog");
}) as typeof tauriOpen;
