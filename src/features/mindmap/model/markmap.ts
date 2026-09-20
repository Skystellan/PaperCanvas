import type { ITransformResult } from "markmap-lib";
export type MindMapNode = ITransformResult["root"];

export async function renderMarkmap(source: string): Promise<MindMapNode> {
  const fenced = source.match(/(?:^|\n)[ \t]*(`{3,}|~{3,})(?:markmap|markdown|md)[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1[ \t]*(?=\n|$)/i);
  const code = (fenced?.[2] ?? source).trim();
  if (!code) throw new Error("Paste a Markdown outline to render a mind map.");
  if (code.length > 50_000) throw new Error("The preview supports up to 50,000 characters. Your full source is kept.");
  if (/^(?:#{1,6}\s|[-+*]\s|\d+[.)]\s)/.test(code) === false) {
    throw new Error("Use a Markdown outline starting with # Title or a list. This saved source is kept unchanged; you can copy it and ask your AI chat to convert it to Markdown.");
  }
  const [{ Transformer }, { default: DOMPurify }] = await Promise.all([
    import("markmap-lib/no-plugins"), import("dompurify"),
  ]);
  // No frontmatter/plugin assets: pasted outlines cannot load scripts, fonts or images.
  const transformer = new Transformer();
  transformer.md.set({ html: false });
  transformer.md.renderer.rules.image = (tokens: { content: string }[], index: number) => transformer.md.utils.escapeHtml(tokens[index].content);

  const { root } = transformer.transform(code);
  const clean = (node: MindMapNode): MindMapNode => ({
    content: DOMPurify.sanitize(node.content, {
      ALLOWED_TAGS: ["strong", "em", "b", "i", "code", "s", "del", "ins", "mark", "sub", "sup", "br"],
      ALLOWED_ATTR: [],
    }),
    children: node.children?.map(clean),
  });
  return clean(root);
}
