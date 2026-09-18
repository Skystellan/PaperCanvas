import { useContext, useEffect, useLayoutEffect, useRef } from "react";
import {
  PersistenceContext,
  type PersistenceCoordinatorApi,
  type PersistenceWriter,
} from "./persistenceContext";

export function usePersistenceCoordinator(): PersistenceCoordinatorApi {
  const coordinator = useContext(PersistenceContext);

  if (!coordinator) {
    throw new Error(
      "Persistence hooks must be used within a PersistenceCoordinator.",
    );
  }

  return coordinator;
}

export function usePersistenceWriter(
  name: string,
  writer: PersistenceWriter,
): void {
  const { registerWriter } = usePersistenceCoordinator();
  const writerRef = useRef(writer);

  useLayoutEffect(() => {
    writerRef.current = writer;
  }, [writer]);

  useEffect(
    () =>
      registerWriter(name, {
        isDirty: () => writerRef.current.isDirty(),
        flush: () => writerRef.current.flush(),
      }),
    [name, registerWriter],
  );
}
