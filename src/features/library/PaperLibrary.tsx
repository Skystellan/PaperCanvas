import { getCurrentWebview } from "../../platform/webview";
import {
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { PaperRepository } from "./data/paperRepository";
import { SqlitePaperRepository } from "./data/sqlitePaperRepository";
import type { PaperDomainRepository } from "./data/paperDomainRepository";
import { sqlitePaperDomainRepository } from "./data/sqlitePaperDomainRepository";
import type { Paper } from "./model/paper";
import type { PaperDomain } from "./model/paperDomain";
import type { PaperDropIntent } from "./model/paperDropIntent";
import type { PaperImporter } from "./services/paperImporter";
import type { PaperLibraryMutator } from "./services/paperLibraryMutator";
import {
  PaperBatchImportError,
  PaperImportError,
  TauriPaperImporter,
} from "./services/tauriPaperImporter";
import { TauriPaperLibraryMutator } from "./services/tauriPaperLibraryMutator";
import "./PaperLibrary.css";

export const PAPER_DRAG_MIME = "application/papercanvas-paper";
const UNCLASSIFIED_GROUP_KEY = "__unclassified__";

const defaultRepository = new SqlitePaperRepository();
const defaultDomainRepository = sqlitePaperDomainRepository;
const defaultImporter = new TauriPaperImporter();
const defaultMutator = new TauriPaperLibraryMutator();

export interface PaperLibraryProps {
  domainRepository?: PaperDomainRepository;
  repository?: PaperRepository;
  importer?: PaperImporter;
  mutator?: PaperLibraryMutator;
  beforePaperDelete?: (paper: Paper) => Promise<void> | void;
  beforeOrganizationChange?: () => Promise<void> | void;
  onPaperDrop?: (intent: PaperDropIntent) => void;
  onPaperDeleted?: (paper: Paper) => void;
  onPaperSelect?: (paper: Paper) => void;
  onPapersImported?: (papers: readonly Paper[]) => void;
  onOrganizationChanged?: (paperIds: readonly string[]) => void;
  selectedPaperId?: string | null;
  trackPersistenceOperation?: (operation: Promise<void>) => Promise<void>;
}

type LoadState = "loading" | "ready" | "error";

function isPdfPath(path: string): boolean {
  return path.toLowerCase().endsWith(".pdf");
}

function paperMetadata(paper: Paper): string | null {
  return (
    [paper.authors, paper.year?.toString()].filter(Boolean).join(" · ") || null
  );
}

interface PaperDomainGroup {
  domain: PaperDomain | null;
  key: string;
  name: string;
  papers: Paper[];
}

interface PaperDomainSectionProps {
  busy: boolean;
  collapsed: boolean;
  domains: readonly PaperDomain[];
  forceExpanded: boolean;
  group: PaperDomainGroup;
  onAssignPaper: (paperId: string, domainId: string | null) => void;
  onBeginRename: (domain: PaperDomain) => void;
  onCancelRename: () => void;
  onDeleteDomain: (domain: PaperDomain, opener: HTMLButtonElement) => void;
  onDeletePaper: (paper: Paper, opener: HTMLButtonElement) => void;
  onDragEnd: (paperId: string) => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>, paperId: string) => void;
  onImport: (domainId: string | null) => void;
  onPaperSelect?: (paper: Paper) => void;
  onRename: (domainId: string, name: string) => void;
  onRenameDraftChange: (name: string) => void;
  onToggle: (groupKey: string) => void;
  renameDraft: string;
  renamingDomainId: string | null;
  selectedPaperId?: string | null;
}

function PaperDomainSection({
  busy,
  collapsed,
  domains,
  forceExpanded,
  group,
  onAssignPaper,
  onBeginRename,
  onCancelRename,
  onDeleteDomain,
  onDeletePaper,
  onDragEnd,
  onDragStart,
  onImport,
  onPaperSelect,
  onRename,
  onRenameDraftChange,
  onToggle,
  renameDraft,
  renamingDomainId,
  selectedPaperId,
}: PaperDomainSectionProps) {
  const expanded = forceExpanded || !collapsed;
  const panelId = `paper-domain-${group.key}`;

  return (
    <section className="paper-library__domain">
      <div className="paper-library__domain-heading">
        <button
          aria-controls={panelId}
          aria-expanded={expanded}
          aria-label={`${group.name}（${group.papers.length}）`}
          className="paper-library__domain-toggle"
          onClick={() => onToggle(group.key)}
          type="button"
        >
          <span aria-hidden="true">{expanded ? "⌄" : "›"}</span>
          <strong>{group.name}</strong>
          <small>（{group.papers.length}）</small>
        </button>
        <div className="paper-library__domain-actions">
          <button
            aria-label={`导入 PDF 到 ${group.name}`}
            disabled={busy}
            onClick={() => onImport(group.domain?.id ?? null)}
            title={`导入 PDF 到 ${group.name}`}
            type="button"
          >
            +PDF
          </button>
          {group.domain ? (
            <>
              <button
                aria-label={`重命名 ${group.domain.name}`}
                disabled={busy}
                onClick={() => onBeginRename(group.domain!)}
                title={`重命名 ${group.domain.name}`}
                type="button"
              >
                ✎
              </button>
              <button
                aria-label={`删除 ${group.domain.name}`}
                disabled={busy}
                onClick={(event) =>
                  onDeleteDomain(group.domain!, event.currentTarget)
                }
                title={`删除 ${group.domain.name}`}
                type="button"
              >
                ×
              </button>
            </>
          ) : null}
        </div>
      </div>

      {group.domain && renamingDomainId === group.domain.id ? (
        <form
          className="paper-library__domain-form"
          onSubmit={(event) => {
            event.preventDefault();
            const name = renameDraft.trim();
            if (name) onRename(group.domain!.id, name);
          }}
        >
          <input
            aria-label="领域名称"
            autoFocus
            maxLength={80}
            onChange={(event) => onRenameDraftChange(event.currentTarget.value)}
            value={renameDraft}
          />
          <button disabled={!renameDraft.trim() || busy} type="submit">
            保存重命名
          </button>
          <button disabled={busy} onClick={onCancelRename} type="button">
            取消
          </button>
        </form>
      ) : null}

      <div hidden={!expanded} id={panelId}>
        {group.papers.length === 0 ? (
          <p className="paper-library__domain-empty">暂无论文</p>
        ) : null}
        {group.papers.map((paper) => {
          const metadata = paperMetadata(paper);
          return (
            <div className="paper-library__item-row" key={paper.id}>
              <button
                aria-label={`${paper.title}${
                  paper.filePath ? "" : "（无本地 PDF）"
                }`}
                aria-pressed={selectedPaperId === paper.id}
                className={`paper-library__item${
                  selectedPaperId === paper.id ? " is-selected" : ""
                }`}
                draggable
                onClick={() => onPaperSelect?.(paper)}
                onDragEnd={() => onDragEnd(paper.id)}
                onDragStart={(event) => onDragStart(event, paper.id)}
                type="button"
              >
                <span aria-hidden="true" className="paper-library__document" />
                <span className="paper-library__item-copy">
                  <strong>{paper.title}</strong>
                  {metadata ? <span>{metadata}</span> : null}
                  {!paper.filePath ? (
                    <span className="paper-library__legacy">无本地 PDF</span>
                  ) : null}
                </span>
              </button>
              <div className="paper-library__item-actions">
                <select
                  aria-label={`移动 ${paper.title} 到领域`}
                  disabled={busy}
                  onChange={(event) => {
                    const domainId = event.currentTarget.value || null;
                    if (domainId !== paper.domainId) {
                      onAssignPaper(paper.id, domainId);
                    }
                  }}
                  title="移动到领域"
                  value={paper.domainId ?? ""}
                >
                  <option value="">未分区</option>
                  {domains.map((domain) => (
                    <option key={domain.id} value={domain.id}>
                      {domain.name}
                    </option>
                  ))}
                </select>
                <button
                  aria-label={`删除 ${paper.title}`}
                  className="paper-library__delete"
                  disabled={busy}
                  onClick={(event) =>
                    onDeletePaper(paper, event.currentTarget)
                  }
                  type="button"
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function PaperLibrary({
  domainRepository = defaultDomainRepository,
  repository = defaultRepository,
  importer = defaultImporter,
  mutator = defaultMutator,
  beforePaperDelete,
  beforeOrganizationChange,
  onPaperDrop,
  onPaperDeleted,
  onPaperSelect,
  onPapersImported,
  onOrganizationChanged,
  selectedPaperId,
  trackPersistenceOperation,
}: PaperLibraryProps) {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [domains, setDomains] = useState<PaperDomain[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [searchTerm, setSearchTerm] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isOrganizing, setIsOrganizing] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Paper | null>(null);
  const [pendingDomainDelete, setPendingDomainDelete] =
    useState<PaperDomain | null>(null);
  const [collapsedDomains, setCollapsedDomains] = useState<Set<string>>(
    () => new Set(),
  );
  const [importDomainId, setImportDomainId] = useState("");
  const [isCreatingDomain, setIsCreatingDomain] = useState(false);
  const [newDomainName, setNewDomainName] = useState("");
  const [renamingDomainId, setRenamingDomainId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const selectedImportDomainId =
    importDomainId && domains.some((domain) => domain.id === importDomainId)
      ? importDomainId
      : "";
  const importInFlight = useRef(false);
  const organizationInFlight = useRef(false);
  const storageReconciliation = useRef<Promise<void> | null>(null);
  const activePaperDragId = useRef<string | null>(null);
  const nativePaperDragId = useRef<string | null>(null);
  const dragCleanupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deleteOpener = useRef<HTMLButtonElement | null>(null);
  const deleteCancelButton = useRef<HTMLButtonElement | null>(null);
  const deleteConfirmButton = useRef<HTMLButtonElement | null>(null);
  const domainDeleteOpener = useRef<HTMLButtonElement | null>(null);
  const domainDeleteCancelButton = useRef<HTMLButtonElement | null>(null);
  const domainDeleteConfirmButton = useRef<HTMLButtonElement | null>(null);
  const createDomainButton = useRef<HTMLButtonElement | null>(null);

  const clearInternalPaperDrag = useCallback(() => {
    activePaperDragId.current = null;
    nativePaperDragId.current = null;
    if (dragCleanupTimer.current !== null) {
      clearTimeout(dragCleanupTimer.current);
      dragCleanupTimer.current = null;
    }
  }, []);

  const reconcileStorageOnce = useCallback((): Promise<void> => {
    if (!storageReconciliation.current) {
      storageReconciliation.current = Promise.resolve()
        .then(() => mutator.reconcileStorage())
        .catch(() => {
          // Recovery can safely retry on the next launch; a cleanup failure
          // must not make otherwise-readable library rows unavailable.
        });
    }
    return storageReconciliation.current;
  }, [mutator]);

  const loadPapers = useCallback(async () => {
    setLoadState("loading");
    try {
      const [nextPapers, nextDomains] = await Promise.all([
        repository.list(),
        domainRepository.list(),
      ]);
      await reconcileStorageOnce();
      setPapers(nextPapers);
      setDomains(nextDomains);
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }, [domainRepository, reconcileStorageOnce, repository]);

  useEffect(() => {
    let active = true;

    void Promise.all([repository.list(), domainRepository.list()]).then(
      async ([nextPapers, nextDomains]) => {
        await reconcileStorageOnce();
        if (active) {
          setPapers(nextPapers);
          setDomains(nextDomains);
          setLoadState("ready");
        }
      },
      () => {
        if (active) {
          setLoadState("error");
        }
      },
    );

    return () => {
      active = false;
    };
  }, [domainRepository, reconcileStorageOnce, repository]);

  const completeImport = useCallback(
    (operation: () => Promise<Paper[]>): Promise<void> => {
      if (importInFlight.current) return Promise.resolve();
      importInFlight.current = true;
      setIsImporting(true);
      setOperationError(null);
      const persistenceOperation = (async () => {
        try {
          const importedPapers = await operation();
          if (importedPapers.length > 0) {
            onPapersImported?.(importedPapers);
            await loadPapers();
          }
        } catch (error) {
          if (error instanceof PaperBatchImportError) {
            if (error.importedPapers.length > 0) {
              onPapersImported?.(error.importedPapers);
              setOperationError(
                `已导入 ${error.importedPapers.length} 篇 PDF，另有 ${error.failedCount} 个文件导入失败。`,
              );
            } else {
              setOperationError(
                `${error.failedCount} 个 PDF 导入失败，请检查文件后重试。`,
              );
            }
          } else {
            setOperationError(
              error instanceof PaperImportError
                ? error.message
                : "无法导入 PDF，请重试。",
            );
          }
          await loadPapers();
        } finally {
          importInFlight.current = false;
          setIsImporting(false);
        }
      })();

      return trackPersistenceOperation
        ? trackPersistenceOperation(persistenceOperation)
        : persistenceOperation;
    },
    [loadPapers, onPapersImported, trackPersistenceOperation],
  );

  const completeOrganization = useCallback(
    (
      mutation: () => Promise<readonly string[]>,
      onSuccess: () => void,
      failureMessage: string,
    ): Promise<void> => {
      if (organizationInFlight.current) return Promise.resolve();
      organizationInFlight.current = true;
      setIsOrganizing(true);
      setOperationError(null);

      const persistenceOperation = (async () => {
        try {
          await beforeOrganizationChange?.();
          const affectedPaperIds = await mutation();
          await loadPapers();
          onSuccess();
          onOrganizationChanged?.(affectedPaperIds);
        } catch {
          setOperationError(failureMessage);
        } finally {
          organizationInFlight.current = false;
          setIsOrganizing(false);
        }
      })();

      return trackPersistenceOperation
        ? trackPersistenceOperation(persistenceOperation)
        : persistenceOperation;
    },
    [
      beforeOrganizationChange,
      loadPapers,
      onOrganizationChanged,
      trackPersistenceOperation,
    ],
  );

  const importIntoDomain = useCallback(
    (domainId: string | null) =>
      completeImport(() =>
        domainId
          ? importer.chooseAndImport({ domainId })
          : importer.chooseAndImport(),
      ),
    [completeImport, importer],
  );

  const renameDomain = useCallback(
    (domainId: string, name: string) =>
      completeOrganization(
        async () => {
          await domainRepository.rename(domainId, name);
          return [];
        },
        () => {
          setRenamingDomainId(null);
          setRenameDraft("");
        },
        "无法重命名领域，名称可能已存在。",
      ),
    [completeOrganization, domainRepository],
  );

  const assignPaperDomain = useCallback(
    (paperId: string, domainId: string | null) =>
      completeOrganization(
        async () => {
          await domainRepository.assignPaper(paperId, domainId);
          return [paperId];
        },
        () => undefined,
        "无法移动论文，请重试。",
      ),
    [completeOrganization, domainRepository],
  );

  useEffect(() => {
    if (pendingDelete) {
      deleteCancelButton.current?.focus();
      return;
    }

    if (deleteOpener.current?.isConnected) {
      deleteOpener.current.focus();
    }
    deleteOpener.current = null;
  }, [pendingDelete]);

  useEffect(() => {
    if (pendingDomainDelete) {
      domainDeleteCancelButton.current?.focus();
      return;
    }

    const opener = domainDeleteOpener.current;
    if (opener?.isConnected) opener.focus();
    else if (opener) createDomainButton.current?.focus();
    domainDeleteOpener.current = null;
  }, [pendingDomainDelete]);

  const closeDeleteDialog = useCallback(() => {
    if (!isDeleting) setPendingDelete(null);
  }, [isDeleting]);

  const handleDeleteDialogKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDeleteDialog();
        return;
      }
      if (event.key !== "Tab") return;

      const cancelButton = deleteCancelButton.current;
      const confirmButton = deleteConfirmButton.current;
      if (!cancelButton || !confirmButton) return;
      if (event.shiftKey && document.activeElement === cancelButton) {
        event.preventDefault();
        confirmButton.focus();
      } else if (!event.shiftKey && document.activeElement === confirmButton) {
        event.preventDefault();
        cancelButton.focus();
      }
    },
    [closeDeleteDialog],
  );

  const closeDomainDeleteDialog = useCallback(() => {
    if (!isOrganizing) setPendingDomainDelete(null);
  }, [isOrganizing]);

  const handleDomainDeleteDialogKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDomainDeleteDialog();
        return;
      }
      if (event.key !== "Tab") return;

      const cancelButton = domainDeleteCancelButton.current;
      const confirmButton = domainDeleteConfirmButton.current;
      if (!cancelButton || !confirmButton) return;
      if (event.shiftKey && document.activeElement === cancelButton) {
        event.preventDefault();
        confirmButton.focus();
      } else if (!event.shiftKey && document.activeElement === confirmButton) {
        event.preventDefault();
        cancelButton.focus();
      }
    },
    [closeDomainDeleteDialog],
  );

  const confirmPaperDelete = useCallback((): Promise<void> => {
    const paper = pendingDelete;
    if (!paper || isDeleting) return Promise.resolve();

    setIsDeleting(true);
    setOperationError(null);
    const persistenceOperation = (async () => {
      try {
        await beforePaperDelete?.(paper);
        await mutator.deletePaper(paper.id);
      } catch {
        setOperationError("无法删除论文，请重试。");
        setIsDeleting(false);
        return;
      }

      setPapers((currentPapers) =>
        currentPapers.filter((candidate) => candidate.id !== paper.id),
      );
      setPendingDelete(null);
      setIsDeleting(false);
      onPaperDeleted?.(paper);
    })();

    return trackPersistenceOperation
      ? trackPersistenceOperation(persistenceOperation)
      : persistenceOperation;
  }, [
    beforePaperDelete,
    isDeleting,
    mutator,
    onPaperDeleted,
    pendingDelete,
    trackPersistenceOperation,
  ]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        if (payload.type === "enter") {
          if (payload.paths.length === 0 && activePaperDragId.current) {
            nativePaperDragId.current = activePaperDragId.current;
          }
          return;
        }
        if (payload.type === "leave") {
          nativePaperDragId.current = null;
          return;
        }
        if (payload.type !== "drop") {
          return;
        }

        if (payload.paths.length === 0) {
          const paperId = nativePaperDragId.current ?? activePaperDragId.current;
          clearInternalPaperDrag();
          if (!paperId || !onPaperDrop) return;

          // Wry 0.55 on macOS emits AppKit points here. Those already match
          // CSS client coordinates, despite Tauri exposing PhysicalPosition.
          const clientX = payload.position.x;
          const clientY = payload.position.y;
          if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
          onPaperDrop({ paperId, clientX, clientY });
          return;
        }

        clearInternalPaperDrag();
        const pdfPaths = payload.paths.filter(isPdfPath);
        if (pdfPaths.length === 0) {
          setOperationError("只支持 PDF 文件。");
          return;
        }

        void completeImport(() =>
          selectedImportDomainId
            ? importer.importPaths(pdfPaths, {
                domainId: selectedImportDomainId,
              })
            : importer.importPaths(pdfPaths),
        );
      })
      .then((stopListening) => {
        if (disposed) {
          stopListening();
        } else {
          unlisten = stopListening;
        }
      })
      .catch(() => {
        if (!disposed) {
          setOperationError("无法启用 Finder 拖放导入。");
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
      clearInternalPaperDrag();
    };
  }, [
    clearInternalPaperDrag,
    completeImport,
    importer,
    selectedImportDomainId,
    onPaperDrop,
  ]);

  const visiblePapers = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) {
      return papers;
    }

    return papers.filter((paper) =>
      [paper.title, paper.authors ?? "", paper.year?.toString() ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [papers, searchTerm]);

  const paperGroups = useMemo(() => {
    const knownDomainIds = new Set(domains.map((domain) => domain.id));
    const groups = [
      ...domains.map((domain) => ({
        domain,
        key: domain.id,
        name: domain.name,
        papers: visiblePapers.filter((paper) => paper.domainId === domain.id),
      })),
      {
        domain: null,
        key: UNCLASSIFIED_GROUP_KEY,
        name: "未分区",
        papers: visiblePapers.filter(
          (paper) =>
            paper.domainId === null || !knownDomainIds.has(paper.domainId),
        ),
      },
    ];
    return searchTerm.trim()
      ? groups.filter((group) => group.papers.length > 0)
      : groups;
  }, [domains, searchTerm, visiblePapers]);

  const startPaperDrag = useCallback(
    (event: DragEvent<HTMLButtonElement>, paperId: string) => {
      clearInternalPaperDrag();
      activePaperDragId.current = paperId;
      dragCleanupTimer.current = setTimeout(clearInternalPaperDrag, 30_000);
      setOperationError(null);
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData(PAPER_DRAG_MIME, paperId);
    },
    [clearInternalPaperDrag],
  );

  const finishPaperDrag = useCallback(
    (paperId: string) => {
      if (activePaperDragId.current !== paperId) return;
      if (dragCleanupTimer.current !== null) {
        clearTimeout(dragCleanupTimer.current);
      }
      dragCleanupTimer.current = setTimeout(clearInternalPaperDrag, 1_000);
    },
    [clearInternalPaperDrag],
  );

  const handlePaperDragStart = useCallback(
    (event: DragEvent<HTMLButtonElement>, paperId: string) =>
      startPaperDrag(event, paperId),
    [startPaperDrag],
  );

  const handlePaperDragEnd = useCallback(
    (paperId: string) => finishPaperDrag(paperId),
    [finishPaperDrag],
  );

  const toggleDomainGroup = useCallback((groupKey: string) => {
    setCollapsedDomains((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }, []);

  const beginDomainRename = useCallback((domain: PaperDomain) => {
    setRenamingDomainId(domain.id);
    setRenameDraft(domain.name);
  }, []);

  const cancelDomainRename = useCallback(() => {
    setRenamingDomainId(null);
    setRenameDraft("");
  }, []);

  const requestPaperDelete = useCallback(
    (paper: Paper, opener: HTMLButtonElement) => {
      deleteOpener.current = opener;
      setOperationError(null);
      setPendingDelete(paper);
    },
    [],
  );

  const requestDomainImport = useCallback(
    (domainId: string | null) => {
      void importIntoDomain(domainId);
    },
    [importIntoDomain],
  );

  const requestDomainRename = useCallback(
    (domainId: string, name: string) => {
      void renameDomain(domainId, name);
    },
    [renameDomain],
  );

  const requestPaperAssignment = useCallback(
    (paperId: string, domainId: string | null) => {
      void assignPaperDomain(paperId, domainId);
    },
    [assignPaperDomain],
  );

  const requestDomainDelete = useCallback(
    (domain: PaperDomain, opener: HTMLButtonElement) => {
      domainDeleteOpener.current = opener;
      setOperationError(null);
      setPendingDomainDelete(domain);
    },
    [],
  );

  return (
    <aside
      className="paper-library"
      aria-label="论文库"
      aria-busy={loadState === "loading"}
    >
      <div className="paper-library__header">
        <div>
          <span className="paper-library__eyebrow">LIBRARY</span>
          <h2>论文库</h2>
        </div>
        <div className="paper-library__import-controls">
          <select
            aria-label="导入 PDF 到领域"
            disabled={isImporting || isDeleting || isOrganizing}
            onChange={(event) => setImportDomainId(event.currentTarget.value)}
            value={selectedImportDomainId}
          >
            <option value="">未分区</option>
            {domains.map((domain) => (
              <option key={domain.id} value={domain.id}>
                {domain.name}
              </option>
            ))}
          </select>
          <button
            className="paper-library__import"
            type="button"
            disabled={isImporting || isDeleting || isOrganizing}
            onClick={() =>
              void importIntoDomain(selectedImportDomainId || null)
            }
          >
            {isImporting ? "导入中…" : "导入 PDF"}
          </button>
        </div>
      </div>

      <div className="paper-library__domain-toolbar">
        <span>领域</span>
        <button
          aria-expanded={isCreatingDomain}
          disabled={isDeleting || isImporting || isOrganizing}
          onClick={() => {
            setIsCreatingDomain((value) => !value);
            setNewDomainName("");
          }}
          ref={createDomainButton}
          type="button"
        >
          新建领域
        </button>
      </div>

      {isCreatingDomain ? (
        <form
          className="paper-library__domain-form"
          onSubmit={(event) => {
            event.preventDefault();
            const name = newDomainName.trim();
            if (!name) return;
            void completeOrganization(
              async () => {
                await domainRepository.create(name);
                return [];
              },
              () => {
                setIsCreatingDomain(false);
                setNewDomainName("");
              },
              "无法创建领域，名称可能已存在。",
            );
          }}
        >
          <input
            aria-label="新领域名称"
            autoFocus
            maxLength={80}
            onChange={(event) => setNewDomainName(event.currentTarget.value)}
            placeholder="例如：领域 A"
            value={newDomainName}
          />
          <button disabled={!newDomainName.trim() || isOrganizing} type="submit">
            保存领域
          </button>
          <button
            disabled={isOrganizing}
            onClick={() => {
              setIsCreatingDomain(false);
              setNewDomainName("");
            }}
            type="button"
          >
            取消
          </button>
        </form>
      ) : null}

      <label className="paper-library__search">
        <span aria-hidden="true">⌕</span>
        <span className="paper-library__visually-hidden">搜索论文</span>
        <input
          type="search"
          value={searchTerm}
          placeholder="搜索论文"
          onChange={(event) => setSearchTerm(event.currentTarget.value)}
        />
      </label>

      {operationError ? (
        <p className="paper-library__notice" role="alert">
          {operationError}
        </p>
      ) : null}

      <div className="paper-library__list">
        {loadState === "loading" ? (
          <p className="paper-library__state">正在加载论文…</p>
        ) : null}

        {loadState === "error" ? (
          <div className="paper-library__state" role="alert">
            <p>无法读取论文库，请重试。</p>
            <button type="button" onClick={() => void loadPapers()}>
              重试
            </button>
          </div>
        ) : null}

        {loadState === "ready" && visiblePapers.length === 0 ? (
          <p className="paper-library__state">
            {papers.length === 0
              ? "还没有论文，导入一篇 PDF 开始。"
              : "没有匹配的论文。"}
          </p>
        ) : null}

        {loadState === "ready"
          ? paperGroups.map((group) => (
              <PaperDomainSection
                busy={isDeleting || isImporting || isOrganizing}
                collapsed={collapsedDomains.has(group.key)}
                domains={domains}
                forceExpanded={Boolean(searchTerm.trim())}
                group={group}
                key={group.key}
                onAssignPaper={requestPaperAssignment}
                onBeginRename={beginDomainRename}
                onCancelRename={cancelDomainRename}
                onDeleteDomain={requestDomainDelete}
                onDeletePaper={requestPaperDelete}
                onDragEnd={handlePaperDragEnd}
                onDragStart={handlePaperDragStart}
                onImport={requestDomainImport}
                onPaperSelect={onPaperSelect}
                onRename={requestDomainRename}
                onRenameDraftChange={setRenameDraft}
                onToggle={toggleDomainGroup}
                renameDraft={renameDraft}
                renamingDomainId={renamingDomainId}
                selectedPaperId={selectedPaperId}
              />
            ))
          : null}
      </div>

      {pendingDelete ? (
        <div className="paper-library__dialog-backdrop">
          <div
            className="paper-library__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="paper-library-delete-title"
            onKeyDown={handleDeleteDialogKeyDown}
          >
            <h3 id="paper-library-delete-title">删除论文</h3>
            <p>确定要从论文库删除“{pendingDelete.title}”吗？</p>
            <p className="paper-library__dialog-detail">
              受管 PDF 副本和关联内容会一并删除，原始导入文件不会受影响。
            </p>
            <div className="paper-library__dialog-actions">
              <button
                ref={deleteCancelButton}
                type="button"
                disabled={isDeleting}
                onClick={closeDeleteDialog}
              >
                取消
              </button>
              <button
                ref={deleteConfirmButton}
                className="is-danger"
                type="button"
                disabled={isDeleting}
                onClick={() => void confirmPaperDelete()}
              >
                {isDeleting ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingDomainDelete ? (
        <div className="paper-library__dialog-backdrop">
          <div
            aria-labelledby="paper-library-domain-delete-title"
            aria-modal="true"
            className="paper-library__dialog"
            onKeyDown={handleDomainDeleteDialogKeyDown}
            role="dialog"
          >
            <h3 id="paper-library-domain-delete-title">删除领域</h3>
            <p>确定删除领域“{pendingDomainDelete.name}”吗？</p>
            <p className="paper-library__dialog-detail">
              论文会移到“未分区”，PDF、白板节点和关联内容都不会删除。
            </p>
            <div className="paper-library__dialog-actions">
              <button
                disabled={isOrganizing}
                onClick={closeDomainDeleteDialog}
                ref={domainDeleteCancelButton}
                type="button"
              >
                取消
              </button>
              <button
                className="is-danger"
                disabled={isOrganizing}
                onClick={() => {
                  const domain = pendingDomainDelete;
                  const affectedPaperIds = papers
                    .filter((paper) => paper.domainId === domain.id)
                    .map((paper) => paper.id);
                  void completeOrganization(
                    async () => {
                      await domainRepository.delete(domain.id);
                      return affectedPaperIds;
                    },
                    () => {
                      setPendingDomainDelete(null);
                      if (importDomainId === domain.id) setImportDomainId("");
                    },
                    "无法删除领域，请重试。",
                  );
                }}
                ref={domainDeleteConfirmButton}
                type="button"
              >
                {isOrganizing ? "删除中…" : "确认删除领域"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
