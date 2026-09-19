import { readFile as tauriReadFile } from "@tauri-apps/plugin-fs";
export { BaseDirectory } from "@tauri-apps/plugin-fs";

export const readFile: typeof tauriReadFile = async (path, options) => {
  if (!window.paperCanvas) return tauriReadFile(path, options);
  const bytes = await window.paperCanvas.invoke<number[] | Uint8Array | ArrayBuffer>(
    "read_file", { path: String(path) },
  );
  return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : Uint8Array.from(bytes);
};
