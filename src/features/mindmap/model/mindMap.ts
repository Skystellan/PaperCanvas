export const MIND_MAP_SCHEMA_VERSION = 1 as const;

export const MIND_MAP_LIMITS = {
  maxNodes: 80,
  maxIdLength: 120,
  maxTitleLength: 240,
  maxDetailsLength: 4_000,
  maxSourcePromptLength: 8_000,
  maxPaperIdLength: 256,
  maxCoordinateMagnitude: 1_000_000,
  maxSerializedBytes: 1_000_000,
} as const;

export interface MindMapNode {
  id: string;
  title: string;
  details: string;
  parentId: string | null;
  x: number;
  y: number;
}

export interface MindMapTree {
  schemaVersion: typeof MIND_MAP_SCHEMA_VERSION;
  revision: number;
  sourcePrompt: string;
  nodes: MindMapNode[];
  updatedAt: number;
}

export class MindMapValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MindMapValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactFields(
  value: Record<string, unknown>,
  expectedFields: readonly string[],
  label: string,
) {
  const actualFields = Object.keys(value).sort();
  const sortedExpected = [...expectedFields].sort();
  if (
    actualFields.length !== sortedExpected.length ||
    actualFields.some((field, index) => field !== sortedExpected[index])
  ) {
    throw new MindMapValidationError(`${label} contains an unexpected field.`);
  }
}

function requireString(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty: boolean,
): string {
  if (typeof value !== "string") {
    throw new MindMapValidationError(`${label} must be a string.`);
  }
  if ((!allowEmpty && value.trim().length === 0) || value.length > maxLength) {
    throw new MindMapValidationError(
      `${label} must be ${allowEmpty ? "at most" : "between 1 and"} ${maxLength} characters.`,
    );
  }
  return value;
}

function requireSafePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new MindMapValidationError(`${label} must be a positive integer.`);
  }
  return value as number;
}

function requireCoordinate(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > MIND_MAP_LIMITS.maxCoordinateMagnitude
  ) {
    throw new MindMapValidationError(`${label} must be a finite canvas coordinate.`);
  }
  return value;
}

function validateNode(value: unknown, index: number): MindMapNode {
  if (!isRecord(value)) {
    throw new MindMapValidationError(`nodes[${index}] must be an object.`);
  }
  assertExactFields(
    value,
    ["id", "title", "details", "parentId", "x", "y"],
    `nodes[${index}]`,
  );

  const id = requireString(
    value.id,
    `nodes[${index}].id`,
    MIND_MAP_LIMITS.maxIdLength,
    false,
  );
  if (id !== id.trim()) {
    throw new MindMapValidationError(`nodes[${index}].id must not have outer whitespace.`);
  }
  const parentId =
    value.parentId === null
      ? null
      : requireString(
          value.parentId,
          `nodes[${index}].parentId`,
          MIND_MAP_LIMITS.maxIdLength,
          false,
        );
  if (parentId !== null && parentId !== parentId.trim()) {
    throw new MindMapValidationError(
      `nodes[${index}].parentId must not have outer whitespace.`,
    );
  }

  return {
    id,
    title: requireString(
      value.title,
      `nodes[${index}].title`,
      MIND_MAP_LIMITS.maxTitleLength,
      false,
    ),
    details: requireString(
      value.details,
      `nodes[${index}].details`,
      MIND_MAP_LIMITS.maxDetailsLength,
      true,
    ),
    parentId,
    x: requireCoordinate(value.x, `nodes[${index}].x`),
    y: requireCoordinate(value.y, `nodes[${index}].y`),
  };
}

function assertTreeTopology(nodes: readonly MindMapNode[]) {
  const byId = new Map<string, MindMapNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) {
      throw new MindMapValidationError(`Mind map node ID "${node.id}" is duplicated.`);
    }
    byId.set(node.id, node);
  }

  const roots = nodes.filter((node) => node.parentId === null);
  if (roots.length !== 1) {
    throw new MindMapValidationError("A mind map must contain exactly one root node.");
  }

  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    if (!byId.has(node.parentId)) {
      throw new MindMapValidationError(
        `Mind map node "${node.id}" refers to a missing parent.`,
      );
    }
    if (node.parentId === node.id) {
      throw new MindMapValidationError("A mind map node cannot be its own parent.");
    }
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.id);
    children.set(node.parentId, siblings);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) {
      throw new MindMapValidationError("The mind map contains a cycle.");
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const childId of children.get(id) ?? []) visit(childId);
    visiting.delete(id);
    visited.add(id);
  };
  visit(roots[0]!.id);

  if (visited.size !== nodes.length) {
    throw new MindMapValidationError(
      "Every mind map node must be connected to the root; a cycle may be disconnected.",
    );
  }
}

export function validateMindMapTree(value: unknown): MindMapTree {
  if (!isRecord(value)) {
    throw new MindMapValidationError("Mind map tree must be an object.");
  }
  assertExactFields(
    value,
    ["schemaVersion", "revision", "sourcePrompt", "nodes", "updatedAt"],
    "Mind map tree",
  );
  if (value.schemaVersion !== MIND_MAP_SCHEMA_VERSION) {
    throw new MindMapValidationError("Mind map schemaVersion is not supported.");
  }
  if (!Array.isArray(value.nodes)) {
    throw new MindMapValidationError("Mind map nodes must be an array.");
  }
  if (value.nodes.length < 1 || value.nodes.length > MIND_MAP_LIMITS.maxNodes) {
    throw new MindMapValidationError(
      `A mind map must contain between 1 and ${MIND_MAP_LIMITS.maxNodes} nodes.`,
    );
  }

  const updatedAt = requireSafePositiveInteger(value.updatedAt, "updatedAt");
  const tree: MindMapTree = {
    schemaVersion: MIND_MAP_SCHEMA_VERSION,
    revision: requireSafePositiveInteger(value.revision, "revision"),
    sourcePrompt: requireString(
      value.sourcePrompt,
      "sourcePrompt",
      MIND_MAP_LIMITS.maxSourcePromptLength,
      true,
    ),
    nodes: value.nodes.map(validateNode),
    updatedAt,
  };
  assertTreeTopology(tree.nodes);
  const serializedBytes = new TextEncoder().encode(JSON.stringify(tree)).byteLength;
  if (serializedBytes > MIND_MAP_LIMITS.maxSerializedBytes) {
    throw new MindMapValidationError(
      `Mind map JSON must serialize to at most ${MIND_MAP_LIMITS.maxSerializedBytes} bytes.`,
    );
  }
  return tree;
}

export function validateMindMapPaperId(paperId: string): string {
  const validated = requireString(
    paperId,
    "paperId",
    MIND_MAP_LIMITS.maxPaperIdLength,
    false,
  );
  if (validated !== validated.trim()) {
    throw new MindMapValidationError("paperId must not have outer whitespace.");
  }
  return validated;
}
