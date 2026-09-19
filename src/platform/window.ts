import { getCurrentWindow as tauriWindow } from "@tauri-apps/api/window";

type CloseHandler = (event: { preventDefault(): void }) => void | Promise<void>;

export function getCurrentWindow() {
  const bridge = window.paperCanvas;
  if (!bridge) return tauriWindow();
  return {
    destroy: () => bridge.invoke<void>("window_destroy"),
    async onCloseRequested(handler: CloseHandler) {
      return bridge.on("native-close-requested", async () => {
        let prevented = false;
        await handler({ preventDefault: () => { prevented = true; } });
        if (!prevented) await bridge.invoke<void>("window_destroy");
      });
    },
  };
}
