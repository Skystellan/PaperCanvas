import type { HTMLAttributes } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NodeProps } from "@xyflow/react";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: ({
      className,
      isConnectable,
      position,
      style,
      type,
      ...rest
    }: {
      isConnectable: boolean;
      position: string;
      type: string;
    } & HTMLAttributes<HTMLSpanElement>) => (
      <span
        {...rest}
        className={className}
        data-connectable={isConnectable}
        data-position={position}
        data-testid={`${type}-handle`}
        style={style}
      />
    ),
  };
});

import { PaperCard } from "./PaperCard";
import type { PaperFlowNode } from "./model/boardNode";

function createProps(
  selected: boolean,
  isConnectable = false,
): NodeProps<PaperFlowNode> {
  return {
    id: "node-attention",
    data: {
      paper: {
        id: "paper-attention",
        title: "Attention Is All You Need",
        authors: "Vaswani et al.",
        year: 2017,
        filePath: "papers/attention.pdf",
        createdAt: 1,
        domainId: null,
      },
    },
    type: "paper",
    selected,
    dragging: false,
    draggable: true,
    selectable: true,
    deletable: false,
    isConnectable,
    positionAbsoluteX: 120,
    positionAbsoluteY: 80,
    zIndex: 0,
  };
}

describe("PaperCard", () => {
  it("shows paper metadata", () => {
    render(<PaperCard {...createProps(false)} />);

    expect(screen.getByText("Attention Is All You Need")).toBeVisible();
    expect(screen.getByText(/Vaswani et al\./)).toHaveTextContent(
      "Vaswani et al. · 2017",
    );
    expect(screen.getByRole("article")).not.toHaveClass("is-selected");
    expect(screen.getByTestId("target-handle")).toBeInTheDocument();
    expect(screen.getByTestId("source-handle")).toBeInTheDocument();
  });

  it("reflects React Flow selection", () => {
    render(<PaperCard {...createProps(true)} />);

    expect(screen.getByRole("article")).toHaveClass("is-selected");
  });

  it("keeps both edge anchors invisible at the card's geometric center", () => {
    render(<PaperCard {...createProps(false, true)} />);

    for (const type of ["target", "source"]) {
      const handle = screen.getByTestId(`${type}-handle`);
      expect(handle).toHaveAttribute("data-connectable", "false");
      expect(handle).toHaveAttribute("data-position", "top");
      expect(handle).toHaveAttribute("aria-hidden", "true");
      expect(handle).toHaveAttribute("tabindex", "-1");
      expect(handle.style.left).toBe("50%");
      expect(handle.style.top).toBe("50%");
      expect(handle.style.width).toBe("0px");
      expect(handle.style.height).toBe("0px");
      expect(handle.style.minWidth).toBe("0px");
      expect(handle.style.minHeight).toBe("0px");
      expect(handle.style.border).toBe("0px");
      expect(handle.style.padding).toBe("0px");
      expect(handle.style.opacity).toBe("0");
      expect(handle.style.pointerEvents).toBe("none");
    }
  });

  it("lets keyboard users select a connection endpoint with Enter", () => {
    const onKeyboardConnectionSelect = vi.fn();
    const props = createProps(false);
    props.data.onKeyboardConnectionSelect = onKeyboardConnectionSelect;
    render(<PaperCard {...props} />);
    const card = screen.getByRole("article", {
      name: "连接节点：Attention Is All You Need",
    });

    card.focus();
    fireEvent.keyDown(card, { key: "Enter" });

    expect(onKeyboardConnectionSelect).toHaveBeenCalledWith("node-attention");
  });

  it("does not fabricate missing metadata", () => {
    const props = createProps(false);
    props.data.paper.authors = null;
    props.data.paper.year = null;
    render(<PaperCard {...props} />);

    expect(screen.queryByText("·")).not.toBeInTheDocument();
    expect(screen.getByText("Metadata unavailable")).toBeVisible();
  });
});
