import { render, screen } from "@testing-library/react";
import type { NodeProps } from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";
import type { MindMapFlowNode } from "./model/mindMapFlow";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: ({ type }: { type: string }) => (
      <span data-testid={`${type}-handle`} />
    ),
  };
});

import { MindMapNodeCard } from "./MindMapNodeCard";

function createProps({
  details,
  isRoot,
  selected,
}: {
  details: string;
  isRoot: boolean;
  selected: boolean;
}): NodeProps<MindMapFlowNode> {
  return {
    id: isRoot ? "root" : "idea",
    data: { details, isRoot, title: isRoot ? "Paper thesis" : "Evidence" },
    type: "mind-map",
    selected,
    dragging: false,
    draggable: true,
    selectable: true,
    deletable: false,
    isConnectable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    zIndex: 0,
  };
}

describe("MindMapNodeCard", () => {
  it("distinguishes a selected paper root from an ordinary idea", () => {
    const { rerender } = render(
      <MindMapNodeCard
        {...createProps({ details: "Main claim", isRoot: true, selected: true })}
      />,
    );

    expect(screen.getByRole("article")).toHaveClass("is-root", "is-selected");
    expect(screen.getByText("Paper")).toBeVisible();
    expect(screen.getByText("Main claim")).toBeVisible();
    expect(screen.getByTestId("target-handle")).toBeInTheDocument();
    expect(screen.getByTestId("source-handle")).toBeInTheDocument();

    rerender(
      <MindMapNodeCard
        {...createProps({ details: "", isRoot: false, selected: false })}
      />,
    );
    expect(screen.getByRole("article")).not.toHaveClass("is-root", "is-selected");
    expect(screen.getByText("Idea")).toBeVisible();
    expect(screen.queryByText("Main claim")).not.toBeInTheDocument();
  });
});
