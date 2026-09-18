import { useEffect, useState } from "react";
import type { AiRepository } from "./data/aiRepository";
import { sqliteAiRepository } from "./data/sqliteAiRepository";
import type { ChatSession } from "./model/ai";

export interface RecentDiscussionsProps {
  limit?: number;
  repository?: Pick<AiRepository, "listSessions">;
}

function formatUpdatedAt(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(new Date(timestamp));
}

function modelName(model: ChatSession["model"]): string {
  return model.replace("gpt-5.6-", "");
}

export function RecentDiscussions({
  limit = 6,
  repository = sqliteAiRepository,
}: RecentDiscussionsProps) {
  const [sessions, setSessions] = useState<ChatSession[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let active = true;
    void repository.listSessions().then(
      (loaded) => {
        if (!active) return;
        setSessions(loaded.slice(0, Math.max(0, limit)));
        setLoadError(false);
      },
      () => {
        if (!active) return;
        setSessions([]);
        setLoadError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [limit, repository]);

  return (
    <aside aria-label="Recent discussions" className="recent-discussions">
      <header>
        <span className="ai-eyebrow">Local history</span>
        <h2>Recent discussions</h2>
      </header>
      {sessions === null ? (
        <p role="status">Loading recent discussions…</p>
      ) : loadError ? (
        <p role="alert">Recent discussions could not be loaded.</p>
      ) : sessions.length === 0 ? (
        <p>No discussions yet. Open a PDF to start one.</p>
      ) : (
        <ol>
          {sessions.map((session) => (
            <li key={session.id}>
              <article>
                <h3>{session.title}</h3>
                <div>
                  <time dateTime={new Date(session.updatedAt).toISOString()}>
                    {formatUpdatedAt(session.updatedAt)}
                  </time>
                  <span>{modelName(session.model)}</span>
                </div>
              </article>
            </li>
          ))}
        </ol>
      )}
      <footer>Open a paper to continue a discussion.</footer>
    </aside>
  );
}
