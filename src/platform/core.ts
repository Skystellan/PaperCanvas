import * as tauri from "@tauri-apps/api/core";

export class Channel<T> {
  onmessage: (message: T) => void = () => {};

  constructor() {
    if (!window.paperCanvas) return new tauri.Channel<T>();
  }
}

export function isTauri(): boolean {
  // Existing callers use this as the native desktop capability check.
  return Boolean(window.paperCanvas) || tauri.isTauri();
}

export async function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const bridge = window.paperCanvas;
  if (!bridge) return args === undefined ? tauri.invoke<T>(command) : tauri.invoke<T>(command, args);
  if (command === "start_codex_turn" && args?.onEvent instanceof Channel) {
    const channel = args.onEvent;
    const request = args.request as { requestId: string };
    const unlisten = bridge.on("codex-stream", (payload) => {
      const message = payload as { requestId: string; event: unknown };
      if (message.requestId === request.requestId) channel.onmessage(message.event);
    });
    try {
      return await bridge.invoke<T>(command, { request });
    } finally {
      unlisten();
    }
  }
  return bridge.invoke<T>(command, args);
}
