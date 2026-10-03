use paper_canvas_lib::backend::Backend;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};

const PDF: &[u8] = b"%PDF-1.7\nonline document\n%%EOF";
const URL: &str = "https://arxiv.org/pdf/2401.01234v2";

struct Fixture {
    backend: Backend,
    db: Connection,
    root: PathBuf,
}

impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!("online-pdf-{}", uuid::Uuid::new_v4()));
        let backend = Backend::open(root.join("data")).await.unwrap();
        let db = Connection::open(backend.data_dir.join("papercanvas.db")).unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        Self { backend, db, root }
    }

    fn workspace(&self, request: Value) -> Value {
        self.backend
            .dispatch("workspace_command", &json!({"request":request}))
            .unwrap()
    }

    fn import(&self, url: &str, arxiv_id: Option<&str>) -> String {
        let result = self.workspace(json!({"type":"import_research_batch","batch":{
            "requestId":uuid::Uuid::new_v4().to_string(),"title":"Online research",
            "papers":[{"ref":"a","title":"Original title","authors":"Author","year":2024,
                "url":url,"arxivId":arxiv_id,"abstract":"Abstract","reason":"Reason"}]
        }}));
        result["value"]["placements"][0]["paperId"]
            .as_str()
            .unwrap()
            .into()
    }

    fn paper(&self, id: &str) -> Value {
        self.workspace(json!({"type":"get_paper","id":id}))["value"].clone()
    }

    fn info(&self, id: &str) -> Value {
        self.backend
            .dispatch("online_pdf_info", &json!({"paperId":id}))
            .unwrap()
    }

    fn pin(&self, id: &str, url: &str, sha: &str) -> Result<Value, String> {
        self.backend.dispatch(
            "pin_online_pdf",
            &json!({"paperId":id,"url":url,"sha256":sha}),
        )
    }

    fn source(&self, bytes: &[u8]) -> PathBuf {
        let source = self.root.join("private.pdf");
        fs::write(&source, bytes).unwrap();
        source
    }

    fn save(
        &self,
        id: &str,
        source: &std::path::Path,
        url: &str,
        sha: &str,
    ) -> Result<Value, String> {
        self.backend.dispatch(
            "save_online_pdf",
            &json!({
                "paperId":id,"sourcePath":source,"url":url,"sha256":sha,
            }),
        )
    }

    fn papers(&self) -> PathBuf {
        self.backend.data_dir.join("papers")
    }

    fn annotate(&self, id: &str) {
        self.db
            .execute("INSERT INTO notes VALUES ('note',?1,'Keep note',1)", [id])
            .unwrap();
        self.db.execute("INSERT INTO pdf_highlights VALUES ('highlight',?1,3,'Keep selection','Keep comment','[]',1,1)",[id]).unwrap();
    }

    fn no_managed_files(&self) {
        assert!(!self.papers().exists() || fs::read_dir(self.papers()).unwrap().next().is_none());
    }

    fn reconcile(&self) {
        self.backend
            .dispatch("reconcile_pdf_storage", &json!({}))
            .unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

// Compare real SQLite rows, including revision, research undo snapshots and annotations.
fn snapshot(db: &Connection) -> Vec<(String, Vec<Vec<String>>)> {
    let tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .unwrap().query_map([], |r| r.get::<_, String>(0)).unwrap()
        .collect::<Result<Vec<_>,_>>().unwrap();
    tables
        .into_iter()
        .map(|name| {
            let mut stmt = db
                .prepare(&format!("SELECT * FROM \"{name}\" ORDER BY rowid"))
                .unwrap();
            let columns = stmt.column_count();
            let rows = stmt
                .query_map([], |row| {
                    (0..columns)
                        .map(|i| row.get_ref(i).map(|v| format!("{v:?}")))
                        .collect::<Result<Vec<_>, _>>()
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            (name, rows)
        })
        .collect()
}

#[tokio::test]
async fn info_is_read_only_and_reuses_research_arxiv_identity_and_versions() {
    for (source, arxiv, expected) in [
        ("https://arxiv.org/abs/2401.01234v2", None, URL),
        (
            "https://export.arxiv.org/pdf/2401.01234v2.pdf",
            Some("2401.01234"),
            URL,
        ),
        ("https://arxiv.org/abs/2401%2E01234v2", None, URL),
        (
            "https://example.org/paper",
            Some("arXiv:2401.01234v7"),
            "https://arxiv.org/pdf/2401.01234v7",
        ),
        (
            "https://www.arxiv.org/abs/hep-th/9901001v3",
            None,
            "https://arxiv.org/pdf/hep-th/9901001v3",
        ),
    ] {
        let f = Fixture::new().await;
        let id = f.import(source, arxiv);
        let before = snapshot(&f.db);
        let changes = f
            .backend
            .dispatch(
                "database_select",
                &json!({"query":"SELECT total_changes() AS n"}),
            )
            .unwrap();
        let expected = json!({"paperId":id,"url":expected,"sha256":null,"filePath":null});
        assert_eq!(f.info(&id), expected);
        assert_eq!(f.info(&id), expected);
        assert_eq!(snapshot(&f.db), before);
        assert_eq!(
            f.backend
                .dispatch(
                    "database_select",
                    &json!({"query":"SELECT total_changes() AS n"})
                )
                .unwrap(),
            changes
        );
        assert!(!f.papers().exists());
    }
    let f = Fixture::new().await;
    let id = f.import("https://example.org/paper", Some("2401.01234"));
    // A mismatched URL cannot override an explicit research identity.
    f.db.execute("UPDATE research_papers SET metadata=json_set(metadata,'$.url','https://arxiv.org/abs/2401.99999v8') WHERE paper_id=?1",[&id]).unwrap();
    assert_eq!(f.info(&id)["url"], "https://arxiv.org/pdf/2401.01234");
    let unrelated = f.import("https://example.org/arxiv/2401.01234", None);
    for id in [unrelated.as_str(), "paper-attention", "unknown"] {
        let before = snapshot(&f.db);
        assert!(f
            .backend
            .dispatch("online_pdf_info", &json!({"paperId":id}))
            .is_err());
        assert_eq!(snapshot(&f.db), before);
    }
    for command in ["online_pdf_info", "pin_online_pdf", "save_online_pdf"] {
        assert!(f
            .backend
            .dispatch(
                "workspace_command",
                &json!({"request":{"type":command,"paperId":id}})
            )
            .is_err());
    }
}

#[tokio::test]
async fn pin_preserves_board_undo_and_annotations_and_rejects_changed_documents() {
    let f = Fixture::new().await;
    let id = f.import("https://arxiv.org/abs/2401.01234v2", None);
    f.annotate(&id);
    let board = f.workspace(json!({"type":"load_board"}));
    let paper = f.paper(&id);
    let pinned = f.pin(&id, URL, &sha(PDF)).unwrap();
    assert_eq!(pinned["sha256"], sha(PDF));
    assert_eq!(f.info(&id), pinned);
    assert_eq!(f.paper(&id), paper);
    assert_eq!(f.workspace(json!({"type":"load_board"})), board);
    let before = snapshot(&f.db);
    assert_eq!(f.pin(&id, URL, &sha(PDF)).unwrap(), pinned);
    for (url, hash) in [
        (URL, sha(b"new version")),
        ("https://arxiv.org/pdf/2401.01234v3", sha(PDF)),
        ("https://arxiv.org/pdf/2401.01234", sha(PDF)),
        ("https://arxiv.org/pdf/2401.99999v2", sha(PDF)),
        ("https://evil.test/pdf/2401.01234v2", sha(PDF)),
    ] {
        assert_eq!(f.pin(&id, url, &hash).unwrap_err(), "ONLINE_PDF_CHANGED");
        assert_eq!(snapshot(&f.db), before);
    }
    assert!(!f.papers().exists());
    // First viewing does not invalidate the original research undo snapshot.
    f.workspace(json!({"type":"undo_research_batch","batchId":paper["research"]["batchId"]}));
    assert_eq!(f.paper(&id), paper);
    assert_eq!(
        f.db.query_row("SELECT selected_text FROM pdf_highlights", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "Keep selection"
    );
    f.backend
        .dispatch("delete_paper", &json!({"paperId":id}))
        .unwrap();
    assert_eq!(
        f.db.query_row("SELECT count(*) FROM paper_pdf_documents", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn first_pin_requires_canonical_same_identity_and_respects_explicit_version() {
    let f = Fixture::new().await;
    let id = f.import("https://arxiv.org/abs/2401.01234v2", None);
    let before = snapshot(&f.db);
    for url in [
        "https://arxiv.org/pdf/2401.01234v3",
        "https://arxiv.org/pdf/2401.01234",
        "https://arxiv.org/pdf/2401.99999v2",
        "https://arxiv.org/abs/2401.01234v2",
        "http://arxiv.org/pdf/2401.01234v2",
        "https://arxiv.org@evil.test/pdf/2401.01234v2",
        "https://arxiv.org/pdf/2401.01234v2?x=1",
        "https://arxiv.org:99/pdf/2401.01234v2",
        "https://arxiv.org/pdf/2401.01234v0",
    ] {
        assert_eq!(
            f.pin(&id, url, &sha(PDF)).unwrap_err(),
            "ONLINE_PDF_CHANGED"
        );
        assert_eq!(snapshot(&f.db), before);
    }
    for hash in [
        "A".repeat(64),
        "g".repeat(64),
        "a".repeat(63),
        "a".repeat(65),
    ] {
        assert!(f.pin(&id, URL, &hash).is_err());
        assert_eq!(snapshot(&f.db), before);
    }
    let f = Fixture::new().await;
    let id = f.import("https://arxiv.org/abs/2401.01234", None);
    let pinned = f.pin(&id, URL, &sha(PDF)).unwrap();
    // The initial unversioned URL may redirect once; later metadata cannot switch it.
    f.db.execute("UPDATE research_papers SET metadata=json_set(metadata,'$.url','https://arxiv.org/abs/2401.01234v8') WHERE paper_id=?1",[&id]).unwrap();
    assert_eq!(f.info(&id), pinned);
    assert_eq!(f.pin(&id, URL, &sha(PDF)).unwrap(), pinned);
}

#[tokio::test]
async fn saving_attaches_same_paper_preserves_metadata_and_is_idempotent() {
    let f = Fixture::new().await;
    let id = f.import("https://arxiv.org/abs/2401.01234v2", None);
    let domain = f.workspace(json!({"type":"create_domain","name":"Existing domain"}));
    f.workspace(json!({"type":"assign_paper","paperId":id,"domainId":domain["value"]["id"]}));
    f.workspace(json!({"type":"update_paper_title","paperId":id,"title":"User title"}));
    f.annotate(&id);
    let mut expected = f.paper(&id);
    f.pin(&id, URL, &sha(PDF)).unwrap();
    let source = f.source(PDF);
    let result = f.save(&id, &source, URL, &sha(PDF)).unwrap();
    expected["filePath"] = json!(format!("papers/{id}.pdf"));
    assert_eq!(result, expected);
    assert_eq!(f.paper(&id), expected);
    let managed = f
        .backend
        .data_dir
        .join(result["filePath"].as_str().unwrap());
    assert_eq!(fs::read(&managed).unwrap(), PDF);
    assert_eq!(
        fs::read(&source).unwrap(),
        PDF,
        "caller owns its temporary file"
    );
    let before = snapshot(&f.db);
    let modified = fs::metadata(&managed).unwrap().modified().unwrap();
    #[cfg(unix)]
    let inode = {
        use std::os::unix::fs::MetadataExt;
        fs::metadata(&managed).unwrap().ino()
    };
    assert_eq!(f.save(&id, &source, URL, &sha(PDF)).unwrap(), expected);
    assert_eq!(snapshot(&f.db), before);
    assert_eq!(
        fs::metadata(&managed).unwrap().modified().unwrap(),
        modified
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(fs::metadata(&managed).unwrap().ino(), inode);
    }
    f.reconcile();
    assert_eq!(snapshot(&f.db), before);
    assert_eq!(fs::read(&managed).unwrap(), PDF);
    assert_eq!(fs::read_dir(f.papers()).unwrap().count(), 1);
    assert_eq!(f.info(&id)["filePath"], expected["filePath"]);
}

#[tokio::test]
async fn saves_reject_unknown_unpinned_changed_invalid_and_oversized_sources_without_mutation() {
    let f = Fixture::new().await;
    let id = f.import("https://arxiv.org/abs/2401.01234v2", None);
    let source = f.source(PDF);
    let before = snapshot(&f.db);
    for target in ["unknown", id.as_str()] {
        assert!(f.save(target, &source, URL, &sha(PDF)).is_err());
        assert_eq!(snapshot(&f.db), before);
        f.no_managed_files();
    }
    f.pin(&id, URL, &sha(PDF)).unwrap();
    f.annotate(&id);
    let before = snapshot(&f.db);
    for bytes in [
        b"%PDF-1.7\na different revision".as_slice(),
        b"<html>not a PDF</html>",
        b"",
    ] {
        let source = f.source(bytes);
        assert!(f.save(&id, &source, URL, &sha(PDF)).is_err());
        assert_eq!(snapshot(&f.db), before);
        f.no_managed_files();
    }
    let source = f.source(PDF);
    fs::OpenOptions::new()
        .write(true)
        .open(&source)
        .unwrap()
        .set_len(250 * 1024 * 1024 + 1)
        .unwrap();
    assert!(f
        .save(&id, &source, URL, &sha(PDF))
        .unwrap_err()
        .contains("250 MB"));
    assert_eq!(snapshot(&f.db), before);
    f.no_managed_files();
}

#[tokio::test]
async fn existing_local_files_and_destination_entries_are_never_overwritten() {
    for already_attached in [false, true] {
        let f = Fixture::new().await;
        let id = f.import("https://arxiv.org/abs/2401.01234v2", None);
        f.pin(&id, URL, &sha(PDF)).unwrap();
        let source = f.source(PDF);
        fs::create_dir(f.papers()).unwrap();
        let target = f.papers().join(format!("{id}.pdf"));
        let existing = b"%PDF-1.7\nexisting local document";
        fs::write(&target, existing).unwrap();
        if already_attached {
            f.db.execute(
                "UPDATE papers SET file_path=?1 WHERE id=?2",
                params![format!("papers/{id}.pdf"), id],
            )
            .unwrap();
        }
        let before = snapshot(&f.db);
        assert!(f.save(&id, &source, URL, &sha(PDF)).is_err());
        assert_eq!(snapshot(&f.db), before);
        assert_eq!(fs::read(&target).unwrap(), existing);
        assert_eq!(fs::read_dir(f.papers()).unwrap().count(), 1);
    }
    let f = Fixture::new().await;
    let source = f.source(PDF);
    let imported = f
        .backend
        .dispatch("import_pdf", &json!({"sourcePath":source}))
        .unwrap();
    let id = imported["id"].as_str().unwrap();
    f.db.execute(
        "INSERT INTO research_identities VALUES ('arxiv','2401.01234',?1)",
        [id],
    )
    .unwrap();
    assert_eq!(f.import("https://arxiv.org/abs/2401.01234v2", None), id);
    let before = snapshot(&f.db);
    assert!(f.pin(id, URL, &sha(PDF)).is_err());
    assert!(f.save(id, &source, URL, &sha(PDF)).is_err());
    assert_eq!(snapshot(&f.db), before);
    assert_eq!(
        fs::read(
            f.backend
                .data_dir
                .join(imported["filePath"].as_str().unwrap())
        )
        .unwrap(),
        PDF
    );
}

#[tokio::test]
async fn sql_update_and_deferred_commit_failures_compensate_attached_files() {
    for commit_failure in [false, true] {
        let f = Fixture::new().await;
        let id = f.import("https://arxiv.org/abs/2401.01234v2", None);
        f.pin(&id, URL, &sha(PDF)).unwrap();
        f.annotate(&id);
        if commit_failure {
            f.db.execute_batch("CREATE TABLE attach_guard (paper_id TEXT REFERENCES papers(id) DEFERRABLE INITIALLY DEFERRED);
                CREATE TRIGGER reject_attach AFTER UPDATE OF file_path ON papers BEGIN INSERT INTO attach_guard VALUES ('missing'); END;").unwrap();
        } else {
            f.db.execute_batch("CREATE TRIGGER reject_attach BEFORE UPDATE OF file_path ON papers BEGIN SELECT RAISE(ABORT,'reject attachment'); END;").unwrap();
        }
        let before = snapshot(&f.db);
        assert!(f.save(&id, &f.source(PDF), URL, &sha(PDF)).is_err());
        assert_eq!(snapshot(&f.db), before);
        f.no_managed_files();
        f.reconcile();
        assert_eq!(snapshot(&f.db), before);
        f.db.execute_batch("DROP TRIGGER reject_attach").unwrap();
        assert!(f.save(&id, &f.source(PDF), URL, &sha(PDF)).is_ok());
    }
}

#[tokio::test]
async fn reconcile_recovers_interrupted_attach_and_delete_preserving_pins_and_notes() {
    for legacy_id in [false, true] {
        let f = Fixture::new().await;
        if legacy_id {
            f.db.execute_batch(
                "INSERT INTO research_identities VALUES ('arxiv','2401.01234','paper-attention')",
            )
            .unwrap();
        }
        let id = f.import("https://arxiv.org/abs/2401.01234v2", None);
        f.pin(&id, URL, &sha(PDF)).unwrap();
        f.annotate(&id);
        fs::create_dir(f.papers()).unwrap();
        let managed = f.papers().join(format!("{id}.pdf"));
        let tombstone = f.papers().join(format!(".{id}.pdf.delete"));
        let partial = f
            .papers()
            .join(format!(".{}.pdf.part", uuid::Uuid::new_v4()));
        let before = snapshot(&f.db);
        // Crash after copy but before commit, and crash during compensation.
        for artifact in [&partial, &managed, &tombstone] {
            fs::write(artifact, PDF).unwrap();
            f.reconcile();
            f.no_managed_files();
            assert_eq!(snapshot(&f.db), before);
        }
        f.save(&id, &f.source(PDF), URL, &sha(PDF)).unwrap();
        let saved = snapshot(&f.db);
        fs::rename(&managed, &tombstone).unwrap();
        f.reconcile();
        assert_eq!(fs::read(&managed).unwrap(), PDF);
        assert!(!tombstone.exists());
        assert_eq!(snapshot(&f.db), saved);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn symlinked_destination_or_directory_is_rejected_without_touching_target() {
    for directory in [false, true] {
        let f = Fixture::new().await;
        let id = f.import("https://arxiv.org/abs/2401.01234v2", None);
        f.pin(&id, URL, &sha(PDF)).unwrap();
        let source = f.source(PDF);
        let outside = f.root.join("outside");
        fs::create_dir(&outside).unwrap();
        let target = outside.join("untouched.pdf");
        fs::write(&target, b"keep").unwrap();
        if directory {
            std::os::unix::fs::symlink(&outside, f.papers()).unwrap();
        } else {
            fs::create_dir(f.papers()).unwrap();
            std::os::unix::fs::symlink(&target, f.papers().join(format!("{id}.pdf"))).unwrap();
        }
        let before = snapshot(&f.db);
        assert!(f.save(&id, &source, URL, &sha(PDF)).is_err());
        assert_eq!(snapshot(&f.db), before);
        assert_eq!(fs::read(&target).unwrap(), b"keep");
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
    }
}

#[tokio::test]
async fn save_opens_and_validates_source_only_after_acquiring_database_lock() {
    let f = Fixture::new().await;
    let id = f.import("https://arxiv.org/abs/2401.01234v2", None);
    f.pin(&id, URL, &sha(PDF)).unwrap();
    let source = f.source(PDF);
    // Open a second trusted transport before taking the lock.
    let backend = Backend::open(f.backend.data_dir.clone()).await.unwrap();
    f.db.execute_batch("BEGIN IMMEDIATE").unwrap();
    let worker_source = source.clone();
    let worker_id = id.clone();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let worker_barrier = barrier.clone();
    let worker = std::thread::spawn(move || {
        worker_barrier.wait();
        backend.dispatch(
            "save_online_pdf",
            &json!({"paperId":worker_id,"sourcePath":worker_source,"url":URL,"sha256":sha(PDF)}),
        )
    });
    barrier.wait();
    std::thread::sleep(std::time::Duration::from_millis(150));
    f.no_managed_files();
    fs::rename(&source, f.root.join("original.pdf")).unwrap();
    fs::write(&source, b"%PDF-1.7\nreplacement").unwrap();
    f.db.execute_batch("COMMIT").unwrap();
    let before = snapshot(&f.db);
    assert_eq!(worker.join().unwrap().unwrap_err(), "ONLINE_PDF_CHANGED");
    assert_eq!(snapshot(&f.db), before);
    f.no_managed_files();
}
