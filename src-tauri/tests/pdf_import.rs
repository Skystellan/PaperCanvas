use paper_canvas_lib::{
    delete_paper_from_library, edge_migration_sql, import_pdf_into_library,
    import_pdf_into_library_with_domain, initial_migration_sql, library_migration_sql,
    note_migration_sql, paper_domains_migration_sql, reconcile_paper_storage,
};
use rusqlite::{params, Connection};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Barrier},
    thread,
    time::Duration,
};
use uuid::Uuid;

struct TestWorkspace {
    root: PathBuf,
    database: PathBuf,
    papers: PathBuf,
}

impl TestWorkspace {
    fn new(label: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("papercanvas-import-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("workspace should be created");
        let database = root.join("papercanvas.db");
        let papers = root.join("papers");
        let connection = Connection::open(&database).expect("database should open");
        connection
            .execute_batch(initial_migration_sql())
            .expect("V0 migration should apply");
        connection
            .execute_batch(library_migration_sql())
            .expect("library migration should apply");
        connection
            .execute_batch(note_migration_sql())
            .expect("note migration should apply");
        connection
            .execute_batch(edge_migration_sql())
            .expect("edge migration should apply");
        connection
            .execute_batch(paper_domains_migration_sql())
            .expect("paper domain migration should apply");
        drop(connection);
        Self {
            root,
            database,
            papers,
        }
    }

    fn source(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.root.join(name);
        fs::write(&path, bytes).expect("source fixture should be written");
        path
    }

    fn insert_paper(&self, id: &str, file_path: Option<&str>) {
        let connection = Connection::open(&self.database).expect("database should reopen");
        connection
            .execute(
                "INSERT INTO papers
                 (id, title, authors, year, file_path, created_at)
                 VALUES (?1, ?2, NULL, NULL, ?3, 1)",
                params![id, format!("Fixture {id}"), file_path],
            )
            .expect("paper fixture should be inserted");
    }

    fn paper_exists(&self, id: &str) -> bool {
        let connection = Connection::open(&self.database).expect("database should reopen");
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM papers WHERE id = ?1)",
                [id],
                |row| row.get(0),
            )
            .expect("paper existence should be queryable")
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn valid_pdf_is_copied_and_inserted_without_removing_the_source() {
    let workspace = TestWorkspace::new("valid");
    let source = workspace.source("A Reliable Paper.pdf", b"%PDF-1.7\nfixture\n%%EOF");

    let imported = import_pdf_into_library(
        &source,
        &workspace.papers,
        &workspace.database,
        "10886c1e-cac4-486c-9877-e32e5e85bb9c",
        1_700_000_000_000,
    )
    .expect("valid PDF should import");

    assert_eq!(imported.id, "10886c1e-cac4-486c-9877-e32e5e85bb9c");
    assert_eq!(imported.title, "A Reliable Paper");
    assert_eq!(imported.authors, None);
    assert_eq!(imported.year, None);
    assert_eq!(imported.domain_id, None);
    assert_eq!(
        imported.file_path,
        "papers/10886c1e-cac4-486c-9877-e32e5e85bb9c.pdf"
    );
    assert!(source.exists(), "import must copy rather than move");
    assert_eq!(
        fs::read(
            workspace
                .papers
                .join("10886c1e-cac4-486c-9877-e32e5e85bb9c.pdf")
        )
        .expect("managed PDF should exist"),
        b"%PDF-1.7\nfixture\n%%EOF"
    );

    let connection = Connection::open(&workspace.database).expect("database should reopen");
    let row: (String, String, Option<String>, Option<i64>, String, i64) = connection
        .query_row(
            "SELECT id, title, authors, year, file_path, created_at FROM papers WHERE id = ?1",
            [&imported.id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .expect("paper row should exist");
    assert_eq!(
        row,
        (
            imported.id,
            "A Reliable Paper".to_string(),
            None,
            None,
            imported.file_path,
            1_700_000_000_000,
        )
    );
}

#[test]
fn import_assigns_an_existing_domain_and_compensates_an_unknown_domain() {
    let workspace = TestWorkspace::new("domain-assignment");
    let connection = Connection::open(&workspace.database).expect("database should reopen");
    connection
        .execute(
            "INSERT INTO paper_domains (id, name, created_at, updated_at)
             VALUES ('domain-ai', 'AI', 1, 1)",
            [],
        )
        .expect("domain fixture should insert");
    drop(connection);

    let accepted_source = workspace.source("Accepted.pdf", b"%PDF-1.7\nfixture");
    let accepted_id = "09168d11-c945-4386-bda4-e7d47b906ef0";
    let imported = import_pdf_into_library_with_domain(
        &accepted_source,
        &workspace.papers,
        &workspace.database,
        accepted_id,
        10,
        Some("domain-ai"),
    )
    .expect("known domain import should succeed");
    assert_eq!(imported.domain_id.as_deref(), Some("domain-ai"));
    let connection = Connection::open(&workspace.database).expect("database should reopen");
    let stored_domain: Option<String> = connection
        .query_row(
            "SELECT domain_id FROM papers WHERE id = ?1",
            [accepted_id],
            |row| row.get(0),
        )
        .expect("imported domain assignment should be stored");
    assert_eq!(stored_domain.as_deref(), Some("domain-ai"));
    drop(connection);

    let rejected_source = workspace.source("Rejected Domain.pdf", b"%PDF-1.7\nfixture");
    let rejected_id = "55470cf0-a7c5-4f70-a9b2-3708a6f867a5";
    assert!(import_pdf_into_library_with_domain(
        &rejected_source,
        &workspace.papers,
        &workspace.database,
        rejected_id,
        11,
        Some("missing-domain"),
    )
    .is_err());
    assert!(
        !workspace.papers.join(format!("{rejected_id}.pdf")).exists(),
        "a rejected foreign key must not leave a managed file"
    );
    assert!(!workspace.paper_exists(rejected_id));
}

#[test]
fn invalid_files_and_unsafe_ids_leave_no_rows_or_managed_files() {
    for (label, name, bytes, id) in [
        (
            "extension",
            "not-a-pdf.txt",
            b"%PDF-1.7".as_slice(),
            "b064647d-9d5f-48b4-b8f8-70120bf45c08",
        ),
        (
            "signature",
            "fake.pdf",
            b"plain text".as_slice(),
            "ff3da75a-4f84-44f0-803b-cfd2f9c9be83",
        ),
        (
            "empty",
            "empty.pdf",
            b"".as_slice(),
            "1a51615c-3110-45d4-9842-68051e24e959",
        ),
        (
            "unsafe-id",
            "valid.pdf",
            b"%PDF-1.7".as_slice(),
            "../escape",
        ),
    ] {
        let workspace = TestWorkspace::new(label);
        let source = workspace.source(name, bytes);

        assert!(
            import_pdf_into_library(&source, &workspace.papers, &workspace.database, id, 1,)
                .is_err(),
            "{label} should fail"
        );

        let connection = Connection::open(&workspace.database).expect("database should reopen");
        let imported_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM papers WHERE file_path IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .expect("paper count should be queryable");
        assert_eq!(imported_count, 0);
        assert!(
            !workspace.papers.exists()
                || fs::read_dir(&workspace.papers)
                    .expect("papers directory should be readable")
                    .next()
                    .is_none(),
            "{label} must not leave a managed file"
        );
    }
}

#[test]
fn hostile_unicode_filename_is_data_and_database_failure_is_compensated() {
    let workspace = TestWorkspace::new("hostile");
    let source = workspace.source("多模态 '; DROP TABLE papers; --.pdf", b"%PDF-1.7\nfixture");
    let id = "dc49f415-1ce0-4245-9fb8-b4d05de50029";
    let imported = import_pdf_into_library(&source, &workspace.papers, &workspace.database, id, 2)
        .expect("hostile filename should import as plain text");
    assert_eq!(imported.title, "多模态 '; DROP TABLE papers; --");
    let connection = Connection::open(&workspace.database).expect("database should reopen");
    let table_exists: i64 = connection
        .query_row("SELECT COUNT(*) FROM papers", [], |row| row.get(0))
        .expect("papers table should still exist");
    assert_eq!(table_exists, 4);
    drop(connection);

    let rejected_source = workspace.source("Rejected.pdf", b"%PDF-1.7\nfixture");
    let blocked_id = "09c9e1e3-34c0-4aa5-a9f3-c27d4d84e234";
    let connection = Connection::open(&workspace.database).expect("database should reopen");
    connection
        .execute_batch(&format!(
            "CREATE TRIGGER reject_test_import
             BEFORE INSERT ON papers
             WHEN NEW.id = '{blocked_id}'
             BEGIN
               SELECT RAISE(ABORT, 'blocked');
             END;"
        ))
        .expect("failure trigger should install");
    drop(connection);

    assert!(import_pdf_into_library(
        &rejected_source,
        &workspace.papers,
        &workspace.database,
        blocked_id,
        3,
    )
    .is_err());
    assert!(!workspace.papers.join(format!("{blocked_id}.pdf")).exists());
}

#[test]
fn deleting_an_import_removes_only_the_app_data_copy_and_database_row() {
    let workspace = TestWorkspace::new("delete-managed-copy");
    let source = workspace.source("Keep Original.pdf", b"%PDF-1.7\nfixture\n%%EOF");
    let source_bytes = fs::read(&source).expect("source fixture should be readable");
    let id = "965307a6-400b-4864-ae20-e237dab39b75";
    let imported = import_pdf_into_library(
        &source,
        &workspace.papers,
        &workspace.database,
        id,
        1_700_000_000_000,
    )
    .expect("valid PDF should import");
    let managed_copy = workspace.papers.join(format!("{id}.pdf"));
    assert!(managed_copy.exists());

    delete_paper_from_library(&workspace.papers, &workspace.database, &imported.id)
        .expect("managed paper should delete");

    assert!(!managed_copy.exists(), "the AppData copy should be removed");
    assert_eq!(
        fs::read(&source).expect("the original source should remain readable"),
        source_bytes,
        "deleting from the library must never remove or rewrite the source"
    );
    assert!(!workspace.paper_exists(id));
}

#[test]
fn deletion_rejects_unsafe_ids_and_non_managed_file_paths_without_mutation() {
    let workspace = TestWorkspace::new("delete-path-validation");

    let unsafe_id = "../escape";
    let escaped_file = workspace.source("escape.pdf", b"%PDF-1.7\noutside AppData papers");
    workspace.insert_paper(unsafe_id, Some("papers/../escape.pdf"));

    assert!(
        delete_paper_from_library(&workspace.papers, &workspace.database, unsafe_id).is_err(),
        "path separators in a paper id must be rejected"
    );
    assert!(workspace.paper_exists(unsafe_id));
    assert!(
        escaped_file.exists(),
        "an escaped path must never be removed"
    );

    let forged_id = "93d5ddaa-f12d-42ee-93b4-12ac052a6cd0";
    let original_source = workspace.source("external-source.pdf", b"%PDF-1.7\noriginal");
    workspace.insert_paper(forged_id, Some("../external-source.pdf"));

    assert!(
        delete_paper_from_library(&workspace.papers, &workspace.database, forged_id).is_err(),
        "a database path outside papers/<id>.pdf must be rejected"
    );
    assert!(workspace.paper_exists(forged_id));
    assert!(
        original_source.exists(),
        "a forged database path must not delete an external source"
    );
}

#[test]
fn deletion_supports_legacy_rows_and_missing_managed_files() {
    let workspace = TestWorkspace::new("delete-legacy-and-missing");

    delete_paper_from_library(&workspace.papers, &workspace.database, "paper-attention")
        .expect("a legacy paper without a managed PDF should delete");
    assert!(!workspace.paper_exists("paper-attention"));
    let connection = Connection::open(&workspace.database).expect("database should reopen");
    let legacy_node_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM board_nodes WHERE paper_id = 'paper-attention'",
            [],
            |row| row.get(0),
        )
        .expect("legacy canvas references should be queryable");
    assert_eq!(
        legacy_node_count, 0,
        "foreign-key dependents should cascade with the paper"
    );
    drop(connection);

    let missing_id = "62b9e2bf-bf8c-4c90-823e-cf01816c11f3";
    let missing_relative_path = format!("papers/{missing_id}.pdf");
    workspace.insert_paper(missing_id, Some(&missing_relative_path));
    assert!(!workspace.papers.join(format!("{missing_id}.pdf")).exists());

    delete_paper_from_library(&workspace.papers, &workspace.database, missing_id)
        .expect("an already-missing managed file should not block row deletion");
    assert!(!workspace.paper_exists(missing_id));
}

#[test]
fn deletion_restores_the_managed_pdf_when_database_commit_fails() {
    let workspace = TestWorkspace::new("delete-commit-failure");
    let source = workspace.source("Commit Guard.pdf", b"%PDF-1.7\nfixture\n%%EOF");
    let id = "9208e8ae-b93a-48c5-b9a3-23fcab97bd8d";
    import_pdf_into_library(&source, &workspace.papers, &workspace.database, id, 4)
        .expect("valid PDF should import");
    let managed_copy = workspace.papers.join(format!("{id}.pdf"));
    let managed_bytes = fs::read(&managed_copy).expect("managed fixture should be readable");

    let connection = Connection::open(&workspace.database).expect("database should reopen");
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE deferred_delete_guard (
               paper_id TEXT NOT NULL,
               FOREIGN KEY (paper_id) REFERENCES papers(id)
                 DEFERRABLE INITIALLY DEFERRED
             );",
        )
        .expect("deferred commit guard should be created");
    connection
        .execute(
            "INSERT INTO deferred_delete_guard (paper_id) VALUES (?1)",
            [id],
        )
        .expect("commit guard should reference the paper");
    drop(connection);

    assert!(
        delete_paper_from_library(&workspace.papers, &workspace.database, id).is_err(),
        "the deferred foreign key should reject commit"
    );

    assert!(
        workspace.paper_exists(id),
        "the database row should roll back"
    );
    assert_eq!(
        fs::read(&managed_copy).expect("managed PDF should be restored"),
        managed_bytes
    );
}

#[test]
fn deletion_recovers_a_preexisting_tombstone_before_retrying() {
    let workspace = TestWorkspace::new("delete-preexisting-tombstone");
    let source = workspace.source("Interrupted Delete.pdf", b"%PDF-1.7\nfixture\n%%EOF");
    let source_bytes = fs::read(&source).expect("source fixture should be readable");
    let id = "1f4af655-f27c-4806-94ea-20f474603a20";
    import_pdf_into_library(&source, &workspace.papers, &workspace.database, id, 5)
        .expect("valid PDF should import");
    let managed_copy = workspace.papers.join(format!("{id}.pdf"));
    let tombstone = workspace.papers.join(format!(".{id}.pdf.delete"));
    fs::rename(&managed_copy, &tombstone).expect("interrupted deletion should be staged");

    delete_paper_from_library(&workspace.papers, &workspace.database, id)
        .expect("a staged deletion with a live row should recover and retry");

    assert!(!workspace.paper_exists(id));
    assert!(!managed_copy.exists());
    assert!(!tombstone.exists());
    assert_eq!(
        fs::read(&source).expect("original source should remain"),
        source_bytes
    );
}

#[test]
fn deletion_acquires_the_database_write_lock_before_staging_the_pdf() {
    let workspace = TestWorkspace::new("delete-write-lock-order");
    let source = workspace.source("Serialized Delete.pdf", b"%PDF-1.7\nfixture\n%%EOF");
    let id = "47163eb0-d8bc-44ac-9717-029db2e37865";
    import_pdf_into_library(&source, &workspace.papers, &workspace.database, id, 5)
        .expect("valid PDF should import");
    let managed = workspace.papers.join(format!("{id}.pdf"));
    let tombstone = workspace.papers.join(format!(".{id}.pdf.delete"));

    let blocker = Connection::open(&workspace.database).expect("blocker database should open");
    blocker
        .execute_batch("BEGIN IMMEDIATE")
        .expect("write lock should be held");
    let barrier = Arc::new(Barrier::new(2));
    let worker_barrier = Arc::clone(&barrier);
    let papers = workspace.papers.clone();
    let database = workspace.database.clone();
    let worker = thread::spawn(move || {
        worker_barrier.wait();
        delete_paper_from_library(&papers, &database, id)
    });
    barrier.wait();
    thread::sleep(Duration::from_millis(150));
    let stayed_live_while_locked = managed.exists() && !tombstone.exists();

    blocker
        .execute_batch("COMMIT")
        .expect("write lock should release");
    let delete_result = worker.join().expect("delete worker should not panic");

    assert!(
        stayed_live_while_locked,
        "the PDF must remain live until deletion owns the database write lock"
    );
    delete_result.expect("delete should finish after the lock releases");
}

#[test]
fn import_acquires_the_database_write_lock_before_copying_the_pdf() {
    let workspace = TestWorkspace::new("import-write-lock-order");
    let source = workspace.source("Serialized Import.pdf", b"%PDF-1.7\nfixture\n%%EOF");
    let id = "e0c4e30a-f95c-4fd1-b020-75891657f015";
    let managed = workspace.papers.join(format!("{id}.pdf"));
    let partial = workspace.papers.join(format!(".{id}.pdf.part"));

    let blocker = Connection::open(&workspace.database).expect("blocker database should open");
    blocker
        .execute_batch("BEGIN IMMEDIATE")
        .expect("write lock should be held");
    let barrier = Arc::new(Barrier::new(2));
    let worker_barrier = Arc::clone(&barrier);
    let papers = workspace.papers.clone();
    let database = workspace.database.clone();
    let worker = thread::spawn(move || {
        worker_barrier.wait();
        import_pdf_into_library(&source, &papers, &database, id, 8)
    });
    barrier.wait();
    thread::sleep(Duration::from_millis(150));
    let copied_while_locked = managed.exists() || partial.exists();

    blocker
        .execute_batch("COMMIT")
        .expect("write lock should release");
    let import_result = worker.join().expect("import worker should not panic");

    assert!(
        !copied_while_locked,
        "an import must own the database write lock before creating managed files"
    );
    import_result.expect("import should finish after the lock releases");
    assert!(managed.exists());
    assert!(workspace.paper_exists(id));
}

#[test]
fn reconciliation_acquires_the_database_write_lock_before_restoring_a_tombstone() {
    let workspace = TestWorkspace::new("reconcile-write-lock-order");
    let source = workspace.source("Serialized Recovery.pdf", b"%PDF-1.7\nfixture\n%%EOF");
    let id = "15c402d9-ea9d-4115-8c7a-45513248d6e6";
    import_pdf_into_library(&source, &workspace.papers, &workspace.database, id, 6)
        .expect("valid PDF should import");
    let managed = workspace.papers.join(format!("{id}.pdf"));
    let tombstone = workspace.papers.join(format!(".{id}.pdf.delete"));
    fs::rename(&managed, &tombstone).expect("interrupted deletion should be staged");

    let blocker = Connection::open(&workspace.database).expect("blocker database should open");
    blocker
        .execute_batch("BEGIN IMMEDIATE")
        .expect("write lock should be held");
    let barrier = Arc::new(Barrier::new(2));
    let worker_barrier = Arc::clone(&barrier);
    let papers = workspace.papers.clone();
    let database = workspace.database.clone();
    let worker = thread::spawn(move || {
        worker_barrier.wait();
        reconcile_paper_storage(&papers, &database)
    });
    barrier.wait();
    thread::sleep(Duration::from_millis(150));
    let stayed_staged_while_locked = tombstone.exists() && !managed.exists();

    blocker
        .execute_batch("COMMIT")
        .expect("write lock should release");
    let reconcile_result = worker.join().expect("reconcile worker should not panic");

    assert!(
        stayed_staged_while_locked,
        "reconciliation must wait for the database write lock before touching tombstones"
    );
    reconcile_result.expect("reconciliation should finish after the lock releases");
    assert!(managed.exists());
    assert!(!tombstone.exists());
}

#[test]
fn reconciliation_removes_only_orphaned_managed_tombstones() {
    let workspace = TestWorkspace::new("reconcile-orphan-tombstone");
    fs::create_dir_all(&workspace.papers).expect("papers directory should exist");
    let id = "27756835-645e-4acf-8c22-ff3d5b74786c";
    let tombstone = workspace.papers.join(format!(".{id}.pdf.delete"));
    fs::write(&tombstone, b"%PDF-1.7\norphan").expect("orphan tombstone should exist");
    let original_source = workspace.source("Original Source.pdf", b"%PDF-1.7\noriginal");

    reconcile_paper_storage(&workspace.papers, &workspace.database)
        .expect("orphaned managed tombstones should be reconciled");

    assert!(!tombstone.exists());
    assert_eq!(
        fs::read(&original_source).expect("original source should remain"),
        b"%PDF-1.7\noriginal"
    );
}

#[test]
fn reconciliation_removes_only_canonical_crashed_import_partials() {
    let workspace = TestWorkspace::new("reconcile-import-partial");
    fs::create_dir_all(&workspace.papers).expect("papers directory should exist");
    let id = "e0c4e30a-f95c-4fd1-b020-75891657f015";
    let partial = workspace.papers.join(format!(".{id}.pdf.part"));
    let noncanonical_lookalike = workspace
        .papers
        .join(".e0c4e30af95c4fd1b02075891657f015.pdf.part");
    let named_lookalike = workspace.papers.join(".manual-reference.pdf.part");
    fs::write(&partial, b"interrupted managed copy").expect("partial should exist");
    fs::write(&noncanonical_lookalike, b"user lookalike").expect("lookalike should exist");
    fs::write(&named_lookalike, b"user named file").expect("named file should exist");

    reconcile_paper_storage(&workspace.papers, &workspace.database)
        .expect("reconciliation should remove the canonical partial");

    assert!(!partial.exists());
    assert_eq!(
        fs::read(&noncanonical_lookalike).expect("noncanonical lookalike should remain"),
        b"user lookalike"
    );
    assert_eq!(
        fs::read(&named_lookalike).expect("named lookalike should remain"),
        b"user named file"
    );
}

#[cfg(unix)]
#[test]
fn reconciliation_preserves_a_symlink_disguised_as_an_import_partial() {
    use std::os::unix::fs::symlink;

    let workspace = TestWorkspace::new("reconcile-partial-symlink");
    fs::create_dir_all(&workspace.papers).expect("papers directory should exist");
    let external = workspace.source("outside-partial", b"do not remove");
    let partial = workspace
        .papers
        .join(".e0c4e30a-f95c-4fd1-b020-75891657f015.pdf.part");
    symlink(&external, &partial).expect("partial symlink should exist");

    reconcile_paper_storage(&workspace.papers, &workspace.database)
        .expect("a hostile partial link should be ignored");

    assert!(fs::symlink_metadata(&partial)
        .expect("partial link should remain")
        .file_type()
        .is_symlink());
    assert_eq!(
        fs::read(&external).expect("external target should remain"),
        b"do not remove"
    );
}

#[test]
fn reconciliation_recovers_a_regular_pdf_orphaned_by_failed_import_compensation() {
    let workspace = TestWorkspace::new("reconcile-failed-import-orphan");
    let live_source = workspace.source("Live.pdf", b"%PDF-1.7\nlive");
    let live_id = "3f3f0891-cd81-4ac8-aa86-884393f8ba1c";
    import_pdf_into_library(
        &live_source,
        &workspace.papers,
        &workspace.database,
        live_id,
        7,
    )
    .expect("live paper should import");

    let orphan_id = "b50fa1b3-7479-4a71-9db8-4062651f4217";
    let orphan = workspace.papers.join(format!("{orphan_id}.pdf"));
    fs::write(&orphan, b"%PDF-1.7\nfailed import orphan")
        .expect("failed compensation fixture should exist");
    let unmanaged = workspace.papers.join("manual-reference.pdf");
    fs::write(&unmanaged, b"%PDF-1.7\nunmanaged").expect("unmanaged fixture should exist");

    reconcile_paper_storage(&workspace.papers, &workspace.database)
        .expect("reconciliation should safely remove the import orphan");

    assert!(
        !orphan.exists(),
        "the UUID-managed orphan should be removed"
    );
    assert!(
        workspace.papers.join(format!("{live_id}.pdf")).exists(),
        "a managed file with a live database row must remain"
    );
    assert!(
        unmanaged.exists(),
        "a PDF outside the generated UUID naming scheme must remain"
    );
}

#[cfg(unix)]
#[test]
fn a_symlinked_papers_directory_is_rejected_without_touching_its_target() {
    use std::os::unix::fs::symlink;

    let workspace = TestWorkspace::new("symlinked-papers-directory");
    let external_directory = workspace.root.join("external-papers");
    fs::create_dir_all(&external_directory).expect("external directory should exist");
    symlink(&external_directory, &workspace.papers).expect("papers should be symlinked");
    let source = workspace.source("Do Not Copy.pdf", b"%PDF-1.7\nsource");
    let id = "38d34af7-a7ab-42b7-93cd-adf9001c975d";

    assert!(
        import_pdf_into_library(&source, &workspace.papers, &workspace.database, id, 6).is_err(),
        "imports must reject a symlinked managed directory"
    );
    assert!(
        fs::read_dir(&external_directory)
            .expect("external directory should be readable")
            .next()
            .is_none(),
        "the symlink target must not receive a managed copy"
    );

    let relative_path = format!("papers/{id}.pdf");
    workspace.insert_paper(id, Some(&relative_path));
    let external_pdf = external_directory.join(format!("{id}.pdf"));
    fs::write(&external_pdf, b"%PDF-1.7\nexternal").expect("external PDF should exist");

    assert!(delete_paper_from_library(&workspace.papers, &workspace.database, id).is_err());
    assert!(reconcile_paper_storage(&workspace.papers, &workspace.database).is_err());
    assert!(workspace.paper_exists(id));
    assert_eq!(
        fs::read(&external_pdf).expect("external PDF should remain"),
        b"%PDF-1.7\nexternal"
    );
}
