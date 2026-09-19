use paper_canvas_lib::backend::{migrate, Backend};
use serde_json::{json, Value};
use sqlx::Connection as _;
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Command, Stdio},
};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("paper-backend-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn upgrades_existing_sqlx_database_and_keeps_rollback_compatible() {
    let temp = Temp::new();
    let path = temp.0.join("papercanvas.db");
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true);
    let mut db = sqlx::SqliteConnection::connect_with(&options)
        .await
        .unwrap();
    let migrations = paper_canvas_lib::migrations()
        .into_iter()
        .take(9)
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
    sqlx::migrate::Migrator {
        migrations: migrations.into(),
        ..sqlx::migrate::Migrator::DEFAULT
    }
    .run(&mut db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO papers(id,title,file_path,created_at) VALUES('existing','Existing','papers/existing.pdf',1)").execute(&mut db).await.unwrap();
    db.close().await.unwrap();
    migrate(&path).await.unwrap();
    migrate(&path).await.unwrap();
    let backend = Backend::open(temp.0.clone()).await.unwrap();
    assert_eq!(
        backend
            .dispatch(
                "database_select",
                &json!({"query":"SELECT title FROM papers WHERE id=?","values":["existing"]})
            )
            .unwrap(),
        json!([{"title":"Existing"}])
    );
    assert_eq!(
        backend
            .dispatch(
                "database_select",
                &json!({"query":"SELECT count(*) AS n FROM _sqlx_migrations WHERE success=1"})
            )
            .unwrap(),
        json!([{"n":15}])
    );
}

#[test]
fn json_lines_bridge_import_notes_sql_and_safe_files() {
    let temp = Temp::new();
    let source = temp.0.join("source.pdf");
    std::fs::write(&source, b"%PDF-1.7\nfixture\n%%EOF").unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_paper-canvas-backend"))
        .args([
            "--data-dir",
            temp.0.to_str().unwrap(),
            "--resources",
            env!("CARGO_MANIFEST_DIR"),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut id = 0;
    let mut call = |command: &str, args: Value| {
        id += 1;
        writeln!(input, "{}", json!({"id":id,"command":command,"args":args})).unwrap();
        input.flush().unwrap();
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        let result: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(result["id"], id);
        result
    };
    assert!(call("database_load", json!({})).get("result").is_some());
    let paper = call("import_pdf", json!({"sourcePath":source}));
    assert!(paper.get("error").is_none(), "{paper}");
    let paper_id = paper["result"]["id"].as_str().unwrap();
    let file_path = paper["result"]["filePath"].as_str().unwrap();
    assert!(call("read_file", json!({"path":file_path}))["result"].is_array());
    assert_eq!(
        call("resolve_pdf_path", json!({"path":file_path}))["result"],
        json!(std::fs::canonicalize(&temp.0).unwrap().join(file_path))
    );
    for path in [
        "../source.pdf",
        "papers/../source.pdf",
        "/tmp/source.pdf",
        "papers/folder/a.pdf",
        "papers/source.md",
    ] {
        assert!(call("resolve_pdf_path", json!({"path":path}))
            .get("error")
            .is_some());
    }
    assert!(call("read_file", json!({"path":"papers/../source.pdf"}))
        .get("error")
        .is_some());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&source, temp.0.join("papers/link.pdf")).unwrap();
        assert!(call("read_file", json!({"path":"papers/link.pdf"}))
            .get("error")
            .is_some());
        assert!(call("resolve_pdf_path", json!({"path":"papers/link.pdf"}))
            .get("error")
            .is_some());
    }
    assert_eq!(
        call("load_markdown_note", json!({"paperId":paper_id}))["result"],
        ""
    );
    assert!(call(
        "save_markdown_note",
        json!({"paperId":paper_id,"content":"# note","expected":""})
    )
    .get("error")
    .is_none());
    assert_eq!(
        call("load_markdown_note", json!({"paperId":paper_id}))["result"],
        "# note"
    );
    assert_eq!(
        call(
            "save_markdown_note",
            json!({"paperId":paper_id,"content":"stale","expected":""})
        )["error"],
        "NOTE_FILE_CHANGED"
    );
    let updated = call(
        "database_execute",
        json!({"query":"UPDATE papers SET title=? WHERE id=?","values":["Renamed",paper_id]}),
    );
    assert_eq!(updated["result"]["rowsAffected"], 1);
    assert!(updated["result"]["lastInsertId"].is_number());
    assert_eq!(
        call(
            "database_select",
            json!({"query":"SELECT title FROM papers WHERE id=?","values":[paper_id]})
        )["result"],
        json!([{"title":"Renamed"}])
    );
    let chat = call(
        "save_paper_web_chat",
        json!({"paperId":paper_id,"title":"Discussion"}),
    );
    let chat_id = chat["result"]["id"].as_str().unwrap();
    let url = "https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174000";
    assert_eq!(
        call(
            "capture_paper_web_chat",
            json!({"id":chat_id,"url":url,"title":"Captured"})
        )["result"]["title"],
        "Captured"
    );
    assert_eq!(
        call(
            "capture_paper_web_chat",
            json!({"id":chat_id,"url":url,"title":"Captured"})
        )["result"],
        Value::Null
    );
    assert_eq!(
        call(
            "capture_paper_web_chat",
            json!({"id":chat_id,"url":"https://chatgpt.com/","title":"ChatGPT"})
        )["result"],
        Value::Null
    );
    assert!(call("touch_paper_web_chat", json!({"id":chat_id}))
        .get("error")
        .is_none());
    assert!(call("delete_paper", json!({"paperId":paper_id}))
        .get("error")
        .is_none());
    assert!(call("reconcile_pdf_storage", json!({}))
        .get("error")
        .is_none());
    assert_eq!(
        call("cancel_codex_turn", json!({"requestId":"bridge-cancel"}))["result"],
        true
    );
    assert!(call(
        "start_codex_turn",
        json!({"request":{"requestId":"invalid","prompt":"","model":"gpt-5.6-luna"}})
    )
    .get("error")
    .is_some());
    // A pre-cancelled turn exercises the real event channel without probing user auth.
    id += 1;
    writeln!(input, "{}", json!({"id":id,"command":"start_codex_turn","args":{"request":{"requestId":"bridge-cancel","prompt":"Cancelled","model":"gpt-5.6-luna"}}})).unwrap();
    input.flush().unwrap();
    let mut messages = Vec::new();
    for _ in 0..2 {
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        messages.push(serde_json::from_str::<Value>(&line).unwrap());
    }
    assert!(messages.contains(&json!({"event":"codex-stream","payload":{"requestId":"bridge-cancel","event":{"type":"interrupted"}}})));
    assert!(messages.contains(&json!({"id":id,"result":null})));
    drop(input);
    assert!(child.wait().unwrap().success());
}

#[tokio::test]
async fn resolver_large_synthetic_pdf_returns_only_path() {
    let temp = Temp::new();
    let backend = Backend::open(temp.0.clone()).await.unwrap();
    let papers = temp.0.join("papers");
    std::fs::create_dir(&papers).unwrap();
    let mut pdf = std::fs::File::create(papers.join("synthetic.pdf")).unwrap();
    pdf.write_all(b"%PDF-1.7\n").unwrap();
    pdf.set_len(32 * 1024 * 1024).unwrap();
    let started = std::time::Instant::now();
    for _ in 0..100 {
        let result = backend
            .dispatch("resolve_pdf_path", &json!({"path":"papers/synthetic.pdf"}))
            .unwrap();
        assert_eq!(
            result,
            json!(std::fs::canonicalize(&papers)
                .unwrap()
                .join("synthetic.pdf"))
        );
        assert!(serde_json::to_vec(&result).unwrap().len() < 1024);
    }
    eprintln!(
        "100 path resolutions for a temporary 32 MiB PDF: {:?}",
        started.elapsed()
    );
    #[cfg(unix)]
    {
        std::fs::rename(&papers, temp.0.join("real-papers")).unwrap();
        std::os::unix::fs::symlink(temp.0.join("real-papers"), &papers).unwrap();
        assert!(backend
            .dispatch("resolve_pdf_path", &json!({"path":"papers/synthetic.pdf"}))
            .is_err());
    }
}
