use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{
    webview::WebviewBuilder, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect,
    Webview, WebviewUrl,
};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct WebChatState(pub Mutex<Option<String>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperWebChat {
    id: String,
    paper_id: String,
    title: String,
    url: Option<String>,
    last_opened_at: i64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewport_height: f64,
}

fn trusted(view: &Webview) -> Result<(), String> {
    if view.label() == "main" {
        Ok(())
    } else {
        Err("Only the local reader can manage paper conversations.".into())
    }
}

fn connection(app: &AppHandle) -> Result<Connection, String> {
    let file = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("papercanvas.db");
    let db = Connection::open(file).map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(3))
        .map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA foreign_keys = ON")
        .map_err(|e| e.to_string())?;
    Ok(db)
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PaperWebChat> {
    Ok(PaperWebChat {
        id: row.get(0)?,
        paper_id: row.get(1)?,
        title: row.get(2)?,
        url: row.get(3)?,
        last_opened_at: row.get(4)?,
    })
}

fn get(app: &AppHandle, id: &str) -> Result<PaperWebChat, String> {
    get_from_db(&connection(app)?, id)
}

pub(crate) fn get_from_db(db: &Connection, id: &str) -> Result<PaperWebChat, String> {
    db.query_row(
        "SELECT id, paper_id, title, url, last_opened_at FROM paper_web_chats WHERE id=?1",
        [id],
        row,
    )
    .map_err(|_| "找不到这条论文对话。".into())
}

// Accept ordinary and project/GPT conversation URLs, never share links or login URLs.
pub fn conversation_url(value: &str) -> Option<String> {
    let mut url = tauri::Url::parse(value.trim()).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("chatgpt.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    let valid_path = (parts.len() == 2 && parts[0] == "c")
        || (parts.len() == 4 && parts[0] == "g" && !parts[1].is_empty() && parts[2] == "c");
    if !valid_path || uuid::Uuid::parse_str(parts.last()?).is_err() {
        return None;
    }
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string())
}

fn capture(app: &AppHandle, id: &str, url: &str) -> Result<(), String> {
    let Some(url) = conversation_url(url) else {
        return Ok(());
    };
    // Once linked, navigating ChatGPT's sidebar must not silently change this binding.
    let changed = capture_in_db(&connection(app)?, id, &url)?;
    if changed > 0 {
        app.emit_to("main", "paper-web-chat-updated", get(app, id)?)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn capture_in_db(db: &Connection, id: &str, url: &str) -> Result<usize, String> {
    let Some(url) = conversation_url(url) else {
        return Ok(0);
    };
    db.execute(
        "UPDATE paper_web_chats SET url=?1 WHERE id=?2 AND url IS NULL",
        params![url, id],
    )
    .map_err(|e| e.to_string())
}

pub(crate) fn update_title(
    db: &Connection,
    id: &str,
    url: &str,
    title: &str,
) -> rusqlite::Result<usize> {
    let Some(url) = conversation_url(url) else {
        return Ok(0);
    };
    let title = title.trim();
    // Loading/login pages must not replace a meaningful conversation title.
    if title.is_empty()
        || matches!(
            title,
            "ChatGPT"
                | "New chat"
                | "新聊天"
                | "新对话"
                | "请稍候…"
                | "请稍候..."
                | "Just a moment..."
                | "Just a moment…"
        )
    {
        return Ok(0);
    }
    let title: String = title.chars().take(100).collect();
    db.execute(
        "UPDATE paper_web_chats SET title=?1 WHERE id=?2 AND url=?3 AND title<>?1",
        params![title, id, url],
    )
}

fn capture_title(app: &AppHandle, id: &str, url: &str, title: &str) -> Result<(), String> {
    capture(app, id, url)?;
    if update_title(&connection(app)?, id, url, title).map_err(|e| e.to_string())? > 0 {
        app.emit_to("main", "paper-web-chat-updated", get(app, id)?)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_paper_web_chats(
    app: AppHandle,
    webview: Webview,
    paper_id: String,
) -> Result<Vec<PaperWebChat>, String> {
    trusted(&webview)?;
    list_from_db(&connection(&app)?, &paper_id)
}

pub(crate) fn list_from_db(db: &Connection, paper_id: &str) -> Result<Vec<PaperWebChat>, String> {
    let mut statement = db.prepare("SELECT id, paper_id, title, url, last_opened_at FROM paper_web_chats WHERE paper_id=?1 ORDER BY last_opened_at DESC, created_at DESC, id").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([paper_id], row)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_paper_web_chat(
    app: AppHandle,
    webview: Webview,
    paper_id: String,
    id: Option<String>,
    title: String,
    url: Option<String>,
) -> Result<PaperWebChat, String> {
    trusted(&webview)?;
    save_in_db(&connection(&app)?, &paper_id, id, &title, url)
}

pub(crate) fn save_in_db(
    db: &Connection,
    paper_id: &str,
    id: Option<String>,
    title: &str,
    url: Option<String>,
) -> Result<PaperWebChat, String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 100 {
        return Err("讨论名称需为 1–100 个字符。".into());
    }
    let url = url
        .map(|value| {
            conversation_url(&value).ok_or("请粘贴 chatgpt.com 的对话链接（不是分享链接）。")
        })
        .transpose()?;
    let id = if let Some(id) = id {
        let changed = db
            .execute(
                "UPDATE paper_web_chats SET title=?1 WHERE id=?2 AND paper_id=?3",
                params![title, id, paper_id],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("找不到这篇论文的对话。".into());
        }
        id
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        db.execute("INSERT INTO paper_web_chats (id,paper_id,title,url,created_at,last_opened_at) VALUES (?1,?2,?3,?4,?5,?5)", params![id, paper_id, title, url, now()]).map_err(|e| e.to_string())?;
        id
    };
    get_from_db(db, &id)
}

#[tauri::command]
pub async fn layout_paper_web_chat(
    app: AppHandle,
    webview: Webview,
    id: String,
    bounds: Option<BrowserBounds>,
    state: tauri::State<'_, WebChatState>,
) -> Result<(), String> {
    trusted(&webview)?;
    let mut active = state.0.lock().await;
    let chat = get(&app, &id)?;
    let label = format!("paper-chat-{}", chat.id);
    let Some(bounds) = bounds else {
        if active.as_deref() == Some(&id) {
            *active = None;
        }
        if let Some(view) = app.get_webview(&label) {
            view.hide().map_err(|e| e.to_string())?;
            if let Ok(url) = view.url() {
                capture(&app, &id, url.as_str())?;
            }
        }
        return Ok(());
    };
    if ![bounds.x, bounds.y, bounds.width, bounds.height]
        .iter()
        .all(|v| v.is_finite() && *v >= 0.0)
        || bounds.width < 1.0
        || bounds.height < 1.0
    {
        return Err("Invalid browser bounds.".into());
    }
    // macOS WKWebView reserves title-bar space inside its native frame, so its
    // DOM viewport is shorter. Translate from that viewport to native coordinates.
    let scale = webview.window().scale_factor().map_err(|e| e.to_string())?;
    let origin = webview
        .position()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let inset = if cfg!(target_os = "macos") {
        (webview
            .size()
            .map_err(|e| e.to_string())?
            .to_logical::<f64>(scale)
            .height
            - bounds.viewport_height)
            .max(0.0)
    } else {
        0.0
    };
    let position = LogicalPosition::new(origin.x + bounds.x, origin.y + bounds.y + inset);
    let size = LogicalSize::new(bounds.width, bounds.height);
    let activating = active.as_deref() != Some(&id);
    if activating {
        if let Some(view) = active
            .as_ref()
            .and_then(|id| app.get_webview(&format!("paper-chat-{id}")))
        {
            view.hide().map_err(|e| e.to_string())?;
        }
    }
    if let Some(view) = app.get_webview(&label) {
        view.set_bounds(Rect {
            position: position.into(),
            size: size.into(),
        })
        .map_err(|e| e.to_string())?;
        if activating {
            view.show().map_err(|e| e.to_string())?;
        }
    } else {
        let url = chat
            .url
            .as_deref()
            .unwrap_or("https://chatgpt.com/")
            .parse()
            .map_err(|_| "Invalid conversation URL.")?;
        // A native child webview avoids iframe restrictions. No remote IPC permissions or DOM injection.
        let title_id = id.clone();
        let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
            .on_navigation(|url| matches!(url.scheme(), "https" | "about"))
            .on_document_title_changed(move |view, title| {
                let id = title_id.clone();
                // Query native URL off the UI thread; no remote IPC or page scripts.
                tauri::async_runtime::spawn(async move {
                    if let Ok(url) = view.url() {
                        if let Err(message) =
                            capture_title(view.app_handle(), &id, url.as_str(), &title)
                        {
                            let _ =
                                view.app_handle()
                                    .emit_to("main", "paper-web-chat-error", message);
                        }
                    }
                });
            });
        app.get_window("main")
            .ok_or("Reader window is unavailable.")?
            .add_child(builder, position, size)
            .map_err(|e| e.to_string())?;
        let handle = app.clone();
        let poll_id = id.clone();
        tauri::async_runtime::spawn(async move {
            let mut previous = String::new();
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let Some(view) = handle.get_webview(&label) else {
                    break;
                };
                // Hidden chats retain drafts, but must not keep querying the UI thread.
                if handle.state::<WebChatState>().0.lock().await.as_deref() != Some(&poll_id) {
                    continue;
                }
                if let Ok(url) = view.url() {
                    let current = url.to_string();
                    if current != previous {
                        match capture(&handle, &poll_id, &current) {
                            Ok(()) => previous = current,
                            Err(message) => {
                                let _ = handle.emit_to("main", "paper-web-chat-error", message);
                            }
                        }
                    }
                }
            }
        });
    }
    if activating {
        connection(&app)?
            .execute(
                "UPDATE paper_web_chats SET last_opened_at=?1 WHERE id=?2",
                params![now(), id],
            )
            .map_err(|e| e.to_string())?;
        *active = Some(id);
    }
    Ok(())
}

#[tauri::command]
pub async fn open_paper_web_chat_external(
    app: AppHandle,
    webview: Webview,
    id: String,
) -> Result<(), String> {
    trusted(&webview)?;
    let chat = get(&app, &id)?;
    let url = chat
        .url
        .as_deref()
        .and_then(conversation_url)
        .unwrap_or_else(|| "https://chatgpt.com/".into());
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(target_os = "windows")]
    let opener = "explorer";
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let opener = "xdg-open";
    let status = std::process::Command::new(opener)
        .arg(url)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Could not open the conversation in your browser.".into())
    }
}

#[tauri::command]
pub async fn reload_paper_web_chat(
    app: AppHandle,
    webview: Webview,
    id: String,
) -> Result<(), String> {
    trusted(&webview)?;
    let chat = get(&app, &id)?;
    if let Some(view) = app.get_webview(&format!("paper-chat-{}", chat.id)) {
        view.reload().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn restore_paper_web_chat(
    app: AppHandle,
    webview: Webview,
    id: String,
) -> Result<(), String> {
    trusted(&webview)?;
    let chat = get(&app, &id)?;
    if let Some(view) = app.get_webview(&format!("paper-chat-{}", chat.id)) {
        let url = chat
            .url
            .as_deref()
            .unwrap_or("https://chatgpt.com/")
            .parse()
            .map_err(|_| "Invalid conversation URL.")?;
        view.navigate(url).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn syncs_only_the_bound_conversation_title() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE papers(id TEXT PRIMARY KEY); INSERT INTO papers VALUES ('a');",
        )
        .unwrap();
        db.execute_batch(crate::paper_web_chats_migration_sql())
            .unwrap();
        let url = "https://chatgpt.com/c/6aa9ff1f-b11c-83ee-8e6f-f69405b4f239";
        db.execute(
            "INSERT INTO paper_web_chats VALUES ('chat','a','新对话',?1,1,1)",
            [url],
        )
        .unwrap();
        assert_eq!(
            update_title(&db, "chat", url, "SEAL 的训练方法").unwrap(),
            1
        );
        assert_eq!(update_title(&db, "chat", url, "ChatGPT").unwrap(), 0);
        for title in ["请稍候…", "请稍候...", "Just a moment...", "Just a moment…"] {
            assert_eq!(update_title(&db, "chat", url, title).unwrap(), 0);
        }
        assert_eq!(
            update_title(&db, "chat", "https://chatgpt.com/", "登录").unwrap(),
            0
        );
        assert_eq!(
            update_title(
                &db,
                "chat",
                "https://chatgpt.com/c/6aa9ff1f-b11c-83ee-8e6f-f69405b4f238",
                "另一篇论文"
            )
            .unwrap(),
            0
        );
        assert_eq!(
            update_title(&db, "chat", url, "SEAL 的训练方法").unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT title FROM paper_web_chats", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "SEAL 的训练方法"
        );
    }
    #[test]
    fn multiple_discussions_stay_bound_to_their_paper_and_restore_recent_first() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE papers(id TEXT PRIMARY KEY); INSERT INTO papers VALUES ('a'),('b');").unwrap();
        db.execute_batch(crate::paper_web_chats_migration_sql())
            .unwrap();
        db.execute_batch("INSERT INTO paper_web_chats VALUES ('a1','a','概览',NULL,1,2),('a2','a','公式',NULL,1,5),('b1','b','概览',NULL,1,9);").unwrap();
        let mut statement = db
            .prepare(
                "SELECT id FROM paper_web_chats WHERE paper_id='a' ORDER BY last_opened_at DESC",
            )
            .unwrap();
        let ids: Vec<String> = statement
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(ids, ["a2", "a1"]);
        db.execute("UPDATE paper_web_chats SET url='https://chatgpt.com/c/example' WHERE id='a1' AND url IS NULL", []).unwrap();
        assert_eq!(
            db.execute(
                "UPDATE paper_web_chats SET url='other' WHERE id='a1' AND url IS NULL",
                []
            )
            .unwrap(),
            0
        );
        db.execute("DELETE FROM papers WHERE id='a'", []).unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM paper_web_chats", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn validates_conversation_urls_without_accepting_other_origins_or_share_links() {
        let id = "6aa9ff1f-b11c-83ee-8e6f-f69405b4f239";
        assert_eq!(
            conversation_url(&format!("https://chatgpt.com/c/{id}?x=1#top")),
            Some(format!("https://chatgpt.com/c/{id}"))
        );
        assert!(conversation_url(&format!("https://chatgpt.com/g/g-project/c/{id}")).is_some());
        for url in [
            format!("https://chatgpt.com.evil.test/c/{id}"),
            format!("https://user:pass@chatgpt.com/c/{id}"),
            format!("http://chatgpt.com/c/{id}"),
            format!("https://chatgpt.com/share/{id}"),
            "https://chatgpt.com/".into(),
            "javascript:alert(1)".into(),
        ] {
            assert!(conversation_url(&url).is_none(), "{url}");
        }
    }
}
