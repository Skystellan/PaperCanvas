import { useEffect, useRef, useState } from "react";
import { invoke } from "../../platform/core";
import { listen } from "../../platform/event";
import { executeWorkspaceCommand, type WorkspaceRequest } from "../../data/workspaceClient";
import type { CodeReviewUpdate, ResearchBatchInput, ResearchContextIntent } from "./research";

interface ResearchRequest {
  id: string;
  tool: "import_research_batch" | "read_research_context" | "save_paper_code_reviews";
  args: ResearchBatchInput | { intent: ResearchContextIntent; paperIds?: string[] } | { reviews: CodeReviewUpdate[] };
}

interface Options {
  ready: boolean;
  flushPending: () => Promise<void>;
  selectedPaperIds: readonly string[];
  refreshWorkspace: (paperIds?: string[]) => Promise<void>;
}

export function useResearchBridge(options: Options) {
  const latest = useRef(options);
  const [busy, setBusy] = useState(false);
  useEffect(() => { latest.current = options; }, [options]);

  useEffect(() => {
    if (!window.paperCanvas || !options.ready) return;
    let active = true;
    let queue = Promise.resolve();
    const subscription = listen<ResearchRequest>("research-tool-request", ({ payload }) => {
      queue = queue.then(async () => {
        if (!active) return;
        const { id, tool, args } = payload;
        const writing = tool === "import_research_batch" || tool === "save_paper_code_reviews";
        try {
          let request: WorkspaceRequest;
          if (writing) {
            setBusy(true);
            await latest.current.flushPending();
            request = tool === "import_research_batch"
              ? { type: "import_research_batch", batch: args as ResearchBatchInput }
              : { type: "save_paper_code_reviews", reviews: (args as { reviews: CodeReviewUpdate[] }).reviews };
          } else if (tool === "read_research_context") {
            const context = args as { intent: ResearchContextIntent; paperIds?: string[] };
            if (!["selected_papers", "gap_analysis", "code_review"].includes(context.intent)) throw new Error("Context requires an explicit intent.");
            const paperIds = context.paperIds ?? (context.intent === "selected_papers" ? [...latest.current.selectedPaperIds] : undefined);
            if (context.intent === "selected_papers" && !paperIds?.length) throw new Error("NO_SELECTION: Select papers in PaperCanvas or provide paperIds. No workspace context was read.");
            request = { type: "read_research_context", intent: context.intent, ...(paperIds ? { paperIds } : {}) };
          } else {
            throw new Error("Unknown research tool.");
          }
          const { value } = await executeWorkspaceCommand<Record<string, unknown>>(request);
          let result = value;
          if (writing) {
            const placements = value.placements as Array<{ paperId: string }> | undefined;
            try { await latest.current.refreshWorkspace(placements?.map(item => item.paperId)); }
            catch {
              // The transaction has committed. Do not report it as an import failure.
              result = { ...value, viewUpdated: false, warning: "Changes saved. Reload PaperCanvas to display them." };
            }
          }
          if (active) await invoke("research_tool_reply", { id, result });
        } catch (error) {
          if (active) await invoke("research_tool_reply", { id, error: error instanceof Error ? error.message : String(error) });
        } finally {
          if (active && writing) setBusy(false);
        }
      }).catch(() => {}); // A closed/reloading renderer cannot reply; the caller gets a transport error.
    });
    void subscription.then(() => {
      if (active) return invoke("research_bridge_ready");
    }).catch(() => {});
    return () => {
      active = false;
      void subscription.then(stop => stop()).catch(() => {});
    };
  }, [options.ready]);

  return busy;
}
