import * as tauri from "@tauri-apps/api/core";

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
  return bridge.invoke<T>(command, args);
}
