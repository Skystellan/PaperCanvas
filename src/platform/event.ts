import { listen as tauriListen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";

export async function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  const bridge = window.paperCanvas;
  if (!bridge) return tauriListen(event, handler);
  return bridge.on(event, (payload) => handler({ event, id: 0, payload: payload as T }));
}
