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
import { PaperEdge } from "./PaperEdge";
import type { BoardRepository } from "./data/boardRepository";
import {
  boardRepository,
  DEFAULT_NODE_SIZE,
} from "./data/sqliteBoardRepository";
import {
  connectionKey,
  toFlowEdge,
  withEdgeRelation,
  type BoardEdgeAnnotations,
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
  toNodeRectangle,
  type NodeRectangle,
} from "./model/nodeCollision";
import {
  computeDomainFrames,
  withDomainRegions,
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
const edgeTypes = { paper: PaperEdge };

export interface WhiteboardProps {
  active?: boolean;
  domains?: readonly WhiteboardDomain[];
  domainRepository?: Pick<PaperDomainRepository, "list">;
  paperCatalogChange?: PaperCatalogChange | null;
  repository?: BoardRepository;
  onOpenPaper?: (paper: Paper) => void;
  onPaperDropComplete?: () => void;
  paperDropIntent?: PaperDropIntent | null;
  paperFocusRequest?: { paperId: string; revision: number } | null;
}

export type WhiteboardScope =
  | { kind: "all" }
  | { kind: "domain"; domainId: string | null };

type LoadState = "loading" | "ready" | "error";
type SaveState = "idle" | "error";
type ActionError = "paper" | "connection" | "deletion" | null;

const ALL_SCOPE: WhiteboardScope = { kind: "all" };

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    target.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']",
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
) {
  return nodes.map((node) => {
    const position = layoutNodeIds.has(node.id) ? positions.get(node.id) : undefined;
    return position ? { ...node, position } : node;
  });
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
  paperFocusRequest,
}: Required<Pick<WhiteboardProps, "repository" | "domainRepository">> &
  Pick<
    WhiteboardProps,
    | "onOpenPaper"
    | "onPaperDropComplete"
    | "paperCatalogChange"
    | "paperDropIntent"
    | "paperFocusRequest"
    | "domains"
    | "active"
  >) {
  const { deleteElements, fitView, setCenter, screenToFlowPosition } = useReactFlow<PaperFlowNode, PaperFlowEdge>();
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
  const [deletionPending, setDeletionPending] = useState(false);
  const deletionPendingRef = useRef(false);
  const [annotationDrafts, setAnnotationDrafts] = useState(new Map<string, BoardEdgeAnnotations>());
  const annotationDraftsRef = useRef(annotationDrafts);
  const annotationSave = useRef<Promise<void> | null>(null);
  const [annotationSaveState, setAnnotationSaveState] = useState<"idle" | "saving" | "error">("idle");
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
  const handledFocusRevision = useRef<number | null>(null);
  const forceLayout = useRef<
    ReturnType<typeof createObsidianForceLayout> | null
  >(null);
  const forceLayoutNodeIds = useRef<ReadonlySet<string> | null>(null);
  const motionFrame = useRef<number | null>(null);
  const motionTick = useRef<FrameRequestCallback>(() => undefined);
  const persistAfterMotion = useRef(false);
  const dragSessionNodeIds = useRef(new Set<string>());
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
        boardGeneration.current += 1;
        const sourceNodes = board.nodes.map(toFlowNode);
        const loadedNodes = withDomainRegions(sourceNodes);
        const layoutChanged = loadedNodes.some((node, index) =>
          node.position.x !== sourceNodes[index].position.x || node.position.y !== sourceNodes[index].position.y);

        const loadedEdges = board.edges.map(toFlowEdge);
        replaceNodes(loadedNodes);
        replaceEdges(loadedEdges);
        layoutRevision.current = Number(layoutChanged);
        persistedLayoutRevision.current = 0;
        latestEnqueuedLayoutRevision.current = 0;
        dragSessionNodeIds.current.clear();
        setConnectionSourceId(null);
        setSelectedEdgeId(null);
        updateSaveState("idle");
        setLoadState("ready");
        if (layoutChanged) {
          void enqueuePositionSnapshot(toPositionUpdates(loadedNodes), layoutRevision.current).catch(() => undefined);
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
      const settled =
        layout.isSettled() && dragSessionNodeIds.current.size === 0;
      const nextNodes = mergeLayoutPositions(
        nodesRef.current,
        forceLayoutNodeIds.current ?? new Set(),
        layout.positions(),
      );
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
    const nextNodes = mergeLayoutPositions(
      nodesRef.current,
      layoutNodeIds,
      layout.positions(),
    );
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

  const flushAnnotations = useCallback(() => {
    if (annotationSave.current) return annotationSave.current;
    if (annotationDraftsRef.current.size === 0) return Promise.resolve();
    setAnnotationSaveState("saving");
    const operation = (async () => {
      while (annotationDraftsRef.current.size > 0) {
        const [edgeId, draft] = annotationDraftsRef.current.entries().next().value!;
        await repository.updateEdgeAnnotations(edgeId, draft);
        replaceEdges(edgesRef.current.map((edge) => edge.id === edgeId
          ? { ...edge, data: { relation: null, ...edge.data, ...draft } } : edge));
        if (annotationDraftsRef.current.get(edgeId) === draft) {
          const next = new Map(annotationDraftsRef.current);
          next.delete(edgeId);
          annotationDraftsRef.current = next;
          if (isMounted.current) setAnnotationDrafts(next);
        }
      }
    })();
    annotationSave.current = operation;
    void operation.then(
      () => { if (isMounted.current) setAnnotationSaveState("idle"); },
      () => { if (isMounted.current) setAnnotationSaveState("error"); },
    ).finally(() => { annotationSave.current = null; });
    return operation;
  }, [replaceEdges, repository]);

  const editAnnotations = useCallback((edge: PaperFlowEdge, field: keyof BoardEdgeAnnotations, value: string) => {
    const next = new Map(annotationDraftsRef.current);
    next.set(edge.id, {
      explanation: edge.data?.explanation ?? "",
      evidence: edge.data?.evidence ?? "",
      ...next.get(edge.id),
      [field]: value,
    });
    annotationDraftsRef.current = next;
    setAnnotationDrafts(next);
  }, []);

  const flush = useCallback(async () => {
    while (true) {
      finishForceLayout();
      await flushAnnotations();
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
        annotationDraftsRef.current.size > 0 ||
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
    flushAnnotations,
  ]);

  const writer = useMemo(
    () => ({
      isDirty: () =>
        annotationDraftsRef.current.size > 0 ||
        annotationSave.current !== null ||
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
      if (deletionPendingRef.current && changes.some((change) => change.type === "position")) return;
      const previousNodes = nodesRef.current;
      const nextNodes = applyNodeChanges(changes, previousNodes);
      replaceNodes(nextNodes);
      const removedIds = new Set(changes.filter((change) => change.type === "remove").map(({ id }) => id));
      if (removedIds.size > 0) {
        // Domain views hide cross-domain edges; prune those from the full snapshot too.
        replaceEdges(edgesRef.current.filter((edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target)));
      }
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
    [enqueuePositionSnapshot, replaceEdges, replaceNodes],
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
      const seeds = seedNodeIds ? new Set(seedNodeIds) : undefined;
      const activeDomains = seeds
        ? new Set(nodesRef.current.filter((node) => seeds.has(node.id) || dragSessionNodeIds.current.has(node.id))
          .map((node) => node.data.paper.domainId))
        : undefined;
      const scopeNodes = nodesRef.current.filter((node) => nodeBelongsToScope(node, activeScope));
      const simulationDomains = activeDomains ?? new Set(scopeNodes.map((node) => node.data.paper.domainId));
      const layoutNodes = nodesRef.current;
      if (layoutNodes.length === 0) return null;
      const layoutNodeIds = new Set(layoutNodes.map(({ id }) => id));
      const layoutEdges = connectionEdges.filter(
        ({ source, target }) =>
          layoutNodeIds.has(source) && layoutNodeIds.has(target),
      );
      const visibleIds = new Set(scopeNodes.map(({ id }) => id));
      const activeSeeds = seeds
        ? [...seeds].filter((id) => visibleIds.has(id))
        : undefined;
      if (activeSeeds && activeSeeds.length === 0) return null;
      if (motionFrame.current !== null) {
        cancelMotionFrame(motionFrame.current);
        motionFrame.current = null;
      }
      const movableNodeIds =
        activeSeeds && dragSessionNodeIds.current.size === 0
          ? localLayoutNodeIds(activeSeeds, layoutEdges)
          : undefined;
      const layout = createObsidianForceLayout(
        layoutNodes,
        layoutEdges,
        { movableNodeIds, activeDomainIds: simulationDomains },
      );
      forceLayout.current = layout;
      forceLayoutNodeIds.current = layoutNodeIds;
      for (const nodeId of dragSessionNodeIds.current) {
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
      if (!paperId || deletionPendingRef.current) return;
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
          // New membership replaces the simulation's previous geometry.
          cancelForceLayout();
          dragSessionNodeIds.current.clear();
          const added = toFlowNode(record);
          added.position = findCollisionFreePosition(toNodeRectangle(added),
            nodesRef.current.filter((node) => node.data.paper.domainId === record.paper.domainId).map(toNodeRectangle));
          const nextNodes = withDomainRegions([...nodesRef.current, added]);
          replaceNodes(nextNodes);
          layoutRevision.current += 1;
          void enqueuePositionSnapshot(toPositionUpdates(nextNodes), layoutRevision.current).catch(() => undefined);
        },
        () => {
          if (isMounted.current) setActionError("paper");
        },
      ).finally(() => pendingPaperPlacements.current.delete(paperId));
    },
    [cancelForceLayout, enqueuePositionSnapshot, replaceNodes, repository, screenToFlowPosition, trackMutation],
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
      if (deletionPendingRef.current) return;
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
          const sourceDomain = nodesRef.current.find((node) => node.id === source)?.data.paper.domainId;
          const targetDomain = nodesRef.current.find((node) => node.id === target)?.data.paper.domainId;
          if (sourceDomain === targetDomain) organizeConnections(nextEdges, [source, target]);
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
          const layout = createObsidianForceLayout(nextNodes, edgesRef.current, {
            activeDomainIds: new Set([nextScope.domainId]),
          });
          // ponytail: synchronous settle; switch to frame-driven scope layout if large domains make tab changes jank.
          layout.settle();
          const positions = layout.positions();
          nextNodes = nextNodes.map((node) => ({
            ...node,
            position: positions.get(node.id) ?? node.position,
          }));
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
      if (selectedEdgeId === null || relationUpdatePending || deletionPendingRef.current) return;
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
      replaceNodes(nodesRef.current.map((node) => ({ ...node, selected: false })));
      replaceEdges(edgesRef.current.map((edge) => ({ ...edge, selected: false })));
    },
    [organizeScope, replaceNodes, replaceEdges],
  );

  const deleteSelected = useCallback((kind?: "nodes" | "edges") => {
    if (active === false || deletionPendingRef.current) return;
    const visibleIds = new Set(nodesRef.current.filter((node) => nodeBelongsToScope(node, scopeRef.current)).map(({ id }) => id));
    void deleteElements({
      nodes: kind === "edges" ? [] : nodesRef.current.filter((node) => node.selected && visibleIds.has(node.id)),
      edges: kind === "nodes" ? [] : edgesRef.current.filter((edge) => edge.selected && visibleIds.has(edge.source) && visibleIds.has(edge.target)),
    });
  }, [active, deleteElements]);

  useEffect(() => {
    if (active === false) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && connectionMode) {
        event.preventDefault();
        exitConnectionMode();
        return;
      }
      if (isEditableTarget(event.target)) return;
      if ((event.key === "Delete" || event.key === "Backspace") && !event.repeat && !event.isComposing) {
        event.preventDefault();
        deleteSelected();
        return;
      }
      if (event.target instanceof Element && event.target.closest("button, a")) return;
      if (event.key !== " " || event.repeat) return;
      event.preventDefault();
      setConnectionMode(true);
      setConnectionSourceId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, connectionMode, deleteSelected, exitConnectionMode]);

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
      // React Flow owns the pointer position; the simulation owns every other node.
      for (const node of currentDraggedNodes.values()) {
        layout.pin(node.id, node.position);
      }
      ensureMotionFrame();
    },
    [ensureMotionFrame, organizeConnections],
  );

  const onNodeDragStop: OnNodeDrag<PaperFlowNode> = useCallback(
    (_event, activeNode, draggedNodes) => {
      const releasedNodes = new Map(
        draggedNodes.map((node) => [node.id, node] as const),
      );
      releasedNodes.set(activeNode.id, activeNode);
      const layout = forceLayout.current;
      if (!layout) return;
      for (const node of releasedNodes.values()) {
        layout.pin(node.id, node.position);
      }
      for (const nodeId of new Set([...dragSessionNodeIds.current, ...releasedNodes.keys()])) {
        layout.release(nodeId);
      }
      layout.cool();
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
      if (deletionPendingRef.current || (nodesToDelete.length === 0 && edgesToDelete.length === 0)) return false;
      deletionPendingRef.current = true;
      setDeletionPending(true);
      setActionError(null);
      const removedNodes: PaperFlowNode[] = [];
      const removedEdges: PaperFlowEdge[] = [];
      try {
        // Settle and drain snapshots before deleting their referenced node rows.
        await flush();
        await trackMutation((async () => {
          if (nodesToDelete.length > 0) {
            await repository.deleteNodes(nodesToDelete.map(({ id }) => id));
            removedNodes.push(...nodesToDelete);
            const ids = new Set(nodesToDelete.map(({ id }) => id));
            removedEdges.push(...edgesToDelete.filter((edge) => ids.has(edge.source) || ids.has(edge.target)));
          }
          const remaining = edgesToDelete.filter((edge) => !removedEdges.includes(edge));
          if (remaining.length > 0) {
            await repository.deleteEdges(remaining.map(({ id }) => id));
            removedEdges.push(...remaining);
          }
        })());
        setConnectionSourceId(null);
        return true;
      } catch {
        if (isMounted.current) setActionError(nodesToDelete.length ? "deletion" : "connection");
        return { nodes: removedNodes, edges: removedEdges };
      } finally {
        deletionPendingRef.current = false;
        if (isMounted.current) setDeletionPending(false);
      }
    },
    [flush, repository, trackMutation],
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
  const selectedNodeCount = visibleNodes.filter(({ selected }) => selected).length;
  const selectedAnnotations = selectedEdge
    ? annotationDrafts.get(selectedEdge.id) ?? selectedEdge.data
    : undefined;
  const domainFrames = useMemo(
    () =>
      resolvedScope.kind === "all"
        ? computeDomainFrames(nodes, [
            ...availableDomains,
            ...(nodes.some((node) => node.data.paper.domainId === null) &&
                nodes.some((node) => node.data.paper.domainId !== null)
              ? [{ id: "", name: "未分区" }] : []),
          ])
        : [],
    [availableDomains, nodes, resolvedScope.kind],
  );

  useEffect(() => {
    if (!paperFocusRequest || loadState !== "ready" || active === false ||
      handledFocusRevision.current === paperFocusRequest.revision) return;
    handledFocusRevision.current = paperFocusRequest.revision;
    const target = nodesRef.current.find((node) => node.data.paper.id === paperFocusRequest.paperId);
    if (!target) return;
    if (!nodeBelongsToScope(target, scopeRef.current)) setScope(ALL_SCOPE);
    replaceNodes(nodesRef.current.map((node) => ({ ...node, selected: node.id === target.id })));
    replaceEdges(edgesRef.current.map((edge) => ({ ...edge, selected: false })));
    setSelectedEdgeId(null);
    setConnectionSourceId(null);
    const rectangle = toNodeRectangle(target);
    void setCenter(target.position.x + rectangle.size.width / 2,
      target.position.y + rectangle.size.height / 2,
      { zoom: 1, duration: requestsReducedMotion() ? 0 : 300 });
  }, [active, loadState, paperFocusRequest, replaceEdges, replaceNodes, setCenter]);

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
          disabled={visibleNodes.length < 2 || deletionPending}
          onClick={() => organizeConnections()}
          type="button"
        >
          重新整理布局
        </button>
        {selectedNodeCount > 0 && (
          <button type="button" disabled={deletionPending}
            title="只移除白板卡片及其连线，论文和 PDF 保留在文库，可再次拖入"
            onClick={() => deleteSelected("nodes")}>
            从白板移除选中卡片
          </button>
        )}
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
                disabled={relationUpdatePending || deletionPending}
                onClick={() => updateSelectedEdgeRelation(relation)}
              >
                {label}
              </button>
            ))}
            <button type="button" disabled={deletionPending}
              onClick={() => deleteSelected("edges")}>
              删除选中连线
            </button>
          </div>
        )}
      </div>

      {selectedEdge && (
        <aside className="whiteboard__edge-editor" aria-label="连线解释与证据">
          <label>
            解释
            <textarea value={selectedAnnotations?.explanation ?? ""} disabled={deletionPending}
              placeholder="这两篇论文为什么相关？"
              onChange={(event) => editAnnotations(selectedEdge, "explanation", event.target.value)} />
          </label>
          <label>
            证据
            <textarea value={selectedAnnotations?.evidence ?? ""} disabled={deletionPending}
              placeholder="摘录、来源或页码"
              onChange={(event) => editAnnotations(selectedEdge, "evidence", event.target.value)} />
          </label>
          <button type="button" disabled={deletionPending || annotationSaveState === "saving" || annotationDrafts.size === 0}
            onClick={() => void flushAnnotations().catch(() => undefined)}>
            {annotationSaveState === "saving" ? "保存中…" : "保存解释与证据"}
          </button>
          <small>打开阅读器前会保存；切换选择保留草稿。</small>
        </aside>
      )}

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
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={onNodeClick}
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
          nodesDraggable={!connectionMode && !deletionPending}
          connectOnClick={false}
          panActivationKeyCode={null}
          panOnScroll
          panOnScrollMode={PanOnScrollMode.Free}
          panOnScrollSpeed={1}
          zoomOnPinch
          zoomOnScroll={false}
          deleteKeyCode={null}
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
            : actionError === "deletion"
            ? "The selected cards could not be removed. Try again."
            : "The paper connection was not saved. Try again."}
        </div>
      )}
      {annotationSaveState === "error" && (
        <div className="save-error" role="alert">
          <span>解释与证据未保存，草稿已保留。</span>
          <button type="button" onClick={() => void flushAnnotations().catch(() => undefined)}>重试保存解释与证据</button>
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
  paperFocusRequest,
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
        paperFocusRequest={paperFocusRequest}
      />
    </ReactFlowProvider>
  );
}
