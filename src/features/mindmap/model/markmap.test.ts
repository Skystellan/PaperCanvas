import { describe, expect, it } from "vitest";
import { renderMarkmap } from "./markmap";

describe("local Markdown outlines", () => {
  it("accepts fenced outlines and rejects non-Markdown without erasing it", async () => {
    expect(await renderMarkmap("Here is your outline:\n```markdown\n# Paper\n## Evidence\n```"))
      .toMatchObject({ content: "Paper", children: [{ content: "Evidence" }] });
    await expect(renderMarkmap("mindmap\n  Old saved source")).rejects.toThrow("kept unchanged");
    await expect(renderMarkmap("   ")).rejects.toThrow("Paste");
    await expect(renderMarkmap("# " + "x".repeat(50_000))).rejects.toThrow("50,000");
  });
  it("preserves headings, lists and safe inline formatting", async () => {
    const root = await renderMarkmap("# 中文论文\n## **方法**\n- `x` and *y*");
    expect(root).toMatchObject({
      children: [{ content: "<strong>方法</strong>", children: [{ content: "<code>x</code> and <em>y</em>" }] }],
    });
    expect(new DOMParser().parseFromString(root.content, "text/html").body.textContent).toBe("中文论文");
  });

  it("does not turn pasted images, links, HTML or configuration into active resources", async () => {
    const root = await renderMarkmap('# Paper\n## ![formula](https://example.com/leak.svg)\n- [link](javascript:alert(1))\n- [source](https://example.com)\n- <img src="https://example.com/pixel" onerror="alert(1)">\n- <script>alert(1)</script>');
    const markup = JSON.stringify(root);
    expect(markup).toContain("formula");
    expect(markup).not.toMatch(/<(?:img|script|a)\b/);
    expect(markup).toContain("&lt;img");
    expect(await renderMarkmap('# Paper\n\n```yaml\nextraJs: [https://example.com/run.js]\n```')).not.toHaveProperty("features");
  });
});
