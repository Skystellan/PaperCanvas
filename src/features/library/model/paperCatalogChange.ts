export interface PaperCatalogChange {
  kind: "deleted" | "imported" | "organized";
  paperIds: string[];
  revision: number;
}
