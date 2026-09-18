import { createContext } from "react";

export const ReaderToolbarContext = createContext<{
  workspace: HTMLDivElement | null;
  chat: HTMLDivElement | null;
  visible: boolean;
}>({ workspace: null, chat: null, visible: true });
