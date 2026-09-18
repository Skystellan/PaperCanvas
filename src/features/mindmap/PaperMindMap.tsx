import {
  applyNodeChanges,
  Background,
  Controls,
  PanOnScrollMode,
  ReactFlow,
  ReactFlowProvider,
  type NodeChange,
  type NodeTypes,
  type OnNodeDrag,
} from "@xyflow/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  usePersistenceWriter,
  type PersistenceWriter,
} from "../persistence";
import { MindMapNodeCard } from "./MindMapNodeCard";
import type { MindMapRepository } from "./data/mindMapRepository";
import {
  MindMapRevisionConflictError,
  sqliteMindMapRepository,
} from "./data/sqliteMindMapRepository";
import {
  MIND_MAP_LIMITS,
  validateMindMapTree,
  type MindMapTree,
} from "./model/mindMap";
import {
  toMindMapFlowEdges,
  toMindMapFlowNodes,
  type MindMapFlowNode,
} from "./model/mindMapFlow";
import {
  findNonOverlappingMindMapPosition,
  layoutMindMapTree,
} from "./model/mindMapLayout";
import "./mindmap.css";

const nodeTypes = {
  "mind-map": MindMapNodeCard,
} satisfies NodeTypes;

const DEFAULT_PROMPT =
  "Build a concise analysis tree covering the paper's question, method, evidence, findings, and limitations.";

type LoadState = "loading" | "ready" | "error";
export type MindMapGenerationStatus =
  | "idle"
  | "generating"
  | "saving"
  | "error";

export interface GenerateMindMapRequest {
  paperId: string;
  prompt: string;
  signal: AbortSignal;
}

export type GenerateMindMap = (
  request: GenerateMindMapRequest,
) => Promise<MindMapTree>;

export interface PaperMindMapProps {
  generateMindMap?: GenerateMindMap;
  initialPrompt?: string;
  onGenerationStatusChange?: (status: MindMapGenerationStatus) => void;
  paperId: string;
  repository?: MindMapRepository;
}

interface MindMapSaveFailure {
  error: Error;
}

function PaperMindMapCanvas({
  generateMindMap,
  initialPrompt = DEFAULT_PROMPT,
  onGenerationStatusChange,
  paperId,
  repository,
}: Required<Pick<PaperMindMapProps, "repository">> &
  Omit<PaperMindMapProps, "repository">) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [tree, setTree] = useState<MindMapTree | null>(null);
  const [nodes, setNodes] = useState<MindMapFlowNode[]>([]);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [status, setStatus] = useState<MindMapGenerationStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const treeRef = useRef<MindMapTree | null>(null);
  const nodesRef = useRef<MindMapFlowNode[]>([]);
  const statusRef = useRef<MindMapGenerationStatus>("idle");
  const generationSequence = useRef(0);
  const generationAbortController = useRef<AbortController | null>(null);
  const statusListenerRef = useRef(onGenerationStatusChange);
  const pendingGenerationsRef = useRef(new Set<Promise<void>>());
  const pendingWritesRef = useRef(new Set<Promise<unknown>>());
  const saveFailureRef = useRef<MindMapSaveFailure | null>(null);
  const writeSequenceRef = useRef(0);
  const latestWriteSequenceRef = useRef(0);
  const flushOperationRef = useRef<Promise<void> | null>(null);
  const isFlushingRef = useRef(false);

  useEffect(() => {
    statusListenerRef.current = onGenerationStatusChange;
  }, [onGenerationStatusChange]);

  const replaceNodes = useCallback((nextNodes: MindMapFlowNode[]) => {
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
  }, []);

  const replaceTree = useCallback(
    (nextTree: MindMapTree | null) => {
      treeRef.current = nextTree;
      setTree(nextTree);
      replaceNodes(nextTree ? toMindMapFlowNodes(nextTree) : []);
    },
    [replaceNodes],
  );

  const updateStatus = useCallback(
    (nextStatus: MindMapGenerationStatus) => {
      statusRef.current = nextStatus;
      setStatus(nextStatus);
      statusListenerRef.current?.(nextStatus);
    },
    [],
  );

  const trackDatabaseWrite = useCallback(
    <T,>(start: () => Promise<T>): Promise<T> => {
      const sequence = writeSequenceRef.current + 1;
      writeSequenceRef.current = sequence;
      latestWriteSequenceRef.current = sequence;
      saveFailureRef.current = null;

      const operation = Promise.resolve().then(start);
      pendingWritesRef.current.add(operation);
      void operation.then(
        () => {
          pendingWritesRef.current.delete(operation);
          if (sequence === latestWriteSequenceRef.current) {
            saveFailureRef.current = null;
          }
        },
        (error: unknown) => {
          pendingWritesRef.current.delete(operation);
          if (sequence === latestWriteSequenceRef.current) {
            saveFailureRef.current = {
              error:
                error instanceof Error
                  ? error
                  : new Error("The mind map database write failed."),
            };
          }
        },
      );
      return operation;
    },
    [],
  );

  const trackGeneration = useCallback((operation: Promise<void>) => {
    pendingGenerationsRef.current.add(operation);
    const clear = () => pendingGenerationsRef.current.delete(operation);
    void operation.then(clear, clear);
    return operation;
  }, []);

  const reloadAfterRevisionConflict = useCallback(
    async (conflictError: MindMapRevisionConflictError) => {
      try {
        const latestValue = await repository.load(paperId);
        const latestTree = latestValue ? validateMindMapTree(latestValue) : null;
        replaceTree(latestTree);
        if (latestTree?.sourcePrompt) setPrompt(latestTree.sourcePrompt);
        if (saveFailureRef.current?.error === conflictError) {
          saveFailureRef.current = null;
        }
        setErrorMessage(
          "This mind map changed elsewhere, so the latest saved version was reloaded.",
        );
        updateStatus("error");
      } catch {
        setErrorMessage(
          "This mind map changed elsewhere and the latest version could not be reloaded.",
        );
        setLoadState("error");
        updateStatus("error");
      }
    },
    [paperId, replaceTree, repository, updateStatus],
  );

  useEffect(() => {
    let active = true;
    generationSequence.current += 1;
    generationAbortController.current?.abort();
    generationAbortController.current = null;
    treeRef.current = null;
    nodesRef.current = [];

    void repository.load(paperId).then(
      (storedTree) => {
        if (!active) return;
        try {
          const validated = storedTree ? validateMindMapTree(storedTree) : null;
          replaceTree(validated);
          if (validated?.sourcePrompt) setPrompt(validated.sourcePrompt);
          if (
            saveFailureRef.current?.error instanceof
            MindMapRevisionConflictError
          ) {
            saveFailureRef.current = null;
          }
          setErrorMessage(null);
          setLoadState("ready");
          updateStatus("idle");
        } catch {
          setLoadState("error");
          setErrorMessage("Could not load this mind map because its local data is invalid.");
        }
      },
      () => {
        if (!active) return;
        setLoadState("error");
        setErrorMessage("Could not load this mind map from local storage.");
      },
    );

    return () => {
      active = false;
    };
  }, [loadAttempt, paperId, replaceTree, repository, updateStatus]);

  useEffect(
    () => () => {
      generationSequence.current += 1;
      generationAbortController.current?.abort();
    },
    [],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<MindMapFlowNode>[]) => {
      if (
        statusRef.current === "generating" ||
        statusRef.current === "saving"
      ) {
        return;
      }
      replaceNodes(applyNodeChanges(changes, nodesRef.current));
    },
    [replaceNodes],
  );

  const persistManualPosition: OnNodeDrag<MindMapFlowNode> = useCallback(
    (_event, activeNode) => {
      const persistedTree = treeRef.current;
      if (
        !persistedTree ||
        statusRef.current === "generating" ||
        statusRef.current === "saving"
      ) {
        return;
      }

      const currentPositions = nodesRef.current.map((node) => ({
        id: node.id,
        x: node.id === activeNode.id ? activeNode.position.x : node.position.x,
        y: node.id === activeNode.id ? activeNode.position.y : node.position.y,
      }));
      const settledPosition = findNonOverlappingMindMapPosition(
        activeNode.id,
        activeNode.position,
        currentPositions,
      );
      const nextTree: MindMapTree = {
        ...persistedTree,
        revision: persistedTree.revision + 1,
        updatedAt: Date.now(),
        nodes: persistedTree.nodes.map((node) => {
          const position = currentPositions.find((item) => item.id === node.id)!;
          return {
            ...node,
            x: node.id === activeNode.id ? settledPosition.x : position.x,
            y: node.id === activeNode.id ? settledPosition.y : position.y,
          };
        }),
      };
      let validated: MindMapTree;
      try {
        validated = validateMindMapTree(nextTree);
      } catch {
        replaceTree(persistedTree);
        setErrorMessage(
          "That node position is outside the supported canvas area. The saved layout was restored.",
        );
        updateStatus("error");
        return;
      }
      replaceNodes(toMindMapFlowNodes(validated));
      updateStatus("saving");
      setErrorMessage(null);

      const saveOperation = trackDatabaseWrite(() =>
        repository.save(paperId, validated, persistedTree.revision),
      );
      void saveOperation.then(
        () => {
          treeRef.current = validated;
          setTree(validated);
          updateStatus("idle");
        },
        async (error: unknown) => {
          if (error instanceof MindMapRevisionConflictError) {
            await reloadAfterRevisionConflict(error);
            return;
          }
          replaceTree(persistedTree);
          setErrorMessage(
            "Could not save that node position. The last saved layout was restored.",
          );
          updateStatus("error");
        },
      );
    },
    [
      paperId,
      reloadAfterRevisionConflict,
      replaceNodes,
      replaceTree,
      repository,
      trackDatabaseWrite,
      updateStatus,
    ],
  );

  const stopGeneration = useCallback(() => {
    generationSequence.current += 1;
    generationAbortController.current?.abort();
    generationAbortController.current = null;
    setErrorMessage(null);
    updateStatus("idle");
  }, [updateStatus]);

  const runGeneration = useCallback(async () => {
    const requestedPrompt = prompt.trim();
    if (
      !generateMindMap ||
      !requestedPrompt ||
      requestedPrompt.length > MIND_MAP_LIMITS.maxSourcePromptLength ||
      isFlushingRef.current ||
      statusRef.current === "generating" ||
      statusRef.current === "saving"
    ) {
      return;
    }

    const sequence = generationSequence.current + 1;
    generationSequence.current = sequence;
    const abortController = new AbortController();
    generationAbortController.current = abortController;
    setErrorMessage(null);
    updateStatus("generating");

    try {
      const generated = await generateMindMap({
        paperId,
        prompt: requestedPrompt,
        signal: abortController.signal,
      });
      if (
        abortController.signal.aborted ||
        sequence !== generationSequence.current
      ) {
        return;
      }

      let laidOut: MindMapTree;
      try {
        laidOut = layoutMindMapTree(validateMindMapTree(generated));
      } catch {
        setErrorMessage(
          "AI did not return a valid tree. Your existing map was kept unchanged.",
        );
        updateStatus("error");
        return;
      }

      const previousTree = treeRef.current;
      const expectedRevision = previousTree?.revision ?? 0;
      const nextTree = validateMindMapTree({
        ...laidOut,
        revision: expectedRevision + 1,
        sourcePrompt: requestedPrompt,
        updatedAt: Date.now(),
      });
      updateStatus("saving");
      await trackDatabaseWrite(() =>
        repository.save(paperId, nextTree, expectedRevision),
      );
      if (sequence !== generationSequence.current) return;
      replaceTree(nextTree);
      updateStatus("idle");
    } catch (error) {
      if (
        abortController.signal.aborted ||
        sequence !== generationSequence.current
      ) {
        return;
      }
      if (error instanceof MindMapRevisionConflictError) {
        await reloadAfterRevisionConflict(error);
        return;
      }
      if (saveFailureRef.current?.error === error) {
        saveFailureRef.current = null;
      }
      setErrorMessage(
        "The mind map could not be generated or saved. Your existing map was kept.",
      );
      updateStatus("error");
    } finally {
      if (sequence === generationSequence.current) {
        generationAbortController.current = null;
      }
    }
  }, [
    generateMindMap,
    paperId,
    prompt,
    reloadAfterRevisionConflict,
    replaceTree,
    repository,
    trackDatabaseWrite,
    updateStatus,
  ]);

  const generate = useCallback(
    () => trackGeneration(runGeneration()),
    [runGeneration, trackGeneration],
  );

  const flush = useCallback(() => {
    if (flushOperationRef.current) return flushOperationRef.current;
    isFlushingRef.current = true;

    const operation = (async () => {
      try {
        while (
          pendingGenerationsRef.current.size > 0 ||
          pendingWritesRef.current.size > 0
        ) {
          if (
            pendingGenerationsRef.current.size > 0 &&
            generationAbortController.current !== null
          ) {
            stopGeneration();
          }
          const pending = [
            ...pendingGenerationsRef.current,
            ...pendingWritesRef.current,
          ];
          await Promise.allSettled(pending);
        }

        if (saveFailureRef.current !== null) {
          throw saveFailureRef.current.error;
        }
      } finally {
        isFlushingRef.current = false;
      }
    })();

    flushOperationRef.current = operation;
    const clear = () => {
      if (flushOperationRef.current === operation) {
        flushOperationRef.current = null;
      }
    };
    void operation.then(clear, clear);
    return operation;
  }, [stopGeneration]);

  const persistenceWriter = useMemo<PersistenceWriter>(
    () => ({
      isDirty: () =>
        pendingGenerationsRef.current.size > 0 ||
        pendingWritesRef.current.size > 0 ||
        saveFailureRef.current !== null,
      flush,
    }),
    [flush],
  );
  usePersistenceWriter(`mind-map:${paperId}`, persistenceWriter);

  const edges = useMemo(() => (tree ? toMindMapFlowEdges(tree) : []), [tree]);

  if (loadState === "loading") {
    return (
      <section className="paper-mind-map paper-mind-map--message" role="status">
        <span className="paper-mind-map__spinner" aria-hidden="true" />
        <p>Opening mind map…</p>
      </section>
    );
  }

  if (loadState === "error") {
    return (
      <section className="paper-mind-map paper-mind-map--message" role="alert">
        <span className="paper-mind-map__error-mark" aria-hidden="true">!</span>
        <p>{errorMessage}</p>
        <button
          onClick={() => {
            setLoadState("loading");
            setErrorMessage(null);
            setLoadAttempt((attempt) => attempt + 1);
          }}
          type="button"
        >
          Retry
        </button>
      </section>
    );
  }

  const promptTooLong = prompt.length > MIND_MAP_LIMITS.maxSourcePromptLength;
  const isBusy = status === "generating" || status === "saving";

  return (
    <section className="paper-mind-map" aria-label="Paper mind map">
      <div className="paper-mind-map__composer">
        <label>
          <span>Analysis prompt</span>
          <textarea
            aria-label="Mind map prompt"
            disabled={isBusy}
            onChange={(event) => {
              setPrompt(event.target.value);
              if (statusRef.current === "error") updateStatus("idle");
              setErrorMessage(null);
            }}
            rows={2}
            value={prompt}
          />
        </label>
        <div className="paper-mind-map__actions">
          <span className={promptTooLong ? "is-over-limit" : ""}>
            {prompt.length}/{MIND_MAP_LIMITS.maxSourcePromptLength}
          </span>
          {status === "generating" ? (
            <button onClick={stopGeneration} type="button">
              Stop generation
            </button>
          ) : (
            <button
              aria-label={tree ? "Regenerate mind map" : "Generate mind map"}
              disabled={
                !generateMindMap || !prompt.trim() || promptTooLong || isBusy
              }
              onClick={() => void generate()}
              type="button"
            >
              {status === "saving"
                ? "Saving…"
                : tree
                  ? "Regenerate"
                  : "Generate"}
            </button>
          )}
        </div>
      </div>

      <div className="paper-mind-map__canvas">
        <ReactFlow
          edges={edges}
          fitView
          fitViewOptions={{ maxZoom: 1.1, padding: 0.24 }}
          maxZoom={2}
          minZoom={0.25}
          nodeTypes={nodeTypes}
          nodes={nodes}
          nodesConnectable={false}
          nodesDraggable={!isBusy}
          onNodeDragStop={persistManualPosition}
          onNodesChange={onNodesChange}
          panOnScroll
          panOnScrollMode={PanOnScrollMode.Free}
          panOnScrollSpeed={1}
          zoomOnDoubleClick={false}
          zoomOnPinch
          zoomOnScroll={false}
        >
          <Background color="#d9d7cf" gap={22} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
        {!tree && (
          <div className="paper-mind-map__empty">
            <span aria-hidden="true">⌁</span>
            <h3>Map the paper’s argument</h3>
            <p>
              Generate a local analysis tree when an AI provider is connected.
            </p>
          </div>
        )}
        {status === "saving" && (
          <span className="paper-mind-map__saving" role="status">
            Saving mind map…
          </span>
        )}
      </div>

      {errorMessage && (
        <div className="paper-mind-map__error" role="alert">
          {errorMessage}
        </div>
      )}
      {!generateMindMap && (
        <p className="paper-mind-map__provider-hint">
          Connect an AI provider to enable generation. The map remains fully local.
        </p>
      )}
    </section>
  );
}

export function PaperMindMap({
  generateMindMap,
  initialPrompt,
  onGenerationStatusChange,
  paperId,
  repository = sqliteMindMapRepository,
}: PaperMindMapProps) {
  return (
    <ReactFlowProvider>
      <PaperMindMapCanvas
        key={paperId}
        generateMindMap={generateMindMap}
        initialPrompt={initialPrompt}
        onGenerationStatusChange={onGenerationStatusChange}
        paperId={paperId}
        repository={repository}
      />
    </ReactFlowProvider>
  );
}
