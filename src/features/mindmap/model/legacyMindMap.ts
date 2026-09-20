interface LegacyNode {
  id: string;
  title: string;
  details: string;
  parentId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeLabel(value: string): string {
  return value.replace(/[\r\n]+/g, " — ").replace(/[\\`*_[\]{}()#+.!<>|&-]/g, "\\$&");
}

export function legacyMindMapToMarkdown(json: string): string {
  const tree: unknown = JSON.parse(json);
  if (!isRecord(tree) || tree.schemaVersion !== 1 || !Array.isArray(tree.nodes) ||
      tree.nodes.length === 0 || tree.nodes.length > 80) {
    throw new Error("The saved legacy mind map is invalid. Its original data was kept.");
  }
  const nodes: LegacyNode[] = tree.nodes.map((node: unknown) => {
    if (!isRecord(node) || typeof node.id !== "string" || !node.id ||
        typeof node.title !== "string" || typeof node.details !== "string" ||
        (node.parentId !== null && typeof node.parentId !== "string")) {
      throw new Error("The saved legacy mind map contains an invalid node.");
    }
    return { id: node.id, title: node.title, details: node.details, parentId: node.parentId };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length || nodes.filter((node) => node.parentId === null).length !== 1) {
    throw new Error("The saved legacy mind map is not a tree.");
  }
  for (const node of nodes) {
    const visited = new Set<string>();
    let current: LegacyNode | undefined = node;
    while (current) {
      if (visited.has(current.id)) throw new Error("The saved legacy mind map contains a cycle.");
      visited.add(current.id);
      if (current.parentId === null) break;
      current = byId.get(current.parentId);
      if (!current) throw new Error("The saved legacy mind map has a missing parent.");
    }
  }
  const lines: string[] = [];
  function append(node: LegacyNode, depth: number) {
    lines.push(`${"  ".repeat(depth)}- ${escapeLabel(node.details ? `${node.title} — ${node.details}` : node.title)}`);
    for (const child of nodes.filter((candidate) => candidate.parentId === node.id)) append(child, depth + 1);
  }
  append(nodes.find((node) => node.parentId === null)!, 0);
  return lines.join("\n");
}
