import { describe, expect, it } from "vitest";
import { legacyMindMapToMarkdown } from "./legacyMindMap";
import { renderMarkmap } from "./markmap";

describe("legacy mind map conversion", () => {
  const nodes = [
    { id: "root", title: "Paper", details: "", parentId: null },
    { id: "child", title: '" ] --> evil["<img> &#60; ` \\', details: "Evidence", parentId: "root" },
  ];
  it("preserves legacy topology and labels without allowing Markdown/HTML injection", async () => {
    const convert = (items: typeof nodes) => legacyMindMapToMarkdown(JSON.stringify({ schemaVersion: 1, nodes: items }));
    const source = convert(nodes);
    expect(convert([...nodes].reverse())).toBe(source);
    const tree = await renderMarkmap(source);
    expect(tree.content).toBe("Paper");
    expect(tree.children).toHaveLength(1);
    expect(new DOMParser().parseFromString(tree.children[0].content, "text/html").body.textContent).toBe(`${nodes[1].title} — Evidence`);
    expect(tree.children[0].content).not.toContain("<img>");
  });
  it("rejects disconnected cycles rather than losing legacy branches", () => {
    expect(() => legacyMindMapToMarkdown(JSON.stringify({ schemaVersion: 1, nodes: [
      nodes[0], { ...nodes[1], parentId: "child" },
    ] }))).toThrow(/cycle/);
  });
});
