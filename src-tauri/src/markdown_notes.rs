use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{AppHandle, Manager, Webview};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct NoteFileState(pub Mutex<()>);

pub(crate) fn note_path(directory: &Path, paper_id: &str) -> Result<PathBuf, String> {
    if paper_id.is_empty()
        || paper_id.len() > 128
        || !paper_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err("Invalid paper identifier.".into());
    }
    if fs::symlink_metadata(directory)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("The papers directory must not be a symbolic link.".into());
    }
    let path = directory.join(format!("{paper_id}.md"));
    match fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            return Err("The note must be a regular Markdown file.".into())
        }
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e.to_string()),
        _ => {}
    }
    Ok(path)
}

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result.map_err(|e| e.to_string())
}

pub(crate) fn load_note(
    db: &Connection,
    directory: &Path,
    paper_id: &str,
) -> Result<String, String> {
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let path = note_path(directory, paper_id)?;
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM papers WHERE id=?1)",
            [paper_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("Paper not found.".into());
    }
    match fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let legacy: Option<String> = db
                .query_row(
                    "SELECT content FROM notes WHERE paper_id=?1",
                    [paper_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let content = legacy.unwrap_or_default();
            atomic_write(&path, &content)?;
            // Keep the legacy row as a migration backup. The file is authoritative from now on.
            Ok(content)
        }
        Err(e) => Err(e.to_string()),
    }
}

pub(crate) fn save_note(
    directory: &Path,
    paper_id: &str,
    content: &str,
    expected: &str,
) -> Result<(), String> {
    let path = note_path(directory, paper_id)?;
    let current = fs::read_to_string(&path).map_err(|_| "NOTE_FILE_CHANGED".to_string())?;
    if current != expected && current != content {
        return Err("NOTE_FILE_CHANGED".into());
    }
    atomic_write(&path, content)
}

fn storage(app: &AppHandle, view: &Webview) -> Result<(Connection, PathBuf), String> {
    if view.label() != "main" {
        return Err("Only the local reader can access notes.".into());
    }
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("papers");
    let db_path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("papercanvas.db");
    let db = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(3))
        .map_err(|e| e.to_string())?;
    Ok((db, directory))
}

#[tauri::command]
pub async fn load_markdown_note(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, NoteFileState>,
    paper_id: String,
) -> Result<String, String> {
    let _guard = state.0.lock().await;
    let (db, directory) = storage(&app, &webview)?;
    load_note(&db, &directory, &paper_id)
}

#[tauri::command]
pub async fn save_markdown_note(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, NoteFileState>,
    paper_id: String,
    content: String,
    expected: String,
) -> Result<(), String> {
    let _guard = state.0.lock().await;
    let (db, directory) = storage(&app, &webview)?;
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM papers WHERE id=?1)",
            [&paper_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("Paper not found.".into());
    }
    save_note(&directory, &paper_id, &content, &expected)
}

#[tauri::command]
pub fn reveal_markdown_note(
    app: AppHandle,
    webview: Webview,
    paper_id: String,
) -> Result<(), String> {
    let (_, directory) = storage(&app, &webview)?;
    let path = note_path(&directory, &paper_id)?;
    if !path.is_file() {
        return Err("Open the note first to create its Markdown file.".into());
    }
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .status();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .status();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result = std::process::Command::new("xdg-open")
        .arg(&directory)
        .status();
    if result.map_err(|e| e.to_string())?.success() {
        Ok(())
    } else {
        Err("Could not reveal the Markdown file.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_notes_and_preserves_external_edits() {
        let directory = std::env::temp_dir().join(format!("paper-notes-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE papers(id TEXT PRIMARY KEY); CREATE TABLE notes(paper_id TEXT, content TEXT); INSERT INTO papers VALUES('paper-1'), ('paper-2'); INSERT INTO notes VALUES('paper-1', '# 原有笔记');").unwrap();
        assert_eq!(load_note(&db, &directory, "paper-1").unwrap(), "# 原有笔记");
        assert_eq!(
            fs::read_to_string(directory.join("paper-1.md")).unwrap(),
            "# 原有笔记"
        );
        save_note(&directory, "paper-1", "**Updated**", "# 原有笔记").unwrap();
        fs::write(directory.join("paper-1.md"), "External edit").unwrap();
        assert_eq!(
            save_note(&directory, "paper-1", "Unsaved draft", "**Updated**").unwrap_err(),
            "NOTE_FILE_CHANGED"
        );
        assert_eq!(
            load_note(&db, &directory, "paper-1").unwrap(),
            "External edit"
        );
        assert_eq!(load_note(&db, &directory, "paper-2").unwrap(), "");
        assert!(load_note(&db, &directory, "missing").is_err());
        assert!(load_note(&db, &directory, "../escape").is_err());
        #[cfg(unix)]
        {
            fs::remove_file(directory.join("paper-2.md")).unwrap();
            std::os::unix::fs::symlink(directory.join("paper-1.md"), directory.join("paper-2.md"))
                .unwrap();
            assert!(save_note(&directory, "paper-2", "overwrite", "External edit").is_err());
        }
        fs::remove_dir_all(directory).unwrap();
    }
}
