import { createPortal } from "react-dom";
import { ReaderToolbarContext } from "../reader/ReaderToolbarContext";
import { useContext, useEffect, useRef, useState } from "react";
import { invoke } from "../../platform/core";
import { listen } from "../../platform/event";
import type { Paper } from "../library";
import { layoutPaperWebChat, listPaperWebChats, type PaperWebChat } from "./services/paperWebChats";
import "./ai.css";

interface ChatLoadState { id: string; status: "loading" | "ready" | "verification" | "failed" | "slow"; message: string }

export function WebChatPanel({ paper, initialChatId }: { paper: Paper; initialChatId?: string | null }) {
  return <PaperChats key={`${paper.id}:${initialChatId ?? ""}`} paper={paper} initialChatId={initialChatId} />;
}

function PaperChats({ paper, initialChatId }: { paper: Paper; initialChatId?: string | null }) {
  const toolbar = useContext(ReaderToolbarContext);
  const [chats, setChats] = useState<PaperWebChat[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loginHelpId, setLoginHelpId] = useState("");
  const [loadStates, setLoadStates] = useState<Record<string, ChatLoadState>>({});
  const [mode, setMode] = useState<"new" | "link" | "rename" | null>(null);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [retry, setRetry] = useState(0);
  const slot = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const mutation = useRef(false);
  const current = chats.find((chat) => chat.id === selected);
  const loadState = loadStates[selected];

  useEffect(() => {
    mounted.current = true;
    let active = true;
    void listPaperWebChats(paper.id).then((items) => {
      if (active) { setChats(items); setSelected(items.find((item) => item.id === initialChatId)?.id ?? items[0]?.id ?? ""); }
    }).catch((reason: unknown) => { if (active) setError(String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    const updates = listen<PaperWebChat>("paper-web-chat-updated", ({ payload }) => {
      if (!active || payload.paperId !== paper.id) return;
      setChats((items) => items.map((item) => item.id === payload.id ? payload : item));
    });
    const errors = listen<string>("paper-web-chat-error", ({ payload }) => { if (active) setError(payload); });
    const login = listen<{ id: string }>("paper-web-chat-login-required", ({ payload }) => {
      if (active) setLoginHelpId(payload.id);
    });
    const loads = listen<ChatLoadState>("paper-web-chat-load-state", ({ payload }) => {
      if (active) setLoadStates((states) => ({ ...states, [payload.id]: payload }));
    });
    void updates.catch((reason: unknown) => { if (active) setError(String(reason)); });
    void errors.catch((reason: unknown) => { if (active) setError(String(reason)); });
    void login.catch((reason: unknown) => { if (active) setError(String(reason)); });
    void loads.catch((reason: unknown) => { if (active) setError(String(reason)); });
    return () => {
      active = false;
      mounted.current = false;
      void updates.then((unlisten) => unlisten()).catch(() => {});
      void errors.then((unlisten) => unlisten()).catch(() => {});
      void login.then((unlisten) => unlisten()).catch(() => {});
      void loads.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [paper.id, initialChatId]);

  useEffect(() => {
    if (!selected) return;
    if (!toolbar.visible) {
      void layoutPaperWebChat(selected, null).catch((reason: unknown) => setError(String(reason)));
      return;
    }
    let active = true;
    let previous = "";
    let frame = 0;
    let pending = false;
    let failed = false;
    function schedule() {
      if (active && !frame) frame = requestAnimationFrame(measure);
    }
    function measure() {
      frame = 0;
      if (!active) return;
      const rect = slot.current?.getBoundingClientRect();
      const visible = rect && rect.width > 0 && rect.height > 0 && !slot.current?.closest("[hidden]");
      const bounds = visible ? {
        x: Math.max(0, rect.left), y: Math.max(0, rect.top),
        width: Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(0, rect.left)),
        height: Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(0, rect.top)),
        viewportHeight: window.innerHeight,
      } : null;
      const usable = bounds && bounds.width > 0 && bounds.height > 0 ? bounds : null;
      const key = JSON.stringify(usable);
      if (!pending && !failed && key !== previous) {
        pending = true;
        previous = key;
        void layoutPaperWebChat(selected, usable).catch((reason: unknown) => {
          failed = true;
          if (active) setError(String(reason));
        }).finally(() => { pending = false; schedule(); });
      }
    }
    // Native bounds only need updating when the reader layout changes.
    const observer = new ResizeObserver(schedule);
    for (let element: HTMLElement | null = slot.current; element; element = element.parentElement) {
      observer.observe(element);
    }
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    schedule();
    return () => {
      active = false;
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      cancelAnimationFrame(frame);
      void layoutPaperWebChat(selected, null).catch(() => {});
    };
  }, [selected, retry, toolbar.visible]);

  function edit(next: "link" | "rename") {
    setMode(next);
    setTitle(next === "rename" ? current?.title ?? "" : `讨论 ${chats.length + 1}`);
    setUrl("");
    setError("");
  }

  function openInBrowser() {
    if (!current) return;
    void invoke("open_paper_web_chat_external", { id: current.id })
      .catch((reason: unknown) => { if (mounted.current) setError(String(reason)); });
  }

  function reloadWebChat() {
    if (!current) return;
    setError("");
    setRetry((value) => value + 1);
    void invoke("reload_paper_web_chat", { id: current.id })
      .catch((reason: unknown) => { if (mounted.current) setError(String(reason)); });
  }

  async function save(next = mode) {
    if (mutation.current || !next) return;
    mutation.current = true;
    setSaving(true);
    setError("");
    try {
      const chat = await invoke<PaperWebChat>("save_paper_web_chat", {
        paperId: paper.id, id: next === "rename" ? selected : null,
        title: next === "new" ? "新对话" : title.trim(), url: next === "link" ? url.trim() : null,
      });
      if (!mounted.current) return;
      setChats((items) => [chat, ...items.filter((item) => item.id !== chat.id)]);
      setSelected(chat.id);
      setMode(null);
    } catch (reason) { if (mounted.current) setError(String(reason)); }
    finally { mutation.current = false; if (mounted.current) setSaving(false); }
  }

  const controls = (
    <div className="web-chat-controls">
      <select aria-label="当前论文的对话" value={selected} disabled={loading || saving || !chats.length}
        onChange={(event) => { setSelected(event.target.value); setMode(null); setError(""); }}>
        {!chats.length && <option value="">暂无讨论</option>}
        {chats.map((chat) => <option key={chat.id} value={chat.id}>{chat.title}{chat.url ? "" : " · 待开始"}</option>)}
      </select>
      <div className="web-chat-actions">
        <button type="button" disabled={loading || saving} onClick={() => void save("new")} title="新对话" aria-label="新对话">＋</button>
        <button type="button" disabled={loading || saving} onClick={() => edit("link")} title="关联已有对话" aria-label="关联已有对话">↗</button>
        {current && <button type="button" disabled={saving} onClick={() => edit("rename")} title="重命名" aria-label="重命名">✎</button>}
        {current && <button type="button" onClick={reloadWebChat} title="重新加载网页" aria-label="重新加载网页">⟳</button>}
        {current && <button type="button" onClick={openInBrowser} title="在浏览器中打开" aria-label="在浏览器中打开">↗︎</button>}
        {current && <button type="button" onClick={() => setLoginHelpId(selected)} title="登录帮助" aria-label="登录帮助">?</button>}
        <button type="button" onClick={() => {
          void navigator.clipboard.writeText(paper.title)
            .catch(() => setError("无法复制论文信息。"));
        }} title="复制论文信息" aria-label="复制论文信息">⧉</button>
      </div>
      {mode && <form className="web-chat-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>讨论名称<input aria-label="讨论名称" maxLength={100} required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        {mode === "link" && <label>ChatGPT 对话链接<input aria-label="ChatGPT 对话链接" type="url" required placeholder="https://chatgpt.com/c/…" value={url} onChange={(event) => setUrl(event.target.value)} /></label>}
        <div className="web-chat-actions"><button type="submit" disabled={saving || !title.trim()}>{saving ? "保存中…" : "保存并打开"}</button><button type="button" disabled={saving} onClick={() => setMode(null)}>取消</button></div>
      </form>}
      {current && <div className="web-chat-link-status" title={current.url ?? "发出首条消息后自动保存对话链接"}><span className="web-chat-sr-only">{current.url ? "已绑定 · 打开论文时恢复此对话" : "发出首条消息后自动保存对话链接"}</span>
        {current.url && <button type="button" onClick={() => {
          void invoke("restore_paper_web_chat", { id: current.id }).catch((reason: unknown) => setError(String(reason)));
        }} title="回到绑定对话" aria-label="回到绑定对话">↩</button>}
      </div>}
      {error && <p className="ai-panel__error" role="alert">{error} <button type="button" onClick={reloadWebChat}>重试网页</button></p>}
    </div>
  );

  return <section className="ai-panel ai-panel--embedded web-chat-panel" aria-label="Paper ChatGPT conversations">
    {!toolbar.chat && <header className="ai-panel__header"><div><span className="ai-eyebrow">ChatGPT · 论文讨论</span><h2 title={paper.title}>{paper.title}</h2></div></header>}
    {toolbar.chat ? createPortal(toolbar.visible ? controls : null, toolbar.chat) : controls}
    {loadState?.message && <div className="web-chat-login-help" role="status">
      <p>{loadState.message}</p>
      <div className="web-chat-actions"><button type="button" onClick={reloadWebChat}>重试加载</button><button type="button" onClick={openInBrowser}>在浏览器继续</button></div>
    </div>}
    {current && loginHelpId === selected && <div className="web-chat-login-help" role="status">
      <strong>Google 登录需要使用浏览器</strong>
      <p>Google 不支持在内嵌窗口登录。请在浏览器中登录并继续此对话；浏览器的登录状态不会同步到这里。</p>
      <p>已有对话会打开保存的链接。新建对话后，可复制地址栏链接，用“关联已有对话”保存到这篇论文。</p>
      <div className="web-chat-actions">
        <button type="button" onClick={openInBrowser}>打开浏览器继续</button>
        <button type="button" onClick={() => { edit("link"); setLoginHelpId(""); }}>关联浏览器对话</button>
        <button type="button" onClick={() => setLoginHelpId("")}>关闭提示</button>
      </div>
    </div>}
    <div className="web-chat-browser" ref={slot} data-testid="paper-chat-browser-slot">
      {!selected && <p>{loading ? "正在读取论文讨论…" : "为这篇论文新建讨论，或关联已有的 ChatGPT 对话。"}</p>}
      {selected && loadState?.status !== "ready" && <p>{loadState?.message || "正在打开 ChatGPT…使用 Google 登录时，请点击“登录帮助”。"}</p>}
    </div>

  </section>;
}
