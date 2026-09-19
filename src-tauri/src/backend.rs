// JSON-lines desktop transport. Ordinary commands run in arrival order on one worker.
use crate::{markdown_notes, web_chat};
use rusqlite::{
    params_from_iter,
    types::{Value as SqlValue, ValueRef},
    Connection,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Connection as _;
use std::{
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Deserialize)]
pub struct Request {
    pub id: u64,
    pub command: String,
    #[serde(default)]
    pub args: Value,
}

pub struct Backend {
    pub data_dir: PathBuf,
    db: Connection,
}

pub async fn migrate(path: &Path) -> Result<(), String> {
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true);
    let mut db = sqlx::SqliteConnection::connect_with(&options)
        .await
        .map_err(err)?;
    let migrations = crate::migrations()
        .into_iter()
        .map(|m| {
            sqlx::migrate::Migration::new(
                m.version,
                m.description.into(),
                m.kind.into(),
                m.sql.into(),
                false,
            )
        })
        .collect::<Vec<_>>();
    let migrator = sqlx::migrate::Migrator {
        migrations: migrations.into(),
        ..sqlx::migrate::Migrator::DEFAULT
    };
    migrator.run(&mut db).await.map_err(err)?;
    db.close().await.map_err(err)
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn string<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Missing or invalid {key}"))
}
fn optional(args: &Value, key: &str) -> Result<Option<String>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        _ => Err(format!("Invalid {key}")),
    }
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

impl Backend {
    pub async fn open(data_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&data_dir).map_err(err)?;
        let data_dir = std::fs::canonicalize(data_dir).map_err(err)?;
        migrate(&data_dir.join("papercanvas.db")).await?;
        let db = Connection::open(data_dir.join("papercanvas.db")).map_err(err)?;
        db.busy_timeout(Duration::from_secs(3)).map_err(err)?;
        db.execute_batch("PRAGMA foreign_keys=ON").map_err(err)?;
        Ok(Self { data_dir, db })
    }

    pub fn handle(&self, request: Request) -> Value {
        match self.dispatch(&request.command, &request.args) {
            Ok(result) => json!({"id":request.id,"result":result}),
            Err(error) => json!({"id":request.id,"error":error}),
        }
    }

    pub fn dispatch(&self, command: &str, args: &Value) -> Result<Value, String> {
        if !args.is_object() {
            return Err("args must be an object".into());
        }
        let papers = self.data_dir.join("papers");
        let database = self.data_dir.join("papercanvas.db");
        match command {
            "database_load" => Ok(json!("sqlite:papercanvas.db")),
            "database_select" | "database_execute" => {
                let values = match args.get("values") {
                    None => Vec::new(),
                    Some(Value::Array(values)) => values.clone(),
                    _ => return Err("values must be an array".into()),
                };
                let values = values
                    .into_iter()
                    .map(|v| match v {
                        Value::Null => Ok(SqlValue::Null),
                        Value::Bool(b) => Ok(SqlValue::Integer(b as i64)),
                        Value::String(s) => Ok(SqlValue::Text(s)),
                        Value::Number(n) => n
                            .as_i64()
                            .map(SqlValue::Integer)
                            .or_else(|| n.as_f64().map(SqlValue::Real))
                            .ok_or("Invalid number".to_string()),
                        _ => Err("Unsupported SQL parameter".into()),
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                let mut statement = self.db.prepare(string(args, "query")?).map_err(err)?;
                if command == "database_execute" {
                    let changed = statement.execute(params_from_iter(values)).map_err(err)?;
                    return Ok(
                        json!({"rowsAffected":changed,"lastInsertId":self.db.last_insert_rowid()}),
                    );
                }
                if !statement.readonly() {
                    return Err("database_select requires a read-only query".into());
                }
                let names = statement
                    .column_names()
                    .into_iter()
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                let rows = statement
                    .query_map(params_from_iter(values), |row| {
                        let mut result = serde_json::Map::new();
                        for (i, name) in names.iter().enumerate() {
                            let value = match row.get_ref(i)? {
                                ValueRef::Null => Value::Null,
                                ValueRef::Integer(n) => json!(n),
                                ValueRef::Real(n) => json!(n),
                                ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                                ValueRef::Blob(b) => json!(b),
                            };
                            result.insert(name.clone(), value);
                        }
                        Ok(Value::Object(result))
                    })
                    .map_err(err)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(err)?;
                Ok(json!(rows))
            }
            "read_file" | "resolve_pdf_path" => {
                let path = Path::new(string(args, "path")?);
                let components = path.components().collect::<Vec<_>>();
                if components.len() != 2
                    || components[0] != Component::Normal("papers".as_ref())
                    || !matches!(components[1], Component::Normal(_))
                    || path.extension().and_then(|s| s.to_str()) != Some("pdf")
                {
                    return Err("Only papers/*.pdf may be read".into());
                }
                let file = self.data_dir.join(path);
                for p in [&papers, &file] {
                    let metadata = std::fs::symlink_metadata(p).map_err(err)?;
                    if metadata.file_type().is_symlink() {
                        return Err("Symbolic links are not allowed".into());
                    }
                }
                if !file.is_file() {
                    return Err("Expected a regular PDF file".into());
                }
                if command == "resolve_pdf_path" {
                    return Ok(json!(file));
                }
                Ok(json!(std::fs::read(file).map_err(err)?))
            }
            "import_pdf" => serde_json::to_value(
                crate::import_pdf_into_library_with_domain(
                    Path::new(string(args, "sourcePath")?),
                    &papers,
                    &database,
                    &uuid::Uuid::new_v4().to_string(),
                    now(),
                    optional(args, "domainId")?.as_deref(),
                )
                .map_err(err)?,
            )
            .map_err(err),
            "delete_paper" => {
                crate::delete_paper_from_library(&papers, &database, string(args, "paperId")?)
                    .map_err(err)?;
                Ok(Value::Null)
            }
            "reconcile_pdf_storage" => {
                crate::reconcile_paper_storage(&papers, &database).map_err(err)?;
                Ok(Value::Null)
            }
            "load_markdown_note" => Ok(json!(markdown_notes::load_note(
                &self.db,
                &papers,
                string(args, "paperId")?
            )?)),
            "save_markdown_note" => {
                let id = string(args, "paperId")?;
                let exists: bool = self
                    .db
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM papers WHERE id=?1)",
                        [id],
                        |r| r.get(0),
                    )
                    .map_err(err)?;
                if !exists {
                    return Err("Paper not found.".into());
                }
                markdown_notes::save_note(
                    &papers,
                    id,
                    string(args, "content")?,
                    string(args, "expected")?,
                )?;
                Ok(Value::Null)
            }
            "reveal_markdown_note" => {
                let path = markdown_notes::note_path(&papers, string(args, "paperId")?)?;
                if !path.is_file() {
                    return Err("Open the note first to create its Markdown file.".into());
                }
                Ok(json!(path))
            }
            "list_paper_web_chats" => {
                serde_json::to_value(web_chat::list_from_db(&self.db, string(args, "paperId")?)?)
                    .map_err(err)
            }
            "save_paper_web_chat" => serde_json::to_value(web_chat::save_in_db(
                &self.db,
                string(args, "paperId")?,
                optional(args, "id")?,
                string(args, "title")?,
                optional(args, "url")?,
            )?)
            .map_err(err),
            "get_paper_web_chat" | "capture_paper_web_chat" | "touch_paper_web_chat" => {
                let id = string(args, "id")?;
                if command == "capture_paper_web_chat" {
                    let url = string(args, "url")?;
                    let mut changed = web_chat::capture_in_db(&self.db, id, url)?;
                    if let Some(title) = optional(args, "title")? {
                        changed +=
                            web_chat::update_title(&self.db, id, url, &title).map_err(err)?;
                    }
                    if changed == 0 {
                        return Ok(Value::Null);
                    }
                } else if command == "touch_paper_web_chat" {
                    self.db
                        .execute(
                            "UPDATE paper_web_chats SET last_opened_at=?1 WHERE id=?2",
                            rusqlite::params![now(), id],
                        )
                        .map_err(err)?;
                }
                serde_json::to_value(web_chat::get_from_db(&self.db, id)?).map_err(err)
            }
            _ => Err(format!("Unknown command: {command}")),
        }
    }
}
