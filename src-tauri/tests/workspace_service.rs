use paper_canvas_lib::{
    migrations,
    workspace::{execute, NodePositionUpdate, Position, WorkspaceRequest, WORKSPACE_CONFLICT},
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Barrier},
    time::Duration,
};

fn migrate(db: &Connection) {
    for migration in migrations() {
        db.execute_batch(migration.sql).unwrap();
    }
}

fn database() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    migrate(&db);
    db
}

fn call(db: &Connection, request: Value, expected: Option<i64>) -> Result<Value, String> {
    let request = serde_json::from_value(request).map_err(|e| e.to_string())?;
    execute(db, request, expected).map(|response| serde_json::to_value(response).unwrap())
}

fn ok(db: &Connection, request: Value) -> Value {
    call(db, request, None).unwrap()
}

fn board(db: &Connection) -> Value {
    ok(db, json!({"type":"load_board"}))
}

fn revision(db: &Connection) -> i64 {
    board(db)["revision"].as_i64().unwrap()
}

fn create_edge(db: &Connection) -> Value {
    ok(
        db,
        json!({"type":"create_edge","sourceNodeId":"node-attention","targetNodeId":"node-bert"}),
    )
}

#[test]
fn github_star_refresh_persists_only_for_the_same_repository_without_changing_its_review() {
    let db = database();
    let url = "https://github.com/example/code";
    ok(&db, json!({"type":"save_paper_code_reviews","reviews":[{
        "paperId":"paper-attention", "expectedGithubUrl":null, "githubUrl":url, "githubStars":42,
        "codeReview":{"status":"official", "evidenceUrl":"https://example.org/paper", "evidence":"The paper links this implementation."}
    }]}));
    let get = json!({"type":"get_paper","id":"paper-attention"});
    let review = ok(&db, get.clone())["value"]["codeReview"].clone();
    let refresh = json!({"type":"update_paper_github_stars","paperId":"paper-attention","githubUrl":url,"githubStars":0});
    assert_eq!(ok(&db, refresh.clone())["changed"], true);
    let saved = ok(&db, get.clone());
    assert_eq!(saved["value"]["githubUrl"], url);
    assert_eq!(saved["value"]["githubStars"], 0);
    assert_eq!(saved["value"]["codeReview"], review);
    assert_eq!(ok(&db, refresh.clone())["changed"], false);

    for github_stars in [json!(-1), json!(9_007_199_254_740_992i64)] {
        let mut invalid = refresh.clone();
        invalid["githubStars"] = github_stars;
        assert!(call(&db, invalid, None).is_err());
        assert_eq!(ok(&db, get.clone()), saved);
    }

    for new_url in [json!("https://github.com/example/new"), Value::Null] {
        ok(&db, json!({"type":"update_paper_github","paperId":"paper-attention","githubUrl":new_url,"githubStars":null}));
        let before = ok(&db, get.clone());
        assert_eq!(ok(&db, refresh.clone())["changed"], false);
        assert_eq!(ok(&db, get.clone()), before, "A late response must not restore the old link or its Stars");
    }
}

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("workspace-service-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn connect(&self) -> Connection {
        let db = Connection::open(self.0.join("workspace.db")).unwrap();
        db.busy_timeout(Duration::from_secs(3)).unwrap();
        db
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn read_contract_search_and_nullable_paper_fields() {
    let db = database();
    db.execute(
        "INSERT INTO papers (id,title,created_at) VALUES (?1,?2,?3)",
        params!["off-board", "Quoted ' paper", i64::MAX],
    )
    .unwrap();
    let snapshot = board(&db);
    assert_eq!(snapshot["changed"], false);
    assert_eq!(snapshot["revision"], 0);
    assert_eq!(snapshot["value"]["nodes"].as_array().unwrap().len(), 3);
    let node = &snapshot["value"]["nodes"][0];
    assert_eq!(node["id"], "node-attention");
    assert_eq!(node["boardId"], "board-default");
    assert_eq!(node["position"], json!({"x":120.0,"y":110.0}));
    assert_eq!(node["size"], json!({"width":280.0,"height":128.0}));
    assert_eq!(node["paper"]["filePath"], Value::Null);
    let all = ok(&db, json!({"type":"list_papers"}));
    assert_eq!(
        all["value"][0],
        json!({"id":"off-board","title":"Quoted ' paper",
        "authors":null,"year":null,"filePath":null,"domainId":null,"createdAt":i64::MAX})
    );
    assert_eq!(all["changed"], false);
    let found = ok(
        &db,
        json!({"type":"list_papers","searchTerm":"  vAsWaNi  "}),
    );
    assert_eq!(found["value"].as_array().unwrap().len(), 1);
    assert_eq!(found["value"][0]["id"], "paper-attention");
    assert_eq!(
        ok(
            &db,
            json!({"type":"list_papers","searchTerm":"' OR 1=1 --"})
        )["value"],
        json!([])
    );
    assert_eq!(
        ok(&db, json!({"type":"get_paper","id":"missing"}))["value"],
        Value::Null
    );
    assert_eq!(
        ok(&db, json!({"type":"get_paper","id":"off-board"}))["value"],
        all["value"][0]
    );
    assert_eq!(ok(&db, json!({"type":"list_domains"}))["value"], json!([]));
}

#[test]
fn reverse_edges_and_existing_cards_are_idempotent_and_preserve_annotations() {
    let db = database();
    let edge = create_edge(&db);
    assert_eq!(edge["changed"], true);
    let id = edge["value"]["id"].clone();
    let relation = json!({"type":"update_edge_relation","edgeId":id,"relation":"challenge"});
    assert_eq!(ok(&db, relation.clone())["changed"], true);
    let annotations = json!({"type":"update_edge_annotations","edgeId":id,
        "annotations":{"explanation":"It's contradictory","evidence":"Table 3; 'quoted'"}});
    assert_eq!(ok(&db, annotations.clone())["changed"], true);
    let before = board(&db);
    for (source, target) in [
        ("node-attention", "node-bert"),
        ("node-bert", "node-attention"),
    ] {
        let repeated = ok(
            &db,
            json!({"type":"create_edge","sourceNodeId":source,"targetNodeId":target}),
        );
        assert_eq!(repeated["value"], before["value"]["edges"][0]);
        assert_eq!(repeated["revision"], before["revision"]);
        assert_eq!(repeated["changed"], false);
    }
    assert_eq!(ok(&db, relation)["changed"], false);
    assert_eq!(ok(&db, annotations)["changed"], false);
    let existing = ok(
        &db,
        json!({"type":"create_paper_node","paperId":"paper-attention","position":{"x":999,"y":999}}),
    );
    assert_eq!(existing["value"], before["value"]["nodes"][0]);
    assert_eq!(existing["changed"], false);
    assert_eq!(board(&db), before);
    assert_eq!(
        ok(
            &db,
            json!({"type":"update_edge_relation","edgeId":id,"relation":null})
        )["changed"],
        true
    );
    assert_eq!(board(&db)["value"]["edges"][0]["relation"], Value::Null);
}

#[test]
fn multi_move_and_deletes_roll_back_all_rows_cascades_and_revision() {
    let db = database();
    let edge = create_edge(&db);
    let before = board(&db);
    for request in [
        json!({"type":"save_node_positions","updates":[{"id":"node-attention","x":8,"y":9},{"id":"missing","x":1,"y":2}]}),
        json!({"type":"delete_nodes","nodeIds":["node-attention","missing"]}),
        json!({"type":"delete_edges","edgeIds":[edge["value"]["id"],"missing"]}),
    ] {
        let error = call(&db, request, None).unwrap_err();
        assert!(
            error.contains("stale") && error.contains("missing"),
            "{error}"
        );
        assert_eq!(board(&db), before);
    }
    let error = execute(
        &db,
        WorkspaceRequest::SaveNodePositions {
            updates: vec![
                NodePositionUpdate {
                    id: "node-attention".into(),
                    x: 8.0,
                    y: 9.0,
                },
                NodePositionUpdate {
                    id: "node-bert".into(),
                    x: f64::NAN,
                    y: 2.0,
                },
            ],
        },
        None,
    )
    .unwrap_err();
    assert!(error.contains("finite"));
    assert_eq!(board(&db), before);
    for request in [
        json!({"type":"save_node_positions","updates":[]}),
        json!({"type":"delete_nodes","nodeIds":[]}),
        json!({"type":"delete_edges","edgeIds":[]}),
        json!({"type":"save_node_positions","updates":[{"id":"node-attention","x":120,"y":110}]}),
    ] {
        let result = ok(&db, request);
        assert_eq!(result["changed"], false);
        assert_eq!(result["value"], Value::Null);
        assert_eq!(result["revision"], before["revision"]);
    }
    let saved = ok(
        &db,
        json!({"type":"save_node_positions","updates":[
        {"id":"node-attention","x":8,"y":9},{"id":"node-bert","x":1,"y":2}]}),
    );
    assert_eq!(saved["changed"], true);
    assert_eq!(
        saved["revision"].as_i64().unwrap(),
        before["revision"].as_i64().unwrap() + 2
    );
}

#[test]
fn deleting_cards_preserves_imported_papers_pdf_and_allows_readding() {
    let temp = Temp::new();
    let db = temp.connect();
    migrate(&db);
    let pdf = temp.0.join("source.pdf");
    let pdf_bytes = b"%PDF-1.7\nworkspace regression\n%%EOF";
    std::fs::write(&pdf, pdf_bytes).unwrap();
    let imported = paper_canvas_lib::import_pdf_into_library(
        &pdf,
        &temp.0.join("papers"),
        &temp.0.join("workspace.db"),
        "123e4567-e89b-12d3-a456-426614174000",
        42,
    )
    .unwrap();
    let original = ok(&db, json!({"type":"get_paper","id":imported.id}))["value"].clone();
    let first = ok(
        &db,
        json!({"type":"create_paper_node","paperId":imported.id,"position":{"x":1,"y":2}}),
    );
    let id = first["value"]["id"].clone();
    ok(
        &db,
        json!({"type":"create_edge","sourceNodeId":id,"targetNodeId":"node-attention"}),
    );
    let before = board(&db);
    assert!(call(
        &db,
        json!({"type":"delete_nodes","nodeIds":[id,"missing"]}),
        None
    )
    .is_err());
    assert_eq!(board(&db), before);
    let deleted = ok(&db, json!({"type":"delete_nodes","nodeIds":[id]}));
    assert_eq!(deleted["changed"], true);
    assert_eq!(board(&db)["value"]["edges"], json!([]));
    assert_eq!(
        ok(&db, json!({"type":"get_paper","id":imported.id}))["value"],
        original
    );
    assert_eq!(
        std::fs::read(temp.0.join(original["filePath"].as_str().unwrap())).unwrap(),
        pdf_bytes
    );
    let second = ok(
        &db,
        json!({"type":"create_paper_node","paperId":imported.id,"position":{"x":3,"y":4}}),
    );
    assert_ne!(second["value"]["id"], id);
    assert_eq!(second["value"]["paper"], original);
    assert_eq!(second["value"]["position"], json!({"x":3.0,"y":4.0}));
}

#[test]
fn two_clients_cannot_overwrite_positions_from_a_stale_revision() {
    let temp = Temp::new();
    let first = temp.connect();
    migrate(&first);
    let second = temp.connect();
    let initial = revision(&first);
    assert_eq!(revision(&second), initial);
    let update =
        |x| json!({"type":"save_node_positions","updates":[{"id":"node-attention","x":x,"y":2}]});
    let committed = call(&first, update(555), Some(initial)).unwrap();
    assert_eq!(
        call(&second, update(123), Some(initial)).unwrap_err(),
        WORKSPACE_CONFLICT
    );
    assert_eq!(board(&second)["value"]["nodes"][0]["position"]["x"], 555.0);
    assert_eq!(
        revision(&temp.connect()),
        committed["revision"].as_i64().unwrap()
    );
    let fresh = revision(&second);
    assert!(call(&second, update(123), Some(fresh)).unwrap()["changed"]
        .as_bool()
        .unwrap());
}

#[test]
fn simultaneous_clients_check_revision_after_acquiring_the_write_lock() {
    let temp = Temp::new();
    let db = temp.connect();
    migrate(&db);
    let rev = revision(&db);
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = [10,20].into_iter().map(|x| {
        let db = temp.connect();
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            barrier.wait();
            call(&db, json!({"type":"save_node_positions","updates":[{"id":"node-attention","x":x,"y":2}]}), Some(rev))
        })
    }).collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results.iter().find_map(|r| r.as_ref().err()).unwrap(),
        WORKSPACE_CONFLICT
    );
}

#[test]
fn domains_trim_count_unicode_reject_duplicate_names_and_keep_single_membership() {
    let db = database();
    let first = ok(&db, json!({"type":"create_domain","name":" \tRobotics\n "}));
    assert_eq!(first["value"]["name"], "Robotics");
    let a = first["value"]["id"].clone();
    for name in ["robotics".to_string(), "  \n".into(), "🦀".repeat(81)] {
        let before = revision(&db);
        assert!(call(&db, json!({"type":"create_domain","name":name}), None).is_err());
        assert_eq!(revision(&db), before);
    }
    ok(&db, json!({"type":"create_domain","name":"🦀".repeat(80)}));
    let second = ok(&db, json!({"type":"create_domain","name":"AI"}));
    let b = second["value"]["id"].clone();
    let before = revision(&db);
    assert!(call(
        &db,
        json!({"type":"rename_domain","domainId":b,"name":"ROBOTICS"}),
        None
    )
    .is_err());
    assert_eq!(revision(&db), before);
    assert_eq!(
        ok(
            &db,
            json!({"type":"rename_domain","domainId":a,"name":" Robotics "})
        )["changed"],
        false
    );
    assert_eq!(
        ok(&db, json!({"type":"list_domains"}))["value"][1],
        first["value"]
    );
    assert_eq!(
        ok(
            &db,
            json!({"type":"rename_domain","domainId":a,"name":"ROBOTICS"})
        )["changed"],
        true
    );
    for domain in [&a, &b] {
        assert_eq!(
            ok(
                &db,
                json!({"type":"assign_paper","paperId":"paper-attention","domainId":domain})
            )["changed"],
            true
        );
        assert_eq!(
            ok(&db, json!({"type":"get_paper","id":"paper-attention"}))["value"]["domainId"],
            *domain
        );
    }
    assert_eq!(
        ok(
            &db,
            json!({"type":"assign_paper","paperId":"paper-attention","domainId":b})
        )["changed"],
        false
    );
    let before = board(&db);
    assert!(call(
        &db,
        json!({"type":"assign_paper","paperId":"paper-attention","domainId":"missing"}),
        None
    )
    .is_err());
    assert_eq!(board(&db), before);
    ok(&db, json!({"type":"delete_domain","domainId":b}));
    assert_eq!(
        ok(&db, json!({"type":"get_paper","id":"paper-attention"}))["value"]["domainId"],
        Value::Null
    );
    assert_eq!(
        ok(
            &db,
            json!({"type":"assign_paper","paperId":"paper-attention","domainId":null})
        )["changed"],
        false
    );
    assert_eq!(board(&db)["value"]["nodes"].as_array().unwrap().len(), 3);
}

#[test]
fn validation_rejects_invalid_identifiers_coordinates_relations_and_cross_board_operations() {
    let db = database();
    db.execute_batch(
        "INSERT INTO boards VALUES ('other','Other');
        INSERT INTO board_nodes VALUES ('other-a','other','paper-attention',1,2,280,128);
        INSERT INTO board_nodes VALUES ('other-b','other','paper-bert',3,4,280,128);
        INSERT INTO board_edges (id,board_id,source_node_id,target_node_id,created_at)
            VALUES ('other-edge','other','other-a','other-b',1);",
    )
    .unwrap();
    let before = board(&db);
    for request in [
        json!({"type":"get_paper","id":"  "}),
        json!({"type":"update_paper_title","paperId":"paper-attention","title":" \n "}),
        json!({"type":"update_paper_title","paperId":"missing","title":"Title"}),
        json!({"type":"create_paper_node","paperId":"missing","position":{"x":1,"y":2}}),
        json!({"type":"create_edge","sourceNodeId":"node-attention","targetNodeId":"node-attention"}),
        json!({"type":"create_edge","sourceNodeId":"missing","targetNodeId":"node-attention"}),
        json!({"type":"create_edge","sourceNodeId":"other-a","targetNodeId":"node-attention"}),
        json!({"type":"create_edge","sourceNodeId":"other-a","targetNodeId":"other-b"}),
        json!({"type":"save_node_positions","updates":[{"id":"node-attention","x":1,"y":2},{"id":"node-attention","x":2,"y":3}]}),
        json!({"type":"save_node_positions","updates":[{"id":"other-a","x":1,"y":2}]}),
        json!({"type":"delete_nodes","nodeIds":["node-attention","node-attention"]}),
        json!({"type":"delete_nodes","nodeIds":["node-attention",""]}),
        json!({"type":"delete_nodes","nodeIds":["other-a"]}),
        json!({"type":"delete_edges","edgeIds":["other-edge"]}),
        json!({"type":"delete_edges","edgeIds":["other-edge","other-edge"]}),
        json!({"type":"update_edge_relation","edgeId":"other-edge","relation":"support"}),
        json!({"type":"update_edge_relation","edgeId":"missing","relation":"invalid"}),
        json!({"type":"update_edge_annotations","edgeId":"other-edge","annotations":{"explanation":"x","evidence":"y"}}),
        json!({"type":"rename_domain","domainId":"missing","name":"Valid"}),
        json!({"type":"delete_domain","domainId":" "}),
        json!({"type":"assign_paper","paperId":"missing","domainId":null}),
    ] {
        assert!(call(&db, request.clone(), None).is_err(), "{request}");
        assert_eq!(board(&db), before);
    }
    for x in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(execute(
            &db,
            WorkspaceRequest::CreatePaperNode {
                paper_id: "paper-attention".into(),
                position: Position { x, y: 0.0 }
            },
            None
        )
        .is_err());
    }
    let title = "O'Brien'); DELETE FROM papers; --";
    assert_eq!(
        ok(
            &db,
            json!({"type":"update_paper_title","paperId":"paper-attention","title":title})
        )["changed"],
        true
    );
    assert_eq!(board(&db)["value"]["nodes"][0]["paper"]["title"], title);
    assert_eq!(
        ok(&db, json!({"type":"list_papers"}))["value"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn off_board_imports_and_edits_do_not_conflict_with_unsaved_positions() {
    let db = database();
    let expected = revision(&db);
    db.execute(
        "INSERT INTO papers (id,title,created_at) VALUES ('imported','Import',1)",
        [],
    )
    .unwrap();
    assert_eq!(revision(&db), expected);
    let request =
        json!({"type":"update_paper_title","paperId":"imported","title":"Extracted title"});
    let updated = ok(&db, request.clone());
    assert_eq!(updated["changed"], true);
    assert_eq!(updated["revision"], expected);
    assert_eq!(ok(&db, request)["changed"], false);
    db.execute(
        "UPDATE papers SET authors='Author',year=2026 WHERE id='imported'",
        [],
    )
    .unwrap();
    assert_eq!(revision(&db), expected);
    assert!(call(
        &db,
        json!({"type":"save_node_positions","updates":[{"id":"node-attention","x":99,"y":99}]}),
        Some(expected)
    )
    .is_ok());
    let expected = revision(&db);
    ok(
        &db,
        json!({"type":"create_paper_node","paperId":"imported","position":{"x":1,"y":1}}),
    );
    assert!(revision(&db) > expected);
    let expected = revision(&db);
    db.execute(
        "UPDATE papers SET title='New metadata' WHERE id='imported'",
        [],
    )
    .unwrap();
    assert!(revision(&db) > expected);
    assert_eq!(
        call(
            &db,
            json!({"type":"save_node_positions","updates":[]}),
            Some(expected)
        )
        .unwrap_err(),
        WORKSPACE_CONFLICT
    );
}

#[test]
fn legacy_sql_changes_invalidate_snapshots_but_noops_do_not() {
    let db = database();
    for sql in [
        "INSERT INTO paper_domains VALUES ('domain','Legacy',1,1)",
        "UPDATE paper_domains SET name='Renamed' WHERE id='domain'",
        "UPDATE papers SET domain_id='domain' WHERE id='paper-attention'",
        "DELETE FROM paper_domains WHERE id='domain'",
        "UPDATE papers SET authors=NULL,year=NULL,file_path='papers/a.pdf',created_at=1 WHERE id='paper-attention'",
        "UPDATE board_nodes SET x=7,width=300 WHERE id='node-attention'",
        "INSERT INTO board_edges (id,board_id,source_node_id,target_node_id,created_at) VALUES ('legacy','board-default','node-attention','node-bert',1)",
        "UPDATE board_edges SET relation_type='support',explanation='A',evidence='B' WHERE id='legacy'",
        "DELETE FROM board_edges WHERE id='legacy'",
        "DELETE FROM board_nodes WHERE id='node-resnet'",
        "INSERT INTO board_nodes VALUES ('new-resnet','board-default','paper-resnet',1,2,280,128)",
        "DELETE FROM papers WHERE id='paper-resnet'",
    ] {
        let before = revision(&db);
        db.execute(sql, []).unwrap();
        assert!(revision(&db) > before, "{sql}");
    }
    let before = revision(&db);
    for sql in [
        "UPDATE papers SET title=title,authors=authors,year=year,domain_id=domain_id",
        "UPDATE board_nodes SET x=x,y=y,width=width,height=height",
        "UPDATE board_edges SET relation_type=relation_type,explanation=explanation,evidence=evidence",
        "DELETE FROM papers WHERE id='already-missing'",
        "INSERT INTO papers (id,title,created_at) VALUES ('off','Off',1)",
        "UPDATE papers SET title='Still off' WHERE id='off'",
        "DELETE FROM papers WHERE id='off'",
    ] {
        db.execute(sql, []).unwrap();
        assert_eq!(revision(&db), before, "{sql}");
    }
}

#[test]
fn migration_preserves_legacy_reverse_edges_and_every_existing_table() {
    let db = Connection::open_in_memory().unwrap();
    for migration in migrations().into_iter().filter(|m| m.version < 18) {
        db.execute_batch(migration.sql).unwrap();
    }
    db.execute_batch("INSERT INTO paper_domains VALUES ('legacy-domain','Legacy',1,1);
        UPDATE papers SET domain_id='legacy-domain',file_path='papers/preserved.pdf' WHERE id='paper-attention';
        INSERT INTO board_edges VALUES ('forward','board-default','node-attention','node-bert',1,'support','Forward note','Page 3');
        INSERT INTO board_edges VALUES ('reverse','board-default','node-bert','node-attention',2,'challenge','Reverse note','Page 4');
        INSERT INTO paper_mermaid_maps VALUES ('paper-attention','mindmap',1);").unwrap();
    let tables: Vec<String> = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let contents = |table: &str| {
        let mut stmt = db
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .unwrap();
        let count = stmt.column_count();
        stmt.query_map([], |row| {
            (0..count)
                .map(|i| row.get::<_, rusqlite::types::Value>(i))
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
    };
    let before: Vec<_> = tables.iter().map(|table| contents(table)).collect();
    db.execute_batch(migrations().iter().find(|m| m.version == 18).unwrap().sql)
        .unwrap();
    assert_eq!(
        tables
            .iter()
            .map(|table| contents(table))
            .collect::<Vec<_>>(),
        before
    );
    db.execute_batch(migrations().iter().find(|m| m.version == 19).unwrap().sql)
        .unwrap();
    // This fixture deliberately stops at v19 to compare its original schema.
    assert_eq!(db.query_row("SELECT revision FROM workspace_revision", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    for (source, target) in [
        ("node-attention", "node-bert"),
        ("node-bert", "node-attention"),
    ] {
        let response = ok(
            &db,
            json!({"type":"create_edge","sourceNodeId":source,"targetNodeId":target}),
        );
        assert_eq!(response["changed"], false);
        assert_eq!(response["value"]["id"], "forward");
        assert_eq!(response["value"]["explanation"], "Forward note");
    }
    assert_eq!(
        tables
            .iter()
            .map(|table| contents(table))
            .collect::<Vec<_>>(),
        before
    );
}

#[test]
fn reads_return_a_single_snapshot_with_its_revision_during_legacy_writes() {
    let temp = Temp::new();
    let db = temp.connect();
    migrate(&db);
    db.execute_batch(
        "PRAGMA journal_mode=WAL; UPDATE board_nodes SET x=0,y=0;
        UPDATE papers SET title='0';",
    )
    .unwrap();
    let edge = create_edge(&db);
    db.execute(
        "UPDATE board_edges SET explanation='0',evidence='0' WHERE id=?1",
        [edge["value"]["id"].as_str().unwrap()],
    )
    .unwrap();
    let base = revision(&db);
    let writer = temp.connect();
    let barrier = Arc::new(Barrier::new(2));
    let started = barrier.clone();
    let handle = std::thread::spawn(move || {
        started.wait();
        for version in 1..=150 {
            writer.execute_batch("BEGIN IMMEDIATE").unwrap();
            writer
                .execute("UPDATE board_nodes SET x=?1,y=?1", [version])
                .unwrap();
            writer
                .execute("UPDATE papers SET title=?1", [version.to_string()])
                .unwrap();
            writer
                .execute(
                    "UPDATE board_edges SET explanation=?1,evidence=?1",
                    [version.to_string()],
                )
                .unwrap();
            writer.execute_batch("COMMIT").unwrap();
            std::thread::yield_now();
        }
    });
    barrier.wait();
    for _ in 0..200 {
        let snapshot = board(&db);
        let version = (snapshot["revision"].as_i64().unwrap() - base) / 7;
        assert_eq!(snapshot["changed"], false);
        for node in snapshot["value"]["nodes"].as_array().unwrap() {
            assert_eq!(node["position"]["x"], json!(version as f64));
            assert_eq!(node["position"]["y"], json!(version as f64));
            assert_eq!(node["paper"]["title"], version.to_string());
        }
        assert_eq!(
            snapshot["value"]["edges"][0]["explanation"],
            version.to_string()
        );
        let papers = ok(&db, json!({"type":"list_papers"}));
        let version = (papers["revision"].as_i64().unwrap() - base) / 7;
        for paper in papers["value"].as_array().unwrap() {
            assert_eq!(paper["title"], version.to_string());
        }
        let paper = ok(&db, json!({"type":"get_paper","id":"paper-attention"}));
        assert_eq!(
            paper["value"]["title"],
            ((paper["revision"].as_i64().unwrap() - base) / 7).to_string()
        );
    }
    handle.join().unwrap();
    assert_eq!(revision(&db), base + 150 * 7);
}
