import { useEffect, useId, useRef, useState } from "react";
import { listen } from "../../platform/event";
import { listRecentPaperWebChats, type RecentPaperWebChat } from "./services/paperWebChats";

export interface RecentDiscussionsProps {
  limit?: number;
  active?: boolean;
  catalogRevision?: number;
  onOpenDiscussion?: (chat: RecentPaperWebChat) => Promise<void>;
}

const DEFAULT_WIDTH = 270;
const MIN_WIDTH = 240;
function maximumWidth() { return Math.max(MIN_WIDTH, Math.min(480, Math.floor(window.innerWidth * 0.45))); }
function clampWidth(width: number, maximum: number) { return Math.max(MIN_WIDTH, Math.min(maximum, width)); }

function formatUpdatedAt(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric", hour: "2-digit", minute: "2-digit", month: "short",
  }).format(new Date(timestamp));
}

export function RecentDiscussions({ limit = 6, active = true, catalogRevision = 0, onOpenDiscussion }: RecentDiscussionsProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [maxWidth, setMaxWidth] = useState(maximumWidth);
  const [width, setWidth] = useState(() => clampWidth(DEFAULT_WIDTH, maximumWidth()));
  const drag = useRef<{ x: number; width: number } | null>(null);
  const contentId = useId();

  useEffect(() => {
    const resize = () => {
      const maximum = maximumWidth();
      setMaxWidth(maximum);
      setWidth((current) => clampWidth(current, maximum));
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const [chats, setChats] = useState<RecentPaperWebChat[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [openError, setOpenError] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!active || collapsed) return;
    let disposed = false;
    let generation = 0;
    const load = async () => {
      const request = ++generation;
      try {
        const loaded = await listRecentPaperWebChats(limit);
        if (disposed || request !== generation) return;
        setChats(loaded);
        setLoadError(false);
      } catch {
        if (!disposed && request === generation) setLoadError(true);
      }
    };
    const updates = listen("paper-web-chat-updated", () => void load());
    // Subscribe before reading; returning to the canvas also refreshes if events fail.
    void updates.then(() => { if (!disposed) void load(); }).catch(() => {
      if (!disposed) void load();
    });
    return () => {
      disposed = true;
      void updates.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [active, collapsed, limit, catalogRevision, retry]);

  async function open(chat: RecentPaperWebChat) {
    if (!onOpenDiscussion || opening) return;
    setOpening(chat.id);
    setOpenError(false);
    try { await onOpenDiscussion(chat); }
    catch { setOpenError(true); }
    finally { setOpening(null); }
  }

  return (
    <aside aria-label="Recent discussions" className={`recent-discussions${collapsed ? " is-collapsed" : ""}`} style={{ width: collapsed ? 36 : width }}>
      {!collapsed && <div
        className="recent-discussions__resizer" role="separator" tabIndex={0}
        aria-label="Resize recent discussions" aria-orientation="vertical"
        aria-controls={contentId} aria-valuemin={MIN_WIDTH} aria-valuemax={maxWidth}
        aria-valuenow={width} aria-valuetext={`${width} pixels`}
        title="Drag to resize; double-click to reset"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          drag.current = { x: event.clientX, width };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current) setWidth(clampWidth(drag.current.width + drag.current.x - event.clientX, maxWidth));
        }}
        onPointerUp={(event) => {
          drag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { drag.current = null; }}
        onLostPointerCapture={() => { drag.current = null; }}
        onDoubleClick={() => setWidth(clampWidth(DEFAULT_WIDTH, maxWidth))}
        onKeyDown={(event) => {
          const next = event.key === "ArrowLeft" ? width + 16 : event.key === "ArrowRight" ? width - 16
            : event.key === "Home" ? MIN_WIDTH : event.key === "End" ? maxWidth : null;
          if (next !== null) { event.preventDefault(); setWidth(clampWidth(next, maxWidth)); }
        }}
      />}
      <header>
        <div hidden={collapsed}><span className="ai-eyebrow">Paper conversations</span><h2>Recent discussions</h2></div>
        <button type="button" className="recent-discussions__toggle" aria-controls={contentId} aria-expanded={!collapsed}
          aria-label={collapsed ? "Show recent discussions" : "Hide recent discussions"}
          title={collapsed ? "Show recent discussions" : "Hide recent discussions"}
          onClick={() => setCollapsed((value) => !value)}>{collapsed ? "◂" : "▸"}</button>
      </header>
      <div id={contentId} className="recent-discussions__content" hidden={collapsed}>
      {loadError ? <p role="alert">Recent discussions could not be loaded. <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button></p>
        : chats === null ? <p role="status">Loading recent discussions…</p>
        : chats.length === 0 ? <p>No discussions yet. Open a PDF to start one.</p>
        : <ol>{chats.map((chat) => <li key={chat.id}>
          <button className="recent-discussions__open" type="button" disabled={!onOpenDiscussion || opening !== null}
            onClick={() => void open(chat)} aria-label={`Open ${chat.title} — ${chat.paperTitle}`}>
            <article>
              <h3 title={chat.title}>{chat.title}</h3>
              <p className="recent-discussions__paper" title={chat.paperTitle}>{chat.paperTitle}</p>
              <div><time dateTime={new Date(chat.lastOpenedAt).toISOString()}>{formatUpdatedAt(chat.lastOpenedAt)}</time>
                <span>{opening === chat.id ? "Opening…" : chat.url ? "ChatGPT" : "Not started"}</span></div>
            </article>
          </button>
        </li>)}</ol>}
      {openError && <p role="alert">Could not open this discussion. Please retry.</p>}
      <footer>Continue a conversation in its paper’s reader.</footer>
      </div>
    </aside>
  );
}
