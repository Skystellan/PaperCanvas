export type ResearchIntent = "independent" | "selected_papers" | "gap_analysis";
export type ResearchRelation = "related" | "extends" | "compares" | "uses" | "cites" | "supports" | "challenges";

export interface ResearchBatchInput {
  requestId: string;
  title: string;
  intent?: ResearchIntent;
  papers: Array<{
    ref: string; title: string; url: string; authors?: string; year?: number;
    doi?: string; arxivId?: string; abstract?: string; reason?: string; group?: string;
  }>;
  edges?: Array<{
    sourceRef: string; targetRef: string; kind: ResearchRelation;
    explanation: string; evidence?: string; basis?: "metadata" | "abstract" | "full_text";
  }>;
}

export interface ResearchBatchSummary {
  id: string; title: string; intent: ResearchIntent; createdAt: number;
  createdNodes: number; createdEdges: number; undone: boolean;
}

export interface ResearchPaper {
  doi: string | null; arxivId: string | null; url: string; abstract: string;
  arxivVersion?: string;
  reason: string; group: string; batchId: string;
}

export interface ResearchEdge {
  kind: ResearchRelation; basis: "metadata" | "abstract" | "full_text"; batchId: string;
}

export const researchRelationLabels: Record<ResearchRelation, string> = {
  related: "相关", extends: "扩展", compares: "比较", uses: "使用",
  cites: "引用", supports: "支持", challenges: "质疑",
};
export const researchBasisLabels = { metadata: "元数据", abstract: "摘要", full_text: "全文" };
