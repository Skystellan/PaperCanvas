use paper_canvas_lib::{
    migrations,
    research::{
        RESEARCH_BATCH_UNDONE, RESEARCH_IDENTITY_CONFLICT, RESEARCH_REQUEST_CONFLICT,
        RESEARCH_UNDO_CONFLICT,
    },
    workspace::{execute, WorkspaceRequest},
};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

fn database() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    for migration in migrations() {
        db.execute_batch(migration.sql).unwrap();
    }
    db
}

fn call(db: &Connection, request: Value) -> Result<Value, String> {
    let request: WorkspaceRequest = serde_json::from_value(request).map_err(|e| e.to_string())?;
    execute(db, request, None).map(|response| serde_json::to_value(response).unwrap())
}

fn ok(db: &Connection, request: Value) -> Value {
    call(db, request).unwrap()
}
fn board(db: &Connection) -> Value {
    ok(db, json!({"type":"load_board"}))
}
fn import(db: &Connection, batch: Value) -> Value {
    ok(db, json!({"type":"import_research_batch","batch":batch}))
}
fn undo(db: &Connection, id: &Value) -> Result<Value, String> {
    call(db, json!({"type":"undo_research_batch","batchId":id}))
}

fn batch(key: &str) -> Value {
    json!({"requestId":key,"title":"Research proposal","intent":"independent","papers":[
        {"ref":"a","title":"Proposed A","authors":"Author A","year":2026,
         "doi":"DOI:10.1234/ABC","arxivId":"https://arxiv.org/pdf/2401.01234v2.pdf",
         "url":"https://example.org/a","abstract":"Public abstract A","reason":"Private recommendation A","group":"Method"},
        {"ref":"b","title":"Proposed B","url":"https://example.org/b","group":"Evaluation"}
    ],"edges":[{"sourceRef":"a","targetRef":"b","kind":"supports","explanation":"Private explanation",
        "evidence":"Private evidence","basis":"abstract"}]})
}

fn single(key: &str, url: &str) -> Value {
    json!({"requestId":key,"title":"Single","intent":"independent",
        "papers":[{"ref":"a","title":"Same title","url":url}]})
}

fn table_names(db: &Connection) -> Vec<String> {
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn contents(db: &Connection, tables: &[String]) -> Vec<Vec<Vec<rusqlite::types::Value>>> {
    tables
        .iter()
        .map(|table| {
            let mut stmt = db
                .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
                .unwrap();
            let columns = stmt.column_count();
            stmt.query_map([], |row| {
                (0..columns)
                    .map(|column| row.get(column))
                    .collect::<Result<Vec<_>, _>>()
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
        })
        .collect()
}

fn assert_rejected_unchanged(db: &Connection, request: Value) -> String {
    let tables = table_names(db);
    let before = contents(db, &tables);
    let error = match call(db, request.clone()) {
        Err(error) => error,
        Ok(_) => panic!("Accepted invalid request: {request}"),
    };
    assert_eq!(contents(db, &tables), before);
    error
}

fn paper(db: &Connection, id: &Value) -> Value {
    ok(db, json!({"type":"get_paper","id":id}))["value"].clone()
}

#[test]
fn import_contract_metadata_grid_groups_and_existing_graph_are_preserved() {
    let db = database();
    db.execute_batch("INSERT INTO paper_domains VALUES ('old-domain','Old',1,1);
        UPDATE papers SET domain_id='old-domain' WHERE id='paper-attention';
        INSERT INTO board_edges VALUES ('old-edge','board-default','node-attention','node-bert',1,'challenge','Old annotation','Old evidence');").unwrap();
    let old = board(&db);
    let mut input = batch("grid");
    input["papers"].as_array_mut().unwrap().extend([
        json!({"ref":"c","title":"C","url":"https://example.org/c","group":"Method"}),
        json!({"ref":"d","title":"D","url":"https://example.org/d","group":"Method"}),
        json!({"ref":"e","title":"E","url":"https://example.org/e","group":"Method"}),
    ]);
    let response = import(&db, input);
    assert_eq!(response["changed"], true);
    assert!(response["revision"].as_i64().unwrap() > old["revision"].as_i64().unwrap());
    let result = &response["value"];
    assert_eq!(result["createdPapers"], 5);
    assert_eq!(result["createdNodes"], 5);
    assert_eq!(result["createdEdges"], 1);
    for key in ["reusedPapers", "reusedNodes", "reusedEdges"] {
        assert_eq!(result[key], 0);
    }
    assert_eq!(result["replayed"], false);
    let placements = result["placements"].as_array().unwrap();
    assert_eq!(
        placements
            .iter()
            .map(|p| p["ref"].clone())
            .collect::<Vec<_>>(),
        json!(["a", "b", "c", "d", "e"]).as_array().unwrap().clone()
    );
    let current = board(&db);
    for node in old["value"]["nodes"].as_array().unwrap() {
        assert_eq!(
            current["value"]["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|n| n["id"] == node["id"])
                .unwrap(),
            node
        );
        assert!(node["paper"].get("research").is_none());
    }
    assert_eq!(
        current["value"]["edges"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"] == "old-edge")
            .unwrap(),
        &old["value"]["edges"][0]
    );
    let positions = [
        (1040.0, 0.0),
        (1040.0, 630.0),
        (1400.0, 0.0),
        (1760.0, 0.0),
        (1040.0, 210.0),
    ];
    for (placement, (x, y)) in placements.iter().zip(positions) {
        let node = current["value"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == placement["nodeId"])
            .unwrap();
        assert_eq!(node["position"], json!({"x":x,"y":y}));
        assert_eq!(node["size"], json!({"width":280.0,"height":128.0}));
        assert_eq!(node["paper"]["filePath"], Value::Null);
        assert_eq!(node["paper"]["domainId"], Value::Null);
    }
    let a = paper(&db, &placements[0]["paperId"]);
    assert_eq!(
        a["research"],
        json!({"doi":"10.1234/abc","arxivId":"2401.01234","arxivVersion":"2","url":"https://example.org/a",
        "abstract":"Public abstract A","reason":"Private recommendation A","group":"Method","batchId":result["batchId"]})
    );
    let e = current["value"]["edges"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] != "old-edge")
        .unwrap();
    assert_eq!(e["relation"], "support");
    assert_eq!(e["explanation"], "Private explanation");
    assert_eq!(e["evidence"], "Private evidence");
    assert_eq!(
        e["research"],
        json!({"kind":"supports","basis":"abstract","batchId":result["batchId"]})
    );
    assert_eq!(
        ok(&db, json!({"type":"list_domains"}))["value"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let listed = ok(&db, json!({"type":"list_research_batches"}));
    assert_eq!(listed["changed"], false);
    assert_eq!(listed["value"][0]["createdNodes"], 5);
    assert_eq!(listed["value"][0]["createdEdges"], 1);
    assert_eq!(listed["value"][0]["undone"], false);
    assert_eq!(listed["value"][0].as_object().unwrap().len(), 7);
}

#[test]
fn retries_reuse_exact_ids_and_never_return_old_metadata() {
    let db = database();
    let input = batch("retry");
    let first = import(&db, input.clone());
    let p = &first["value"]["placements"];
    db.execute(
        "UPDATE papers SET title='Secret old title' WHERE id=?1",
        [p[0]["paperId"].as_str().unwrap()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO notes VALUES ('secret-note',?1,'Secret old notes',1)",
        [p[0]["paperId"].as_str().unwrap()],
    )
    .unwrap();
    db.execute("UPDATE research_papers SET metadata=json_set(metadata,'$.abstract','Secret old abstract') WHERE paper_id=?1", [p[0]["paperId"].as_str().unwrap()]).unwrap();
    let saved = board(&db);
    let replay = import(&db, input.clone());
    assert_eq!(replay["changed"], false);
    assert_eq!(replay["revision"], saved["revision"]);
    let mut expected = first["value"].clone();
    expected["replayed"] = json!(true);
    assert_eq!(replay["value"], expected);
    let mut different = input.clone();
    different["title"] = json!("Another title");
    assert_eq!(
        assert_rejected_unchanged(
            &db,
            json!({"type":"import_research_batch","batch":different})
        ),
        RESEARCH_REQUEST_CONFLICT
    );
    let mut reuse = input;
    reuse["requestId"] = json!("another-key");
    reuse["papers"][0]["doi"] = json!("https://DX.DOI.ORG/10.1234/abc");
    reuse["papers"][0]["arxivId"] = json!("arXiv:2401.01234v9");
    reuse["papers"][0]["title"] = json!("Replacement attempted");
    reuse["edges"][0]["sourceRef"] = json!("b");
    reuse["edges"][0]["targetRef"] = json!("a");
    reuse["edges"][0]["kind"] = json!("challenges");
    let reused = import(&db, reuse);
    assert_eq!(reused["value"]["createdPapers"], 0);
    assert_eq!(reused["value"]["reusedPapers"], 2);
    assert_eq!(reused["value"]["reusedNodes"], 2);
    assert_eq!(reused["value"]["reusedEdges"], 1);
    assert_eq!(reused["value"]["placements"], first["value"]["placements"]);
    assert_eq!(board(&db), saved);
    for response in [&replay, &reused] {
        let serialized = response.to_string();
        for private in ["Secret old", "Private", "abstract", "notes", "title"] {
            assert!(!serialized.contains(private), "{serialized}");
        }
        assert_eq!(response["value"].as_object().unwrap().len(), 9);
        for placement in response["value"]["placements"].as_array().unwrap() {
            assert_eq!(placement.as_object().unwrap().len(), 3);
        }
    }
}

#[test]
fn identity_conflicts_and_late_edge_errors_roll_back_every_table_and_revision() {
    let db = database();
    let original = import(&db, batch("base"));
    let mut input = batch("conflict");
    input["papers"][0]["doi"] = json!("10.1234/different");
    input["papers"].as_array_mut().unwrap().insert(0, json!({"ref":"new","title":"Written before conflict","url":"https://example.org/new","group":"Method"}));
    assert_eq!(
        assert_rejected_unchanged(&db, json!({"type":"import_research_batch","batch":input})),
        RESEARCH_IDENTITY_CONFLICT
    );
    let mut other = single("other", "https://example.org/other");
    other["papers"][0]["doi"] = json!("10.5678/other");
    import(&db, other);
    let mut crossing = single("crossing", "https://example.org/crossing");
    crossing["papers"][0]["doi"] = json!("10.5678/other");
    crossing["papers"][0]["arxivId"] = json!("2401.01234");
    assert_eq!(
        assert_rejected_unchanged(
            &db,
            json!({"type":"import_research_batch","batch":crossing})
        ),
        RESEARCH_IDENTITY_CONFLICT
    );
    let mut late = batch("late-error");
    late["papers"][1] = json!({"ref":"b","title":"Alias of A","url":"https://example.org/alias","doi":"10.1234/abc"});
    late["papers"].as_array_mut().unwrap().insert(
        0,
        json!({"ref":"c","title":"New C","url":"https://example.org/new-c"}),
    );
    late["edges"].as_array_mut().unwrap().insert(
        0,
        json!({"sourceRef":"c","targetRef":"a","kind":"uses","explanation":"Would create an edge"}),
    );
    assert!(
        assert_rejected_unchanged(&db, json!({"type":"import_research_batch","batch":late}))
            .contains("same paper")
    );
    assert_eq!(
        paper(&db, &original["value"]["placements"][0]["paperId"])["title"],
        "Proposed A"
    );
}

#[test]
fn normalizes_source_urls_and_arxiv_versions_but_never_merges_titles() {
    let db = database();
    let first = import(
        &db,
        single("url-a", "HTTPS://EXAMPLE.ORG:443/a/../paper/%7euser#first"),
    );
    let second = import(
        &db,
        single("url-b", "https://example.org/paper/~user#second"),
    );
    assert_eq!(second["value"]["placements"], first["value"]["placements"]);
    let distinct = import(&db, single("url-c", "https://example.org/another"));
    assert_eq!(distinct["value"]["createdPapers"], 1);
    let a = import(
        &db,
        single("arxiv-a", "https://arxiv.org/abs/hep-th/9901001v1"),
    );
    let b = import(
        &db,
        single(
            "arxiv-b",
            "https://export.arxiv.org/pdf/hep-th/9901001v12.pdf",
        ),
    );
    assert_eq!(a["value"]["placements"], b["value"]["placements"]);
    assert_eq!(
        paper(&db, &a["value"]["placements"][0]["paperId"])["research"]["arxivId"],
        "hep-th/9901001"
    );
    let a = import(&db, single("doi-a", "https://doi.org/10.1234/%41BC%2Fdef"));
    let b = import(&db, single("doi-b", "http://dx.doi.org/10.1234/abc/def"));
    assert_eq!(a["value"]["placements"], b["value"]["placements"]);
    let mut conflicting_url = single("url-contradiction", "https://arxiv.org/abs/2401.00001");
    conflicting_url["papers"][0]["arxivId"] = json!("2401.00002");
    assert_eq!(
        assert_rejected_unchanged(
            &db,
            json!({"type":"import_research_batch","batch":conflicting_url})
        ),
        RESEARCH_IDENTITY_CONFLICT
    );
}

#[test]
fn rejects_unsafe_urls_bad_metadata_and_invalid_typed_inputs_atomically() {
    let db = database();
    for url in [
        "file:///tmp/secret",
        "javascript:alert(1)",
        "ftp://example.org/a",
        "https://user:pass@example.org/a",
        "https://@example.org/a",
        "https://example.org/a\nb",
        "https://example.org/a\tb",
        "https://example.org/a%00b",
        "https://example.org/a%0ab",
        "https://example.org/a%7Fb",
        "https://example.org/a b",
        "https://example.org/%xx",
        "https:///example.org",
        "https://example.org/\u{0085}",
    ] {
        assert_rejected_unchanged(
            &db,
            json!({"type":"import_research_batch","batch":single(url,url)}),
        );
    }
    for (field, value) in [
        ("doi", json!("not-a-doi")),
        ("doi", json!("https://evil.test/10.1234/id")),
        ("doi", json!("10.12/short")),
        ("arxivId", json!("2401.01234v0")),
        ("arxivId", json!("not-arxiv")),
        ("arxivId", json!("https://evil.test/abs/2401.01234")),
        ("year", json!(1.5)),
        ("year", json!(0)),
        ("year", json!(10000)),
        ("title", json!("  ")),
        ("title", json!("x".repeat(1001))),
        ("arxivId", json!("x".repeat(129))),
        ("abstract", json!("x".repeat(20001))),
        ("authors", json!("x".repeat(4001))),
        ("reason", json!("x".repeat(4001))),
        ("group", json!("x".repeat(201))),
        ("ref", json!("x".repeat(201))),
        (
            "url",
            json!(format!("https://example.org/{}", "x".repeat(4096))),
        ),
        ("notes", json!("not allowed")),
    ] {
        let mut input = batch("bad-field");
        input["papers"][0][field] = value;
        assert_rejected_unchanged(&db, json!({"type":"import_research_batch","batch":input}));
    }
    for (field, value) in [
        ("kind", json!("invented")),
        ("basis", json!("private_notes")),
        ("sourceRef", json!("missing")),
        ("targetRef", json!("a")),
        ("explanation", json!("")),
        ("explanation", json!("x".repeat(4001))),
        ("evidence", json!("x".repeat(8001))),
    ] {
        let mut input = batch("bad-edge");
        input["edges"][0][field] = value;
        assert_rejected_unchanged(&db, json!({"type":"import_research_batch","batch":input}));
    }
    for modification in 0..6 {
        let mut input = batch("bad-batch");
        match modification {
            0 => input["papers"] = json!([]),
            1 => input["papers"] = json!(vec![input["papers"][0].clone(); 101]),
            2 => input["papers"][1]["ref"] = json!("a"),
            3 => input["edges"] = json!(vec![input["edges"][0].clone(); 301]),
            4 => input["requestId"] = json!(""),
            _ => input["intent"] = json!("unscoped"),
        }
        assert_rejected_unchanged(&db, json!({"type":"import_research_batch","batch":input}));
    }
}

#[test]
fn context_requires_intent_and_exact_selection_without_private_data_or_neighbors() {
    let db = database();
    let imported = import(&db, batch("context"));
    let p = &imported["value"]["placements"];
    db.execute(
        "UPDATE papers SET file_path='papers/private.pdf' WHERE id=?1",
        [p[0]["paperId"].as_str().unwrap()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO notes VALUES ('private-note',?1,'Private notes',1)",
        [p[0]["paperId"].as_str().unwrap()],
    )
    .unwrap();
    for req in [
        json!({"type":"read_research_context","intent":"independent"}),
        json!({"type":"read_research_context","intent":"selected_papers"}),
        json!({"type":"read_research_context","intent":"selected_papers","paperIds":[]}),
        json!({"type":"read_research_context","intent":"gap_analysis","paperIds":[""]}),
        json!({"type":"read_research_context","intent":"gap_analysis","paperIds":vec!["paper";101]}),
    ] {
        assert_rejected_unchanged(&db, req);
    }
    let selected = ok(
        &db,
        json!({"type":"read_research_context","intent":"selected_papers","paperIds":[p[0]["paperId"]]}),
    );
    assert_eq!(selected["changed"], false);
    assert_eq!(selected["value"]["papers"].as_array().unwrap().len(), 1);
    assert_eq!(selected["value"]["papers"][0]["id"], p[0]["paperId"]);
    assert_eq!(selected["value"]["edges"], json!([]));
    assert_eq!(selected["value"]["truncated"], false);
    assert_eq!(
        ok(
            &db,
            json!({"type":"read_research_context","intent":"selected_papers","paperIds":["missing"]})
        )["value"]["papers"],
        json!([])
    );
    let both = ok(
        &db,
        json!({"type":"read_research_context","intent":"gap_analysis","paperIds":[p[1]["paperId"],p[0]["paperId"]]}),
    );
    assert_eq!(both["value"]["papers"].as_array().unwrap().len(), 2);
    assert_eq!(both["value"]["edges"].as_array().unwrap().len(), 1);
    for paper in both["value"]["papers"].as_array().unwrap() {
        assert_eq!(paper.as_object().unwrap().len(), 9);
        assert_eq!(paper["abstract"], "");
        assert_eq!(paper["abstractTruncated"], false);
    }
    let edge = &both["value"]["edges"][0];
    assert_eq!(edge["sourcePaperId"], p[0]["paperId"]);
    assert_eq!(edge["targetPaperId"], p[1]["paperId"]);
    assert_eq!(edge["kind"], "supports");
    assert_eq!(edge["aiSuggested"], true);
    assert_eq!(edge["basis"], "abstract");
    assert_eq!(edge.as_object().unwrap().len(), 6);
    ok(
        &db,
        json!({"type":"update_edge_relation","edgeId":edge["id"],"relation":"challenge"}),
    );
    let edited = ok(
        &db,
        json!({"type":"read_research_context","intent":"gap_analysis","paperIds":[p[0]["paperId"],p[1]["paperId"]]}),
    );
    assert_eq!(
        edited["value"]["edges"][0]["kind"], "challenges",
        "A user's relation change must take precedence over the original AI suggestion"
    );
    let serialized = both.to_string();
    for forbidden in [
        "Private",
        "filePath",
        "position",
        "domainId",
        "reason",
        "batchId",
        "explanation",
        "evidence",
        "papers/private.pdf",
    ] {
        assert!(!serialized.contains(forbidden), "{serialized}");
    }
    let whole = ok(
        &db,
        json!({"type":"read_research_context","intent":"gap_analysis"}),
    );
    assert_eq!(whole["value"]["papers"].as_array().unwrap().len(), 5);
    assert_rejected_unchanged(
        &db,
        json!({"type":"read_research_context","intent":"gap_analysis","paperIds":[]}),
    );
    for req in [
        json!({"type":"read_research_context","intent":"gap_analysis"}),
        json!({"type":"list_research_batches"}),
    ] {
        assert!(!serde_json::from_value::<WorkspaceRequest>(req)
            .unwrap()
            .is_mutation());
    }
}

#[test]
fn gap_context_caps_papers_and_edges_stay_within_the_returned_scope() {
    let db = database();
    for index in 0..105 {
        let id = format!("cap-{index:03}");
        db.execute(
            "INSERT INTO papers (id,title,created_at) VALUES (?1,'Title',1)",
            [&id],
        )
        .unwrap();
        db.execute(
            "INSERT INTO board_nodes VALUES (?1,'board-default',?1,0,0,280,128)",
            [&id],
        )
        .unwrap();
    }
    db.execute_batch("INSERT INTO papers (id,title,created_at) VALUES ('offboard','Off board',1);
        INSERT INTO board_edges (id,board_id,source_node_id,target_node_id,created_at) VALUES
        ('included','board-default','cap-000','cap-001',1),('excluded','board-default','cap-000','cap-104',1);").unwrap();
    let value = ok(
        &db,
        json!({"type":"read_research_context","intent":"gap_analysis"}),
    )["value"]
        .clone();
    assert_eq!(value["truncated"], true);
    assert_eq!(value["papers"].as_array().unwrap().len(), 100);
    assert_eq!(
        value["edges"],
        json!([{"id":"included","sourcePaperId":"cap-000","targetPaperId":"cap-001","kind":"related","aiSuggested":false,"basis":null}])
    );
    let scoped = ok(
        &db,
        json!({"type":"read_research_context","intent":"selected_papers","paperIds":["offboard","cap-104"]}),
    );
    assert_eq!(scoped["value"]["papers"].as_array().unwrap().len(), 2);
    assert_eq!(scoped["value"]["truncated"], false);
    assert_eq!(scoped["value"]["edges"], json!([]));
}

#[test]
fn context_abstract_budget_is_unicode_safe_and_separate_from_paper_truncation() {
    let db = database();
    let mut input = batch("abstract-budget");
    input["papers"][0]["abstract"] = json!("研🦀".repeat(2500));
    let imported = import(&db, input);
    let id = &imported["value"]["placements"][0]["paperId"];
    let selected = ok(
        &db,
        json!({"type":"read_research_context","intent":"selected_papers","paperIds":[id]}),
    );
    let paper = &selected["value"]["papers"][0];
    assert_eq!(paper["abstract"], "研🦀".repeat(2000));
    assert_eq!(paper["abstractTruncated"], true);
    assert_eq!(selected["value"]["truncated"], false);
    let gap = ok(
        &db,
        json!({"type":"read_research_context","intent":"gap_analysis","paperIds":[id]}),
    );
    assert_eq!(gap["value"]["papers"][0]["abstract"], "");
    assert_eq!(gap["value"]["papers"][0]["abstractTruncated"], false);
    let short = ok(
        &db,
        json!({"type":"read_research_context","intent":"selected_papers","paperIds":[imported["value"]["placements"][1]["paperId"]]}),
    );
    assert_eq!(short["value"]["papers"][0]["abstractTruncated"], false);
    assert!(serde_json::to_vec(&selected).unwrap().len() < 4 * 1024 * 1024);
}

#[test]
fn defaults_and_maximum_batch_counts_work_and_oversized_bridge_payloads_roll_back() {
    let db = database();
    let mut input = single("maximum", "https://example.org/unused");
    input.as_object_mut().unwrap().remove("intent");
    input["title"] = json!("a".repeat(1000));
    input["papers"] = json!((0..100).map(|n| json!({"ref":format!("p{n}"),"title":"Title","url":format!("https://example.org/{n}")})).collect::<Vec<_>>());
    input["edges"] = json!((0..300).map(|n| json!({"sourceRef":format!("p{}",n%99),"targetRef":"p99","kind":"related","explanation":"Metadata comparison"})).collect::<Vec<_>>());
    let imported = import(&db, input.clone());
    assert_eq!(imported["value"]["createdPapers"], 100);
    assert_eq!(imported["value"]["createdNodes"], 100);
    assert_eq!(imported["value"]["createdEdges"], 99);
    assert_eq!(imported["value"]["reusedEdges"], 201);
    for edge in board(&db)["value"]["edges"].as_array().unwrap() {
        assert_eq!(edge["research"]["basis"], "metadata");
    }
    assert_eq!(
        ok(&db, json!({"type":"list_research_batches"}))["value"][0]["intent"],
        "independent"
    );
    input["requestId"] = json!("oversized");
    for paper in input["papers"].as_array_mut().unwrap() {
        paper["abstract"] = json!("🦀".repeat(20000));
    }
    assert!(
        assert_rejected_unchanged(&db, json!({"type":"import_research_batch","batch":input}))
            .contains("4 MiB")
    );
    db.execute(
        "UPDATE papers SET title=?1 WHERE id='paper-attention'",
        ["x".repeat(4 * 1024 * 1024)],
    )
    .unwrap();
    assert!(assert_rejected_unchanged(&db,json!({"type":"read_research_context","intent":"selected_papers","paperIds":["paper-attention"]})).contains("4 MiB"));
}

#[test]
fn undo_only_deletes_created_cards_edges_and_is_idempotent_with_no_reimport() {
    let db = database();
    let first = import(&db, batch("undo-original"));
    let input = single("undo-mixed", "https://example.org/a");
    let mut mixed = input.clone();
    mixed["papers"]
        .as_array_mut()
        .unwrap()
        .push(json!({"ref":"new","title":"New","url":"https://example.org/new"}));
    mixed["edges"] =
        json!([{"sourceRef":"a","targetRef":"new","kind":"related","explanation":"New edge"}]);
    let old = board(&db);
    let imported = import(&db, mixed.clone());
    assert_eq!(imported["value"]["createdNodes"], 1);
    assert_eq!(imported["value"]["reusedNodes"], 1);
    let new_paper = &imported["value"]["placements"][1]["paperId"];
    db.execute(
        "INSERT INTO notes VALUES ('preserved-note',?1,'Keep my note',1)",
        [new_paper.as_str().unwrap()],
    )
    .unwrap();
    let saved_paper = paper(&db, new_paper);
    let undone = undo(&db, &imported["value"]["batchId"]).unwrap();
    assert_eq!(undone["changed"], true);
    assert!(undone["revision"].as_i64().unwrap() > imported["revision"].as_i64().unwrap());
    assert_eq!(board(&db)["value"], old["value"]);
    assert_eq!(paper(&db, new_paper), saved_paper);
    assert_eq!(
        db.query_row(
            "SELECT content FROM notes WHERE id='preserved-note'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "Keep my note"
    );
    assert_eq!(
        undo(&db, &imported["value"]["batchId"]).unwrap()["changed"],
        false
    );
    assert_eq!(
        assert_rejected_unchanged(&db, json!({"type":"import_research_batch","batch":mixed})),
        RESEARCH_BATCH_UNDONE
    );
    assert_eq!(
        ok(&db, json!({"type":"list_research_batches"}))["value"][0]["undone"],
        true
    );
    let readd = import(&db, {
        let mut input = single("new-key", "https://example.org/new");
        input["papers"][0]["title"] = json!("Another title");
        input
    });
    assert_eq!(readd["value"]["createdPapers"], 0);
    assert_eq!(readd["value"]["createdNodes"], 1);
    assert_ne!(
        readd["value"]["placements"][0]["nodeId"],
        imported["value"]["placements"][1]["nodeId"]
    );
    assert_eq!(paper(&db, new_paper), saved_paper);
    assert_eq!(
        undo(&db, &first["value"]["batchId"]).unwrap()["changed"],
        true
    );
}

#[test]
fn undo_rejects_entire_operation_after_card_edge_metadata_edits_or_outside_edges() {
    for change in 0..9 {
        let db = database();
        let imported = import(&db, batch("protected"));
        let p = &imported["value"]["placements"];
        let node = p[0]["nodeId"].as_str().unwrap();
        let paper = p[0]["paperId"].as_str().unwrap();
        let edge: String = db
            .query_row("SELECT edge_id FROM research_batch_edges", [], |row| {
                row.get(0)
            })
            .unwrap();
        match change {
            0 => {
                db.execute("UPDATE board_nodes SET x=x+1 WHERE id=?1", [node])
                    .unwrap();
            }
            1 => {
                db.execute("UPDATE board_nodes SET width=300 WHERE id=?1", [node])
                    .unwrap();
            }
            2 => {
                db.execute(
                    "UPDATE papers SET title='Manually renamed' WHERE id=?1",
                    [paper],
                )
                .unwrap();
            }
            3 => {
                db.execute(
                    "UPDATE board_edges SET explanation='Manual evidence' WHERE id=?1",
                    [&edge],
                )
                .unwrap();
            }
            4 => {
                db.execute(
                    "UPDATE board_edges SET relation_type='challenge' WHERE id=?1",
                    [&edge],
                )
                .unwrap();
            }
            5 => {
                ok(
                    &db,
                    json!({"type":"create_edge","sourceNodeId":node,"targetNodeId":"node-attention"}),
                );
            }
            6 => {
                db.execute("DELETE FROM board_nodes WHERE id=?1", [node])
                    .unwrap();
            }
            7 => {
                db.execute("UPDATE research_papers SET metadata=json_set(metadata,'$.reason','Changed') WHERE paper_id=?1",[paper]).unwrap();
            }
            _ => {
                db.execute("UPDATE research_edges SET metadata=json_set(metadata,'$.basis','full_text') WHERE edge_id=?1",[&edge]).unwrap();
            }
        }
        assert_eq!(
            assert_rejected_unchanged(
                &db,
                json!({"type":"undo_research_batch","batchId":imported["value"]["batchId"]})
            ),
            RESEARCH_UNDO_CONFLICT
        );
    }
}

#[test]
fn reuse_preserves_local_pdf_domain_positions_and_preexisting_edges_through_undo() {
    let db = database();
    db.execute_batch("UPDATE papers SET file_path='papers/preserved.pdf' WHERE id='paper-attention';
        INSERT INTO notes VALUES ('legacy-note','paper-attention','Saved note',1);
        INSERT INTO research_identities VALUES ('doi','10.1234/legacy-a','paper-attention');
        INSERT INTO research_identities VALUES ('doi','10.1234/legacy-b','paper-bert');
        INSERT INTO board_edges VALUES ('legacy-edge','board-default','node-bert','node-attention',1,'challenge','Local explanation','Local evidence');").unwrap();
    let before = board(&db);
    let input = json!({"requestId":"legacy","title":"Legacy reuse","intent":"selected_papers","papers":[
        {"ref":"a","title":"Different A","doi":"10.1234/legacy-a","url":"https://example.org/legacy-a"},
        {"ref":"b","title":"Different B","doi":"10.1234/legacy-b","url":"https://example.org/legacy-b"}],
        "edges":[{"sourceRef":"a","targetRef":"b","kind":"supports","explanation":"Replace attempt"}]});
    let imported = import(&db, input);
    assert_eq!(imported["value"]["createdPapers"], 0);
    assert_eq!(imported["value"]["createdNodes"], 0);
    assert_eq!(imported["value"]["createdEdges"], 0);
    assert_eq!(imported["value"]["reusedEdges"], 1);
    let with_metadata = board(&db);
    undo(&db, &imported["value"]["batchId"]).unwrap();
    assert_eq!(board(&db)["value"], with_metadata["value"]);
    assert_eq!(board(&db)["value"]["edges"], before["value"]["edges"]);
    let p = paper(&db, &json!("paper-attention"));
    assert_eq!(p["title"], "Attention Is All You Need");
    assert_eq!(p["filePath"], "papers/preserved.pdf");
    assert_eq!(
        db.query_row("SELECT content FROM notes", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "Saved note"
    );
}

#[test]
fn migration_0019_preserves_all_existing_rows_order_and_revision() {
    let db = Connection::open_in_memory().unwrap();
    for m in migrations().into_iter().filter(|m| m.version < 19) {
        db.execute_batch(m.sql).unwrap();
    }
    db.execute_batch("INSERT INTO paper_domains VALUES ('domain','Preserved',7,9);
        UPDATE papers SET file_path='papers/keep.pdf',domain_id='domain' WHERE id='paper-attention';
        INSERT INTO board_edges VALUES ('reverse','board-default','node-bert','node-attention',8,'support','First','Evidence 1');
        INSERT INTO board_edges VALUES ('forward','board-default','node-attention','node-bert',7,'challenge','Second','Evidence 2');
        INSERT INTO notes VALUES ('note','paper-attention','Keep notes',9);
        INSERT INTO paper_mermaid_maps VALUES ('paper-attention','mindmap',9);").unwrap();
    let tables = table_names(&db);
    let original = contents(&db, &tables);
    db.execute_batch(migrations().iter().find(|m| m.version == 19).unwrap().sql)
        .unwrap();
    assert_eq!(contents(&db, &tables), original);
    assert_eq!(
        db.query_row("PRAGMA foreign_key_check", [], |_| Ok(()))
            .optional()
            .unwrap(),
        None
    );
}

#[test]
fn batches_are_latest_twenty_and_metadata_updates_still_invalidate_revisions() {
    let db = database();
    let mut last = Value::Null;
    for n in 0..22 {
        last = import(
            &db,
            single(&format!("list-{n}"), "https://example.org/same"),
        );
    }
    let list = ok(&db, json!({"type":"list_research_batches"}));
    assert_eq!(list["value"].as_array().unwrap().len(), 20);
    assert_eq!(list["value"][0]["id"], last["value"]["batchId"]);
    let before = board(&db)["revision"].as_i64().unwrap();
    db.execute(
        "UPDATE research_papers SET metadata=json_set(metadata,'$.abstract','New public abstract')",
        [],
    )
    .unwrap();
    assert_eq!(board(&db)["revision"], before + 1);
    db.execute("UPDATE research_papers SET metadata=metadata", [])
        .unwrap();
    assert_eq!(board(&db)["revision"], before + 1);
}

#[tokio::test]
async fn backend_workspace_command_uses_the_same_research_contract() {
    let dir = std::env::temp_dir().join(format!("research-backend-{}", uuid::Uuid::new_v4()));
    let backend = paper_canvas_lib::backend::Backend::open(dir.clone())
        .await
        .unwrap();
    let response = backend.dispatch("workspace_command",&json!({"request":{"type":"import_research_batch","batch":batch("bridge")},"origin":"desktop"})).unwrap();
    assert_eq!(response["changed"], true);
    assert_eq!(response["value"]["createdPapers"], 2);
    let context = backend.dispatch("workspace_command",&json!({"request":{"type":"read_research_context","intent":"selected_papers","paperIds":[response["value"]["placements"][0]["paperId"]]}})).unwrap();
    assert_eq!(context["changed"], false);
    assert_eq!(context["value"]["papers"].as_array().unwrap().len(), 1);
    drop(backend);
    std::fs::remove_dir_all(dir).unwrap();
}
