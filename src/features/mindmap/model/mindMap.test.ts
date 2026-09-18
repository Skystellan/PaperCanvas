import { describe, expect, it } from "vitest";
import {
  MIND_MAP_LIMITS,
  MindMapValidationError,
  validateMindMapTree,
  type MindMapTree,
} from "./mindMap";

function validTree(): MindMapTree {
  return {
    schemaVersion: 1,
    revision: 1,
    sourcePrompt: "Explain the paper",
    nodes: [
      {
        id: "root",
        title: "Paper",
        details: "Central claim",
        parentId: null,
        x: 0,
        y: 0,
      },
      {
        id: "method",
        title: "Method",
        details: "How it works",
        parentId: "root",
        x: 300,
        y: 0,
      },
    ],
    updatedAt: 1_700_000_000_000,
  };
}

describe("validateMindMapTree", () => {
  it("returns a detached, strictly validated tree", () => {
    const input = validTree();
    const result = validateMindMapTree(input);

    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(result.nodes).not.toBe(input.nodes);
    expect(result.nodes[0]).not.toBe(input.nodes[0]);
  });

  it.each([
    ["duplicate IDs", (tree: MindMapTree) => {
      tree.nodes[1]!.id = "root";
    }],
    ["missing parents", (tree: MindMapTree) => {
      tree.nodes[1]!.parentId = "missing";
    }],
    ["multiple roots", (tree: MindMapTree) => {
      tree.nodes[1]!.parentId = null;
    }],
    ["cycles", (tree: MindMapTree) => {
      tree.nodes[0]!.parentId = "method";
    }],
    ["non-finite positions", (tree: MindMapTree) => {
      tree.nodes[0]!.x = Number.NaN;
    }],
  ])("rejects %s", (_name, mutate) => {
    const tree = validTree();
    mutate(tree);
    expect(() => validateMindMapTree(tree)).toThrow(MindMapValidationError);
  });

  it("rejects a disconnected cycle even when another component has one root", () => {
    const tree = validTree();
    tree.nodes.push(
      {
        id: "cycle-a",
        title: "A",
        details: "",
        parentId: "cycle-b",
        x: 10,
        y: 10,
      },
      {
        id: "cycle-b",
        title: "B",
        details: "",
        parentId: "cycle-a",
        x: 20,
        y: 20,
      },
    );

    expect(() => validateMindMapTree(tree)).toThrow(/cycle|connected/i);
  });

  it("enforces node count and user-content length limits", () => {
    const tooMany = validTree();
    tooMany.nodes = Array.from(
      { length: MIND_MAP_LIMITS.maxNodes + 1 },
      (_, index) => ({
        id: `node-${index}`,
        title: "Node",
        details: "",
        parentId: index === 0 ? null : "node-0",
        x: index * 300,
        y: 0,
      }),
    );
    expect(() => validateMindMapTree(tooMany)).toThrow(/80/);

    const longTitle = validTree();
    longTitle.nodes[0]!.title = "x".repeat(MIND_MAP_LIMITS.maxTitleLength + 1);
    expect(() => validateMindMapTree(longTitle)).toThrow(/title/i);

    const longPrompt = validTree();
    longPrompt.sourcePrompt = "x".repeat(
      MIND_MAP_LIMITS.maxSourcePromptLength + 1,
    );
    expect(() => validateMindMapTree(longPrompt)).toThrow(/prompt/i);
  });

  it("rejects unknown tree and node properties instead of silently accepting them", () => {
    const unknownTreeField = { ...validTree(), providerPayload: "untrusted" };
    expect(() => validateMindMapTree(unknownTreeField)).toThrow(/field/i);

    const unknownNodeField = validTree() as MindMapTree & {
      nodes: Array<MindMapTree["nodes"][number] & { html?: string }>;
    };
    unknownNodeField.nodes[0]!.html = "<script>alert(1)</script>";
    expect(() => validateMindMapTree(unknownNodeField)).toThrow(/field/i);
  });

  it("requires persistence metadata to be safe positive integers", () => {
    const invalidRevision = validTree();
    invalidRevision.revision = 0;
    expect(() => validateMindMapTree(invalidRevision)).toThrow(/revision/i);

    const invalidTimestamp = validTree();
    invalidTimestamp.updatedAt = -1;
    expect(() => validateMindMapTree(invalidTimestamp)).toThrow(/updatedAt/i);
  });

  it("rejects non-object, unsupported-schema, and non-array payload shapes", () => {
    expect(() => validateMindMapTree(null)).toThrow(/object/i);
    expect(() =>
      validateMindMapTree({ ...validTree(), schemaVersion: 2 }),
    ).toThrow(/schemaVersion/i);
    expect(() =>
      validateMindMapTree({ ...validTree(), nodes: "not-an-array" }),
    ).toThrow(/array/i);
    expect(() => validateMindMapTree({ ...validTree(), nodes: [] })).toThrow(
      /between 1 and 80/i,
    );
  });

  it("rejects malformed node records, self-parenting, and padded IDs", () => {
    expect(() =>
      validateMindMapTree({ ...validTree(), nodes: [null] }),
    ).toThrow(/nodes\[0\].*object/i);

    const selfParent = validTree();
    selfParent.nodes[1]!.parentId = "method";
    expect(() => validateMindMapTree(selfParent)).toThrow(/own parent/i);

    const paddedId = validTree();
    paddedId.nodes[1]!.id = " method ";
    expect(() => validateMindMapTree(paddedId)).toThrow(/outer whitespace/i);

    const paddedParent = validTree();
    paddedParent.nodes[1]!.parentId = " root ";
    expect(() => validateMindMapTree(paddedParent)).toThrow(/outer whitespace/i);
  });

  it("enforces the same serialized UTF-8 size ceiling as local persistence", () => {
    const oversized = validTree();
    oversized.nodes = Array.from(
      { length: MIND_MAP_LIMITS.maxNodes },
      (_, index) => ({
        id: `node-${index}`,
        title: `Node ${index}`,
        details: "\u0000".repeat(MIND_MAP_LIMITS.maxDetailsLength),
        parentId: index === 0 ? null : "node-0",
        x: index * 100,
        y: index * 100,
      }),
    );

    expect(() => validateMindMapTree(oversized)).toThrow(/serialized|bytes/i);
  });
});
