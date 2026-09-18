import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  PanOnScrollMode,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  ViewportPortal,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
  type OnNodeDrag,
  type OnBeforeDelete,
} from "@xyflow/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
} from "react";
import {
  PAPER_DRAG_MIME,
  sqlitePaperDomainRepository,
  type Paper,
  type PaperCatalogChange,
  type PaperDomainRepository,
  type PaperDropIntent,
} from "../library";
import { usePersistenceWriter } from "../persistence";
import { PaperCard } from "./PaperCard";
import type { BoardRepository } from "./data/boardRepository";
import {
  boardRepository,
  DEFAULT_NODE_SIZE,
} from "./data/sqliteBoardRepository";
import {
  connectionKey,
  toFlowEdge,
  withEdgeRelation,
  type BoardEdgeRelation,
  type PaperFlowEdge,
} from "./model/boardEdge";
import {
  toFlowNode,
  toPositionUpdates,
  type NodePositionUpdate,
  type PaperFlowNode,
} from "./model/boardNode";
import {
  findCollisionFreePosition,
  pushNodeGroupDuringDrag,
  resolveNodeOverlaps,
  toNodeRectangle,
  type NodeRectangle,
} from "./model/nodeCollision";
import {
  computeDomainFrames,
  separateDomainGroups,
  type WhiteboardDomain,
} from "./model/domainFrames";
import {
  createObsidianForceLayout,
  localLayoutNodeIds,
} from "./model/obsidianForceLayout";
import "./whiteboardInteractions.css";

export { PAPER_DRAG_MIME };

const nodeTypes = {
  paper: PaperCard,
} satisfies NodeTypes;

export interface WhiteboardProps {
  active?: boolean;
  domains?: readonly WhiteboardDomain[];
  domainRepository?: Pick<PaperDomainRepository, "list">;
  paperCatalogChange?: PaperCatalogChange | null;
  repository?: BoardRepository;
  onOpenPaper?: (paper: Paper) => void;
  onPaperDropComplete?: () => void;
  paperDropIntent?: PaperDropIntent | null;
}

export type WhiteboardScope =
  | { kind: "all" }
  | { kind: "domain"; domainId: string | null };

type LoadState = "loading" | "ready" | "error";
type SaveState = "idle" | "error";
type ActionError = "paper" | "connection" | null;

const ALL_SCOPE: WhiteboardScope = { kind: "all" };

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    target.closest(
      "input, textarea, select, button, a, [contenteditable='true'], [role='textbox']",
    ) !== null
  );
}

function requestsReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function requestMotionFrame(callback: FrameRequestCallback) {
  return typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : window.setTimeout(() => callback(performance.now()), 16);
}

function cancelMotionFrame(frame: number) {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
  else window.clearTimeout(frame);
}

function nodeBelongsToScope(node: PaperFlowNode, scope: WhiteboardScope) {
  return (
    scope.kind === "all" || node.data.paper.domainId === scope.domainId
  );
}

function mergeLayoutPositions(
  nodes: readonly PaperFlowNode[],
  layoutNodeIds: ReadonlySet<string>,
  positions: ReadonlyMap<string, { x: number; y: number }>,
  pinnedNodeIds: ReadonlySet<string>,
) {
  const positionedLayoutNodes = resolveNodeOverlaps(
    nodes
      .filter(({ id }) => layoutNodeIds.has(id))
      .map((node) => ({
        ...node,
        position: positions.get(node.id) ?? node.position,
      })),
    { pinnedNodeIds },
  );
  const positionedById = new Map(
    positionedLayoutNodes.map((node) => [node.id, node] as const),
  );
  return nodes.map((node) => positionedById.get(node.id) ?? node);
}

function WhiteboardCanvas({
  active,
  domainRepository,
  domains,
  paperCatalogChange,
  repository,
  onOpenPaper,
  onPaperDropComplete,
  paperDropIntent,
}: Required<Pick<WhiteboardProps, "repository" | "domainRepository">> &
  Pick<
    WhiteboardProps,
    | "onOpenPaper"
    | "onPaperDropComplete"
    | "paperCatalogChange"
    | "paperDropIntent"
    | "domains"
    | "active"
  >) {
  const { fitView, screenToFlowPosition } = useReactFlow();
  const [nodes, setNodes] = useState<PaperFlowNode[]>([]);
  const [edges, setEdges] = useState<PaperFlowEdge[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [actionError, setActionError] = useState<ActionError>(null);
  const [scope, setScope] = useState<WhiteboardScope>(ALL_SCOPE);
  const [connectionMode, setConnectionMode] = useState(false);
  const [connectionSourceId, setConnectionSourceId] = useState<string | null>(
    null,
  );
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [relationUpdatePending, setRelationUpdatePending] = useState(false);
  const [fitRevision, setFitRevision] = useState(0);
  const [repositoryDomains, setRepositoryDomains] = useState<
    readonly WhiteboardDomain[]
  >([]);
  const availableDomains = domains ?? repositoryDomains;
  const resolvedScope =
    scope.kind === "domain" &&
    scope.domainId !== null &&
    !availableDomains.some((domain) => domain.id === scope.domainId)
      ? ALL_SCOPE
      : scope;
  const canvasRef = useRef<HTMLElement>(null);
  const nodesRef = useRef<PaperFlowNode[]>([]);
  const edgesRef = useRef<PaperFlowEdge[]>([]);
  const isMounted = useRef(true);
  const saveStateRef = useRef<SaveState>("idle");
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const boardGeneration = useRef(0);
  const layoutRevision = useRef(0);
  const persistedLayoutRevision = useRef(0);
  const latestSaveSequence = useRef(0);
  const latestEnqueuedLayoutRevision = useRef(0);
  const pendingSaveCount = useRef(0);
  const pendingMutations = useRef(new Set<Promise<unknown>>());
  const pendingPaperPlacements = useRef(new Map<string, NodeRectangle>());
  const pendingConnections = useRef(new Set<string>());
  const pendingFitNodeIds = useRef<readonly string[] | null>(null);
  const forceLayout = useRef<
    ReturnType<typeof createObsidianForceLayout> | null
  >(null);
  const forceLayoutNodeIds = useRef<ReadonlySet<string> | null>(null);
  const motionFrame = useRef<number | null>(null);
  const motionTick = useRef<FrameRequestCallback>(() => undefined);
  const persistAfterMotion = useRef(false);
  const domainsToSeparateAfterMotion = useRef<
    ReadonlySet<string> | null | undefined
  >(undefined);
  const dragPreviousPositions = useRef(
    new Map<string, { x: number; y: number }>(),
  );
  const dragSessionNodeIds = useRef(new Set<string>());
  const settlePinnedNodeIds = useRef(new Set<string>());
  const handledCatalogRevision = useRef<number | null>(
    paperCatalogChange?.kind === "deleted" ||
      (paperCatalogChange?.kind as string | undefined) === "organized"
      ? (paperCatalogChange?.revision ?? null)
      : null,
  );
  const scopeRef = useRef<WhiteboardScope>(resolvedScope);

  useEffect(() => {
    scopeRef.current = resolvedScope;
  }, [resolvedScope]);

  const replaceNodes = useCallback((nextNodes: PaperFlowNode[]) => {
    nodesRef.current = nextNodes;
    if (isMounted.current) setNodes(nextNodes);
  }, []);

  const replaceEdges = useCallback((nextEdges: PaperFlowEdge[]) => {
    edgesRef.current = nextEdges;
    if (isMounted.current) setEdges(nextEdges);
  }, []);

  const updateSaveState = useCallback((nextState: SaveState) => {
    saveStateRef.current = nextState;
    if (isMounted.current) setSaveState(nextState);
  }, []);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      if (motionFrame.current !== null) {
        cancelMotionFrame(motionFrame.current);
        motionFrame.current = null;
      }
      forceLayout.current = null;
      forceLayoutNodeIds.current = null;
    };
  }, []);

  useEffect(() => {
    const kind = paperCatalogChange?.kind as string | undefined;
    if (
      (kind !== "deleted" && kind !== "organized") ||
      paperCatalogChange?.revision === handledCatalogRevision.current
    ) {
      return;
    }
    handledCatalogRevision.current = paperCatalogChange?.revision ?? null;
    setLoadAttempt((attempt) => attempt + 1);
  }, [paperCatalogChange?.kind, paperCatalogChange?.revision]);

  useEffect(() => {
    if (domains !== undefined) return;
    let active = true;
    void domainRepository.list().then(
      (nextDomains) => {
        if (active && isMounted.current) setRepositoryDomains(nextDomains);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [domainRepository, domains, loadAttempt]);

  const enqueuePositionSnapshot = useCallback(
    (updates: NodePositionUpdate[], snapshotRevision: number) => {
      const snapshot = updates.map((update) => ({ ...update }));
      const generation = boardGeneration.current;
      const sequence = latestSaveSequence.current + 1;
      latestSaveSequence.current = sequence;
      latestEnqueuedLayoutRevision.current = snapshotRevision;
      pendingSaveCount.current += 1;
      updateSaveState("idle");

      const operation = saveQueue.current.then(async () => {
        try {
          await repository.saveNodePositions(snapshot);
          if (generation !== boardGeneration.current) return;
          persistedLayoutRevision.current = Math.max(
            persistedLayoutRevision.current,
            snapshotRevision,
          );
          if (sequence === latestSaveSequence.current) updateSaveState("idle");
        } catch (error) {
          if (
            generation === boardGeneration.current &&
            sequence === latestSaveSequence.current
          ) {
            updateSaveState("error");
          }
          throw error;
        } finally {
          pendingSaveCount.current -= 1;
        }
      });

      saveQueue.current = operation.catch(() => undefined);
      return operation;
    },
    [repository, updateSaveState],
  );

  useEffect(() => {
    let isActive = true;
    void repository.loadBoard().then(
      (board) => {
        if (!isActive || !isMounted.current) return;
        if (motionFrame.current !== null) {
          cancelMotionFrame(motionFrame.current);
          motionFrame.current = null;
        }
        forceLayout.current = null;
        forceLayoutNodeIds.current = null;
        pendingPaperPlacements.current.clear();
        persistAfterMotion.current = false;
        domainsToSeparateAfterMotion.current = undefined;
        boardGeneration.current += 1;
        const sourceNodes = board.nodes.map(toFlowNode);
        const loadedEdges = board.edges.map(toFlowEdge);
        const loadedNodes = separateDomainGroups(
          sourceNodes,
          48,
          64,
          undefined,
          loadedEdges,
        );
        const layoutChanged = loadedNodes.some((node, index) => {
          const previous = sourceNodes[index].position;
          return (
            node.position.x !== previous.x || node.position.y !== previous.y
          );
        });
        replaceNodes(loadedNodes);
        replaceEdges(loadedEdges);
        layoutRevision.current = Number(layoutChanged);
        persistedLayoutRevision.current = 0;
        latestEnqueuedLayoutRevision.current = 0;
        dragPreviousPositions.current.clear();
        dragSessionNodeIds.current.clear();
        settlePinnedNodeIds.current.clear();
        setConnectionSourceId(null);
        setSelectedEdgeId(null);
        updateSaveState("idle");
        setLoadState("ready");
        if (layoutChanged) {
          void enqueuePositionSnapshot(
            toPositionUpdates(loadedNodes),
            layoutRevision.current,
          ).catch(() => undefined);
        }
      },
      () => {
        if (isActive && isMounted.current) setLoadState("error");
      },
    );
    return () => {
      isActive = false;
    };
  }, [
    enqueuePositionSnapshot,
    loadAttempt,
    replaceEdges,
    replaceNodes,
    repository,
    updateSaveState,
  ]);

  const ensureMotionFrame = useCallback(() => {
    if (motionFrame.current !== null || forceLayout.current === null) return;
    motionFrame.current = requestMotionFrame((time) => motionTick.current(time));
  }, []);

  const advanceMotion = useCallback(
    () => {
      motionFrame.current = null;
      const layout = forceLayout.current;
      if (!layout) return;
      if (requestsReducedMotion() && dragSessionNodeIds.current.size === 0) {
        layout.settle();
      } else {
        layout.tick();
      }
      const pinnedNodeIds = new Set([
        ...dragSessionNodeIds.current,
        ...settlePinnedNodeIds.current,
      ]);
      const settled =
        layout.isSettled() && dragSessionNodeIds.current.size === 0;
      let nextNodes = mergeLayoutPositions(
        nodesRef.current,
        forceLayoutNodeIds.current ?? new Set(),
        layout.positions(),
        pinnedNodeIds,
      );
      const domainScope = domainsToSeparateAfterMotion.current;
      if (settled && domainScope !== undefined) {
        nextNodes = separateDomainGroups(
          nextNodes,
          48,
          64,
          domainScope ?? undefined,
          edgesRef.current,
        );
        domainsToSeparateAfterMotion.current = undefined;
      }
      layout.sync(nextNodes);
      const changed = nextNodes.some((node, index) => {
        const previous = nodesRef.current[index].position;
        return node.position.x !== previous.x || node.position.y !== previous.y;
      });

      if (changed) {
        replaceNodes(nextNodes);
        layoutRevision.current += 1;
      }

      if (!settled) {
        ensureMotionFrame();
        return;
      }
      forceLayout.current = null;
      forceLayoutNodeIds.current = null;
      settlePinnedNodeIds.current.clear();
      if (persistAfterMotion.current) {
        persistAfterMotion.current = false;
        void enqueuePositionSnapshot(
          toPositionUpdates(nodesRef.current),
          layoutRevision.current,
        ).catch(() => undefined);
      }
    },
    [enqueuePositionSnapshot, ensureMotionFrame, replaceNodes],
  );
  useEffect(() => {
    motionTick.current = advanceMotion;
  }, [advanceMotion]);

  const finishForceLayout = useCallback(() => {
    if (motionFrame.current !== null) {
      cancelMotionFrame(motionFrame.current);
      motionFrame.current = null;
    }
    const layout = forceLayout.current;
    if (!layout) return false;
    layout.cool();
    layout.settle();
    forceLayout.current = null;
    const layoutNodeIds = forceLayoutNodeIds.current ?? new Set<string>();
    forceLayoutNodeIds.current = null;
    persistAfterMotion.current = false;
    const pinnedNodeIds = new Set([
      ...dragSessionNodeIds.current,
      ...settlePinnedNodeIds.current,
    ]);
    let nextNodes = mergeLayoutPositions(
      nodesRef.current,
      layoutNodeIds,
      layout.positions(),
      pinnedNodeIds,
    );
    const domainScope = domainsToSeparateAfterMotion.current;
    if (domainScope !== undefined) {
      nextNodes = separateDomainGroups(
        nextNodes,
        48,
        64,
        domainScope ?? undefined,
        edgesRef.current,
      );
      domainsToSeparateAfterMotion.current = undefined;
    }
    settlePinnedNodeIds.current.clear();
    const changed = nextNodes.some((node, index) => {
      const previous = nodesRef.current[index].position;
      return node.position.x !== previous.x || node.position.y !== previous.y;
    });
    if (changed) {
      replaceNodes(nextNodes);
      layoutRevision.current += 1;
    }
    return changed;
  }, [replaceNodes]);

  const cancelForceLayout = useCallback(() => {
    if (motionFrame.current !== null) {
      cancelMotionFrame(motionFrame.current);
      motionFrame.current = null;
    }
    const hadLayout = forceLayout.current !== null;
    forceLayout.current = null;
    forceLayoutNodeIds.current = null;
    persistAfterMotion.current = false;
    domainsToSeparateAfterMotion.current = undefined;
    settlePinnedNodeIds.current.clear();
    return hadLayout;
  }, []);

  const drainPositionQueue = useCallback(async () => {
    let observed: Promise<void>;
    do {
      observed = saveQueue.current;
      await observed;
    } while (observed !== saveQueue.current);
  }, []);

  const trackMutation = useCallback(<T,>(operation: Promise<T>): Promise<T> => {
    const tracked = operation.finally(() => {
      pendingMutations.current.delete(tracked);
    });
    pendingMutations.current.add(tracked);
    return tracked;
  }, []);

  const drainMutations = useCallback(async () => {
    while (pendingMutations.current.size > 0) {
      await Promise.all([...pendingMutations.current]);
    }
  }, []);

  const flush = useCallback(async () => {
    while (true) {
      finishForceLayout();
      await drainMutations();
      if (forceLayout.current !== null) continue;

      const requestedRevision = layoutRevision.current;
      const needsSnapshot =
        saveStateRef.current === "error" ||
        latestEnqueuedLayoutRevision.current !== requestedRevision ||
        persistedLayoutRevision.current !== requestedRevision;
      if (needsSnapshot) {
        void enqueuePositionSnapshot(
          toPositionUpdates(nodesRef.current),
          requestedRevision,
        ).catch(() => undefined);
      }

      await drainPositionQueue();
      await drainMutations();
      if (
        forceLayout.current !== null ||
        pendingMutations.current.size > 0 ||
        layoutRevision.current !== requestedRevision
      ) {
        continue;
      }
      if (
        persistedLayoutRevision.current !== requestedRevision ||
        saveStateRef.current !== "idle"
      ) {
        throw new Error("The latest canvas layout is not durable.");
      }
      return;
    }
  }, [
    drainMutations,
    drainPositionQueue,
    enqueuePositionSnapshot,
    finishForceLayout,
  ]);

  const writer = useMemo(
    () => ({
      isDirty: () =>
        pendingMutations.current.size > 0 ||
        pendingSaveCount.current > 0 ||
        forceLayout.current !== null ||
        persistAfterMotion.current ||
        layoutRevision.current !== persistedLayoutRevision.current ||
        saveStateRef.current === "error",
      flush,
    }),
    [flush],
  );
  usePersistenceWriter("whiteboard", writer);

  const onNodesChange = useCallback(
    (changes: NodeChange<PaperFlowNode>[]) => {
      const previousNodes = nodesRef.current;
      const nextNodes = applyNodeChanges(changes, previousNodes);
      replaceNodes(nextNodes);
      const previousPositions = new Map(
        previousNodes.map((node) => [node.id, node.position]),
      );
      const changedPositionIds = new Set(
        nextNodes
          .filter((node) => {
            const previous = previousPositions.get(node.id);
            return (
              previous !== undefined &&
              (previous.x !== node.position.x || previous.y !== node.position.y)
            );
          })
          .map((node) => node.id),
      );
      if (changedPositionIds.size === 0) return;

      layoutRevision.current += 1;
      const shouldPersist = changes.some(
        (change) =>
          change.type === "position" &&
          change.position !== undefined &&
          changedPositionIds.has(change.id) &&
          change.dragging !== true &&
          !dragSessionNodeIds.current.has(change.id),
      );
      if (shouldPersist) {
        void enqueuePositionSnapshot(
          toPositionUpdates(nextNodes),
          layoutRevision.current,
        ).catch(() => undefined);
      }
    },
    [enqueuePositionSnapshot, replaceNodes],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<PaperFlowEdge>[]) => {
      const nextEdges = applyEdgeChanges(changes, edgesRef.current);
      replaceEdges(nextEdges);
      setSelectedEdgeId(
        nextEdges.find(({ selected }) => selected)?.id ?? null,
      );
    },
    [replaceEdges],
  );

  const retrySave = useCallback(() => {
    void enqueuePositionSnapshot(
      toPositionUpdates(nodesRef.current),
      layoutRevision.current,
    ).catch(() => undefined);
  }, [enqueuePositionSnapshot]);

  const organizeConnections = useCallback(
    (
      connectionEdges: readonly PaperFlowEdge[] = edgesRef.current,
      seedNodeIds?: Iterable<string>,
    ) => {
      const activeScope = scopeRef.current;
      const layoutNodes = nodesRef.current.filter((node) =>
        nodeBelongsToScope(node, activeScope),
      );
      if (layoutNodes.length === 0) return null;
      const layoutNodeIds = new Set(layoutNodes.map(({ id }) => id));
      const layoutEdges = connectionEdges.filter(
        ({ source, target }) =>
          layoutNodeIds.has(source) && layoutNodeIds.has(target),
      );
      const activeSeeds = seedNodeIds
        ? [...seedNodeIds].filter((id) => layoutNodeIds.has(id))
        : undefined;
      if (activeSeeds && activeSeeds.length === 0) return null;
      if (motionFrame.current !== null) {
        cancelMotionFrame(motionFrame.current);
        motionFrame.current = null;
      }
      const movableNodeIds = activeSeeds
        ? localLayoutNodeIds(activeSeeds, layoutEdges)
        : undefined;
      const layout = createObsidianForceLayout(
        layoutNodes,
        layoutEdges,
        movableNodeIds ? { movableNodeIds } : undefined,
      );
      forceLayout.current = layout;
      forceLayoutNodeIds.current = layoutNodeIds;
      domainsToSeparateAfterMotion.current =
        activeScope.kind === "all"
          ? movableNodeIds
            ? new Set(
                layoutNodes.flatMap((node) =>
                  movableNodeIds.has(node.id) && node.data.paper.domainId
                    ? [node.data.paper.domainId]
                    : [],
                ),
              )
            : null
          : undefined;
      const pinnedNodeIds = new Set([
        ...dragSessionNodeIds.current,
        ...settlePinnedNodeIds.current,
      ]);
      for (const nodeId of pinnedNodeIds) {
        const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
        if (node) layout.pin(nodeId, node.position);
      }
      if (dragSessionNodeIds.current.size > 0) {
        layout.reheat();
      }
      persistAfterMotion.current = dragSessionNodeIds.current.size === 0;
      ensureMotionFrame();
      return layout;
    },
    [ensureMotionFrame],
  );
  const placePaper = useCallback(
    (paperId: string, clientX: number, clientY: number) => {
      if (!paperId) return;
      if (
        pendingPaperPlacements.current.has(paperId) ||
        nodesRef.current.some((node) => node.data.paper.id === paperId)
      ) {
        return;
      }

      const projectedPosition = screenToFlowPosition({ x: clientX, y: clientY });
      if (
        !Number.isFinite(projectedPosition.x) ||
        !Number.isFinite(projectedPosition.y)
      ) {
        return;
      }
      const position = findCollisionFreePosition(
        {
          id: `pending:${paperId}`,
          position: projectedPosition,
          size: DEFAULT_NODE_SIZE,
        },
        [
          ...nodesRef.current.map(toNodeRectangle),
          ...pendingPaperPlacements.current.values(),
        ],
      );
      pendingPaperPlacements.current.set(paperId, {
        id: `pending:${paperId}`,
        position: { ...position },
        size: { ...DEFAULT_NODE_SIZE },
      });
      setActionError(null);
      const operation = trackMutation(repository.createPaperNode(paperId, position));
      void operation.then(
        (record) => {
          pendingPaperPlacements.current.delete(paperId);
          replaceNodes([...nodesRef.current, toFlowNode(record)]);
        },
        () => {
          if (isMounted.current) setActionError("paper");
        },
      ).finally(() => pendingPaperPlacements.current.delete(paperId));
    },
    [replaceNodes, repository, screenToFlowPosition, trackMutation],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      placePaper(
        event.dataTransfer.getData(PAPER_DRAG_MIME).trim(),
        event.clientX,
        event.clientY,
      );
    },
    [placePaper],
  );

  useEffect(() => {
    if (!paperDropIntent || loadState !== "ready") return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const bounds = canvasRef.current?.getBoundingClientRect();
      const isInsideCanvas =
        bounds !== undefined &&
        paperDropIntent.clientX >= bounds.left &&
        paperDropIntent.clientX <= bounds.right &&
        paperDropIntent.clientY >= bounds.top &&
        paperDropIntent.clientY <= bounds.bottom;
      if (isInsideCanvas) {
        placePaper(
          paperDropIntent.paperId,
          paperDropIntent.clientX,
          paperDropIntent.clientY,
        );
      }
      onPaperDropComplete?.();
    });
    return () => {
      active = false;
    };
  }, [loadState, onPaperDropComplete, paperDropIntent, placePaper]);

  const createConnection = useCallback(
    (connection: { source: string | null; target: string | null }) => {
      const { source, target } = connection;
      if (!source || !target || source === target) return;
      const key = connectionKey(source, target);
      const alreadyExists = edgesRef.current.some(
        (edge) =>
          (edge.source === source && edge.target === target) ||
          (edge.source === target && edge.target === source),
      );
      if (alreadyExists || pendingConnections.current.has(key)) return;

      pendingConnections.current.add(key);
      setActionError(null);
      const operation = trackMutation(repository.createEdge(source, target));
      void operation.then(
        (record) => {
          const nextEdges = [...edgesRef.current, toFlowEdge(record)];
          replaceEdges(nextEdges);
          organizeConnections(nextEdges, [source, target]);
        },
        () => {
          if (isMounted.current) setActionError("connection");
        },
      ).finally(() => pendingConnections.current.delete(key));
    },
    [organizeConnections, replaceEdges, repository, trackMutation],
  );

  const organizeScope = useCallback(
    (nextScope: WhiteboardScope) => {
      const canceledLayout = cancelForceLayout();
      let nextNodes = nodesRef.current;
      let scopeLayoutChanged = false;
      if (nextScope.kind === "domain") {
        const scopeNodes = nextNodes.filter((node) =>
          nodeBelongsToScope(node, nextScope),
        );
        if (scopeNodes.length > 1) {
          const scopeNodeIds = new Set(scopeNodes.map(({ id }) => id));
          const scopeEdges = edgesRef.current.filter(
            ({ source, target }) =>
              scopeNodeIds.has(source) && scopeNodeIds.has(target),
          );
          const layout = createObsidianForceLayout(scopeNodes, scopeEdges);
          // ponytail: synchronous settle; switch to frame-driven scope layout if large domains make tab changes jank.
          layout.settle();
          const positions = layout.positions();
          const arrangedNodes = resolveNodeOverlaps(
            scopeNodes.map((node) => ({
              ...node,
              position: positions.get(node.id) ?? node.position,
            })),
          );
          const arrangedById = new Map(
            arrangedNodes.map((node) => [node.id, node] as const),
          );
          nextNodes = nextNodes.map((node) => arrangedById.get(node.id) ?? node);
          scopeLayoutChanged = nextNodes.some((node, index) => {
            const previous = nodesRef.current[index].position;
            return (
              node.position.x !== previous.x || node.position.y !== previous.y
            );
          });
          if (scopeLayoutChanged) {
            replaceNodes(nextNodes);
            layoutRevision.current += 1;
          }
        }
      }
      if (canceledLayout || scopeLayoutChanged) {
        void enqueuePositionSnapshot(
          toPositionUpdates(nextNodes),
          layoutRevision.current,
        ).catch(() => undefined);
      }
      return nextNodes
        .filter((node) => nodeBelongsToScope(node, nextScope))
        .map(({ id }) => id);
    },
    [cancelForceLayout, enqueuePositionSnapshot, replaceNodes],
  );

  const updateSelectedEdgeRelation = useCallback(
    (relation: BoardEdgeRelation) => {
      if (selectedEdgeId === null || relationUpdatePending) return;
      const edgeId = selectedEdgeId;
      setRelationUpdatePending(true);
      setActionError(null);
      const operation = trackMutation(repository.updateEdgeRelation(edgeId, relation));
      void operation
        .then(
          () => {
            replaceEdges(
              edgesRef.current.map((edge) =>
                edge.id === edgeId ? withEdgeRelation(edge, relation) : edge,
              ),
            );
          },
          () => {
            if (isMounted.current) setActionError("connection");
          },
        )
        .finally(() => {
          if (isMounted.current) setRelationUpdatePending(false);
        });
    },
    [
      relationUpdatePending,
      replaceEdges,
      repository,
      selectedEdgeId,
      trackMutation,
    ],
  );

  const exitConnectionMode = useCallback(() => {
    setConnectionMode(false);
    setConnectionSourceId(null);
  }, []);

  const toggleConnectionMode = useCallback(() => {
    if (connectionMode) {
      exitConnectionMode();
      return;
    }
    setConnectionMode(true);
    setConnectionSourceId(null);
  }, [connectionMode, exitConnectionMode]);

  const selectScope = useCallback(
    (nextScope: WhiteboardScope) => {
      pendingFitNodeIds.current = organizeScope(nextScope);
      setFitRevision((revision) => revision + 1);
      setScope(nextScope);
      setConnectionSourceId(null);
      setSelectedEdgeId(null);
    },
    [organizeScope],
  );

  useEffect(() => {
    if (active === false) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && connectionMode) {
        event.preventDefault();
        exitConnectionMode();
        return;
      }
      if (isEditableTarget(event.target)) return;
      if (event.key !== " " || event.repeat) return;
      event.preventDefault();
      setConnectionMode(true);
      setConnectionSourceId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, connectionMode, exitConnectionMode]);

  const selectConnectionNode = useCallback(
    (nodeId: string) => {
      if (!connectionMode) return;
      if (connectionSourceId === null) {
        setConnectionSourceId(nodeId);
        return;
      }
      if (connectionSourceId === nodeId) return;
      createConnection({ source: connectionSourceId, target: nodeId });
      setConnectionSourceId(null);
    },
    [connectionMode, connectionSourceId, createConnection],
  );

  const onNodeClick = useCallback(
    (_event: MouseEvent, node: PaperFlowNode) => {
      selectConnectionNode(node.id);
    },
    [selectConnectionNode],
  );

  const onEdgeClick = useCallback(
    (_event: MouseEvent, edge: PaperFlowEdge) => {
      setSelectedEdgeId(edge.id);
    },
    [],
  );

  const onKeyboardConnectionSelect = useCallback(
    (nodeId: string) => {
      if (nodesRef.current.some((candidate) => candidate.id === nodeId)) {
        selectConnectionNode(nodeId);
      }
    },
    [selectConnectionNode],
  );

  const onNodeDragStart: OnNodeDrag<PaperFlowNode> = useCallback(
    (_event, activeNode, draggedNodes) => {
      const sessionNodes = new Map(
        draggedNodes.map((node) => [node.id, node] as const),
      );
      sessionNodes.set(activeNode.id, activeNode);
      dragPreviousPositions.current.clear();
      settlePinnedNodeIds.current.clear();
      for (const node of sessionNodes.values()) {
        dragPreviousPositions.current.set(node.id, { ...node.position });
      }
      dragSessionNodeIds.current = new Set(sessionNodes.keys());
      const layout = organizeConnections(
        edgesRef.current,
        dragSessionNodeIds.current,
      );
      if (!layout) return;
      for (const node of sessionNodes.values()) {
        layout.pin(node.id, node.position);
      }
      layout.reheat();
      persistAfterMotion.current = false;
      ensureMotionFrame();
    },
    [ensureMotionFrame, organizeConnections],
  );

  const onNodeDrag: OnNodeDrag<PaperFlowNode> = useCallback(
    (_event, activeNode, draggedNodes) => {
      const currentDraggedNodes = new Map(
        draggedNodes.map((node) => [node.id, node] as const),
      );
      currentDraggedNodes.set(activeNode.id, activeNode);
      for (const nodeId of currentDraggedNodes.keys()) {
        dragSessionNodeIds.current.add(nodeId);
      }
      const layout =
        forceLayout.current ??
        organizeConnections(edgesRef.current, dragSessionNodeIds.current);
      if (!layout) return;
      const previousPositions = new Map<string, { x: number; y: number }>();
      for (const node of currentDraggedNodes.values()) {
        previousPositions.set(
          node.id,
          dragPreviousPositions.current.get(node.id) ?? node.position,
        );
      }
      const scopeNodes = nodesRef.current.filter((node) =>
        nodeBelongsToScope(node, scopeRef.current),
      );
      const collisionSafeScopeNodes = pushNodeGroupDuringDrag(
        [...currentDraggedNodes.values()],
        previousPositions,
        scopeNodes,
      );
      const collisionSafeById = new Map(
        collisionSafeScopeNodes.map((node) => [node.id, node] as const),
      );
      const collisionSafeNodes = nodesRef.current.map(
        (node) => collisionSafeById.get(node.id) ?? node,
      );
      let collisionChanged = false;
      const movedDomainIds = new Set<string>();
      collisionSafeNodes.forEach((node, index) => {
        const previous = nodesRef.current[index].position;
        if (
          node.position.x !== previous.x ||
          node.position.y !== previous.y
        ) {
          collisionChanged = true;
          if (node.data.paper.domainId) {
            movedDomainIds.add(node.data.paper.domainId);
          }
        }
      });
      const domainScope = domainsToSeparateAfterMotion.current;
      if (domainScope && movedDomainIds.size > 0) {
        domainsToSeparateAfterMotion.current = new Set([
          ...domainScope,
          ...movedDomainIds,
        ]);
      }
      if (collisionChanged) {
        replaceNodes(collisionSafeNodes);
        layoutRevision.current += 1;
      }
      layout.sync(collisionSafeNodes);
      for (const node of currentDraggedNodes.values()) {
        layout.pin(node.id, node.position);
        dragPreviousPositions.current.set(node.id, { ...node.position });
      }
      ensureMotionFrame();
    },
    [ensureMotionFrame, organizeConnections, replaceNodes],
  );

  const onNodeDragStop: OnNodeDrag<PaperFlowNode> = useCallback(
    (_event, activeNode, draggedNodes) => {
      const releasedNodes = new Map(
        draggedNodes.map((node) => [node.id, node] as const),
      );
      releasedNodes.set(activeNode.id, activeNode);
      const layout = forceLayout.current;
      if (!layout) return;
      settlePinnedNodeIds.current = new Set(releasedNodes.keys());
      for (const node of releasedNodes.values()) {
        layout.pin(node.id, node.position);
      }
      layout.cool();
      dragPreviousPositions.current.clear();
      dragSessionNodeIds.current.clear();
      persistAfterMotion.current = true;
      ensureMotionFrame();
    },
    [ensureMotionFrame],
  );

  const onBeforeDelete = useCallback<
    OnBeforeDelete<PaperFlowNode, PaperFlowEdge>
  >(
    async ({ nodes: nodesToDelete, edges: edgesToDelete }) => {
      if (nodesToDelete.length > 0) return false;
      if (edgesToDelete.length === 0) return false;
      setActionError(null);
      try {
        await trackMutation(
          repository.deleteEdges(edgesToDelete.map(({ id }) => id)),
        );
        return true;
      } catch {
        if (isMounted.current) setActionError("connection");
        return false;
      }
    },
    [repository, trackMutation],
  );

  const visibleNodes = useMemo(() => {
    return nodes
      .filter((node) => nodeBelongsToScope(node, resolvedScope))
      .map((node) => ({
        ...node,
        className: [
          node.className,
          connectionSourceId === node.id ? "is-connection-source" : "",
        ]
          .filter(Boolean)
          .join(" "),
        data: {
          ...node.data,
          onKeyboardConnectionSelect: connectionMode
            ? onKeyboardConnectionSelect
            : undefined,
        },
      }));
  }, [connectionMode, connectionSourceId, nodes, onKeyboardConnectionSelect, resolvedScope]);
  const visibleNodeIds = useMemo(
    () => new Set(visibleNodes.map(({ id }) => id)),
    [visibleNodes],
  );
  const visibleEdges = useMemo(
    () =>
      edges.filter(
        (edge) =>
          visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
      ),
    [edges, visibleNodeIds],
  );
  const selectedEdge = useMemo(
    () => visibleEdges.find(({ id }) => id === selectedEdgeId) ?? null,
    [selectedEdgeId, visibleEdges],
  );
  const domainFrames = useMemo(
    () =>
      resolvedScope.kind === "all"
        ? computeDomainFrames(nodes, availableDomains)
        : [],
    [availableDomains, nodes, resolvedScope.kind],
  );

  useEffect(() => {
    if (pendingFitNodeIds.current === null) return;
    const requestedIds = new Set(pendingFitNodeIds.current);
    pendingFitNodeIds.current = null;
    const requestedNodes = nodes.filter(({ id }) => requestedIds.has(id));
    if (requestedNodes.length === 0) return;
    void fitView({
      nodes: requestedNodes,
      padding: 0.22,
      maxZoom: 1.1,
      duration: 300,
    });
  }, [fitRevision, fitView, nodes]);

  if (loadState === "loading") {
    return (
      <section className="canvas-message" role="status">
        <div className="canvas-message__pulse" aria-hidden="true" />
        <p>Opening canvas…</p>
      </section>
    );
  }
  if (loadState === "error") {
    return (
      <section className="canvas-message" role="alert">
        <div className="canvas-message__mark">!</div>
        <h2>Could not open your canvas</h2>
        <p>The local database did not respond.</p>
        <button
          type="button"
          onClick={() => {
            setLoadState("loading");
            setLoadAttempt((attempt) => attempt + 1);
          }}
        >
          Try again
        </button>
      </section>
    );
  }

  return (
    <section className="whiteboard" aria-label="Paper canvas" ref={canvasRef}>
      <div className="whiteboard__views" role="toolbar" aria-label="白板视图">
        <button
          type="button"
          aria-pressed={resolvedScope.kind === "all"}
          onClick={() => selectScope(ALL_SCOPE)}
        >
          All
        </button>
        {availableDomains.map((domain) => (
          <button
            key={domain.id}
            type="button"
            aria-pressed={
              resolvedScope.kind === "domain" &&
              resolvedScope.domainId === domain.id
            }
            onClick={() =>
              selectScope({ kind: "domain", domainId: domain.id })
            }
          >
            {domain.name}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={
            resolvedScope.kind === "domain" && resolvedScope.domainId === null
          }
          onClick={() => selectScope({ kind: "domain", domainId: null })}
        >
          未分区
        </button>
        <button
          aria-label="连线模式"
          aria-pressed={connectionMode}
          onClick={toggleConnectionMode}
          type="button"
        >
          连线
        </button>
        <button
          disabled={visibleNodes.length < 2}
          onClick={() => organizeConnections()}
          type="button"
        >
          重新整理布局
        </button>
        {selectedEdge && (
          <div className="whiteboard__edge-relations" role="group" aria-label="连线关系">
            {(
              [
                [null, "未分类"],
                ["support", "Support"],
                ["challenge", "Challenge"],
              ] as const
            ).map(([relation, label]) => (
              <button
                key={label}
                type="button"
                className={relation ? `is-${relation}` : undefined}
                aria-pressed={(selectedEdge.data?.relation ?? null) === relation}
                disabled={relationUpdatePending}
                onClick={() => updateSelectedEdgeRelation(relation)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {connectionMode && (
        <div className="whiteboard__connection-status" role="status">
          {connectionSourceId === null
            ? "连线模式：请选择第一个节点"
            : "连线模式：请选择第二个节点"}
          <span>Esc 退出</span>
        </div>
      )}

        <ReactFlow<PaperFlowNode, PaperFlowEdge>
          nodes={visibleNodes}
          edges={visibleEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onBeforeDelete={onBeforeDelete}
          onDrop={onDrop}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onNodeDoubleClick={(_event, node) => {
            if (!connectionMode) onOpenPaper?.(node.data.paper);
          }}
          nodesConnectable={false}
          nodesDraggable={!connectionMode}
          connectOnClick={false}
          panActivationKeyCode={null}
          panOnScroll
          panOnScrollMode={PanOnScrollMode.Free}
          panOnScrollSpeed={1}
          zoomOnPinch
          zoomOnScroll={false}
          deleteKeyCode={["Backspace", "Delete"]}
          fitView
          fitViewOptions={{ padding: 0.22, maxZoom: 1.1 }}
          minZoom={0.2}
          maxZoom={2}
        >
          <ViewportPortal>
            {domainFrames.map((frame) => (
              <div
                key={frame.domainId}
                className="whiteboard__domain-frame"
                data-testid={`domain-frame-${frame.domainId}`}
                style={{
                  height: frame.height,
                  transform: `translate(${frame.x}px, ${frame.y}px)`,
                  width: frame.width,
                }}
              >
                <span>{frame.name}</span>
              </div>
            ))}
          </ViewportPortal>
          <Background color="#d6d5d0" gap={24} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>

      {saveState === "error" && (
        <div className="save-error" role="alert">
          <span>Could not save the canvas. Your latest layout is still here.</span>
          <button type="button" onClick={retrySave}>
            Retry save
          </button>
        </div>
      )}
      {saveState === "idle" && actionError && (
        <div className="save-error" role="alert">
          {actionError === "paper"
            ? "The paper card was not added. Try dropping it again."
            : "The paper connection was not saved. Try again."}
        </div>
      )}
    </section>
  );
}

export function Whiteboard({
  active = true,
  domains,
  domainRepository = sqlitePaperDomainRepository,
  paperCatalogChange = null,
  repository = boardRepository,
  onOpenPaper,
  onPaperDropComplete,
  paperDropIntent,
}: WhiteboardProps) {
  return (
    <ReactFlowProvider>
      <WhiteboardCanvas
        active={active}
        domainRepository={domainRepository}
        domains={domains}
        paperCatalogChange={paperCatalogChange}
        repository={repository}
        onOpenPaper={onOpenPaper}
        onPaperDropComplete={onPaperDropComplete}
        paperDropIntent={paperDropIntent}
      />
    </ReactFlowProvider>
  );
}
