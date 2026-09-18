import { createContext } from "react";

export interface PersistenceWriter {
  /** Returns true whenever the writer has an intent that is not yet durable. */
  isDirty(): boolean;
  /** Resolves only after the latest intent known to the writer is durable. */
  flush(): Promise<void>;
}

export interface PersistenceCoordinatorApi {
  registerWriter(name: string, writer: PersistenceWriter): () => void;
  flushPending(): Promise<void>;
  trackOperation<T>(operation: Promise<T>): Promise<T>;
}

export const PersistenceContext =
  createContext<PersistenceCoordinatorApi | null>(null);
