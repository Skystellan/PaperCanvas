export interface PaperCatalogChange {
  kind: "deleted" | "imported" | "organized" | "external";
  paperIds: string[];
  revision: number;
}
