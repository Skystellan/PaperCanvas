/// <reference types="vite/client" />

interface Window {
  paperCanvas?: {
    invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
    on(event: string, callback: (payload: unknown) => void | Promise<void>): () => void;
    getPathForFile(file: File): string;
  };
}
