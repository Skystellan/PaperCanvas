//! Shared workspace business operations, independent of either desktop transport.
//!
//! `revision` versions the default board snapshot, not the library catalog. New
//! off-board papers and edits to them leave it unchanged. Board nodes/edges,
//! metadata of papers on the board, and domain changes invalidate it through SQL
//! triggers, including legacy SQL writes. Reads return data and revision from one
//! snapshot; mutations check the optional revision after acquiring the write lock.
//! `changed` reports an actual committed mutation, independently of revision.
//! Transports notify when it is true, including off-board metadata changes.
//! `origin` belongs only to those notifications and conveys no authority.

use crate::research::{self, ContextIntent, EdgeResearch, PaperResearch, ResearchBatch};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    time::{SystemTime, UNIX_EPOCH},
};

pub const DEFAULT_BOARD_ID: &str = "board-default";
pub const WORKSPACE_CONFLICT: &str = "WORKSPACE_CONFLICT";

#[derive(Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WorkspaceRequest {
    ImportResearchBatch {
        batch: ResearchBatch,
    },
    ReadResearchContext {
        intent: ContextIntent,
        paper_ids: Option<Vec<String>>,
    },
    ListResearchBatches {},
    UndoResearchBatch {
        batch_id: String,
    },
    LoadBoard {},
    ListPapers {
        search_term: Option<String>,
    },
    GetPaper {
        id: String,
    },
    ListDomains {},
    CreateDomain {
        name: String,
    },
    RenameDomain {
        domain_id: String,
        name: String,
    },
    DeleteDomain {
        domain_id: String,
    },
    AssignPaper {
        paper_id: String,
        domain_id: Option<String>,
    },
    UpdatePaperTitle {
        paper_id: String,
        title: String,
    },
    CreatePaperNode {
        paper_id: String,
        position: Position,
    },
    CreateEdge {
        source_node_id: String,
        target_node_id: String,
    },
    UpdateEdgeRelation {
        edge_id: String,
        relation: Option<BoardEdgeRelation>,
    },
    UpdateEdgeAnnotations {
        edge_id: String,
        annotations: BoardEdgeAnnotations,
    },
    SaveNodePositions {
        updates: Vec<NodePositionUpdate>,
    },
    DeleteNodes {
        node_ids: Vec<String>,
    },
    DeleteEdges {
        edge_ids: Vec<String>,
    },
}

impl WorkspaceRequest {
    pub fn is_mutation(&self) -> bool {
        !matches!(
            self,
            Self::LoadBoard {}
                | Self::ListPapers { .. }
                | Self::GetPaper { .. }
                | Self::ListDomains {}
                | Self::ReadResearchContext { .. }
                | Self::ListResearchBatches {}
        )
    }
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Paper {
    pub id: String,
    pub title: String,
    pub authors: Option<String>,
    pub year: Option<i64>,
    pub file_path: Option<String>,
    pub domain_id: Option<String>,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub research: Option<PaperResearch>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PaperDomain {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub struct NodeSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoardNodeRecord {
    pub id: String,
    pub board_id: String,
    pub paper: Paper,
    pub position: Position,
    pub size: NodeSize,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BoardEdgeRelation {
    Support,
    Challenge,
}

impl BoardEdgeRelation {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Support => "support",
            Self::Challenge => "challenge",
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct BoardEdgeAnnotations {
    pub explanation: String,
    pub evidence: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoardEdgeRecord {
    pub id: String,
    pub board_id: String,
    pub source_node_id: String,
    pub target_node_id: String,
    pub relation: Option<BoardEdgeRelation>,
    pub explanation: String,
    pub evidence: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub research: Option<EdgeResearch>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct NodePositionUpdate {
    pub id: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct BoardSnapshot {
    pub nodes: Vec<BoardNodeRecord>,
    pub edges: Vec<BoardEdgeRecord>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(untagged)]
pub enum WorkspaceValue {
    Board(BoardSnapshot),
    Papers(Vec<Paper>),
    Paper(Option<Paper>),
    Domains(Vec<PaperDomain>),
    Domain(PaperDomain),
    Node(BoardNodeRecord),
    Edge(BoardEdgeRecord),
    Research(serde_json::Value),
    Empty,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct WorkspaceResponse {
    pub revision: i64,
    pub value: WorkspaceValue,
    pub changed: bool,
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn identifier(id: &str) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("Identifier must not be empty.".into());
    }
    Ok(())
}

fn identifiers<'a>(ids: impl Iterator<Item = &'a str>) -> Result<(), String> {
    let mut seen = HashSet::new();
    for id in ids {
        identifier(id)?;
        if !seen.insert(id) {
            return Err(format!("Duplicate identifier: {id}"));
        }
    }
    Ok(())
}

fn coordinates(x: f64, y: f64) -> Result<(), String> {
    if !x.is_finite() || !y.is_finite() {
        return Err("Coordinates must be finite.".into());
    }
    Ok(())
}

fn domain_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if !(1..=80).contains(&name.chars().count()) {
        return Err("领域名称必须为 1 到 80 个字符。".into());
    }
    Ok(name)
}

fn single_row(count: usize, message: impl Into<String>) -> Result<(), String> {
    if count != 1 {
        return Err(message.into());
    }
    Ok(())
}

const PAPER_EXISTS: &str = "SELECT EXISTS(SELECT 1 FROM papers WHERE id = ?1)";
const DOMAIN_EXISTS: &str = "SELECT EXISTS(SELECT 1 FROM paper_domains WHERE id = ?1)";
const NODE_EXISTS: &str =
    "SELECT EXISTS(SELECT 1 FROM board_nodes WHERE id = ?1 AND board_id = 'board-default')";
const EDGE_EXISTS: &str =
    "SELECT EXISTS(SELECT 1 FROM board_edges WHERE id = ?1 AND board_id = 'board-default')";

// UPDATE predicates skip unchanged values. Distinguish that successful no-op
// from a stale/missing ID without counting it as a semantic change.
fn update_existing(
    db: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
    exists_sql: &str,
    id: &str,
    stale: impl Into<String>,
) -> Result<(), String> {
    if db.execute(sql, params).map_err(err)? == 0
        && !db
            .query_row(exists_sql, [id], |row| row.get::<_, bool>(0))
            .map_err(err)?
    {
        return Err(stale.into());
    }
    Ok(())
}

fn paper(row: &Row<'_>) -> rusqlite::Result<Paper> {
    Ok(Paper {
        id: row.get("id")?,
        title: row.get("title")?,
        authors: row.get("authors")?,
        year: row.get("year")?,
        file_path: row.get("file_path")?,
        domain_id: row.get("domain_id")?,
        created_at: row.get("created_at")?,
        research: research::metadata(row)?,
    })
}

fn node(row: &Row<'_>) -> rusqlite::Result<BoardNodeRecord> {
    Ok(BoardNodeRecord {
        id: row.get("node_id")?,
        board_id: row.get("board_id")?,
        paper: paper(row)?,
        position: Position {
            x: row.get("x")?,
            y: row.get("y")?,
        },
        size: NodeSize {
            width: row.get("width")?,
            height: row.get("height")?,
        },
    })
}

fn edge(row: &Row<'_>) -> rusqlite::Result<BoardEdgeRecord> {
    let relation = match row.get::<_, Option<String>>("relation_type")?.as_deref() {
        Some("support") => Some(BoardEdgeRelation::Support),
        Some("challenge") => Some(BoardEdgeRelation::Challenge),
        None => None,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(BoardEdgeRecord {
        id: row.get("id")?,
        board_id: row.get("board_id")?,
        source_node_id: row.get("source_node_id")?,
        target_node_id: row.get("target_node_id")?,
        relation,
        explanation: row.get("explanation")?,
        evidence: row.get("evidence")?,
        research: research::metadata(row)?,
    })
}

fn domain(row: &Row<'_>) -> rusqlite::Result<PaperDomain> {
    Ok(PaperDomain {
        id: row.get("id")?,
        name: row.get("name")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

const SELECT_NODES: &str = "SELECT n.id AS node_id, n.board_id, n.x, n.y, n.width, n.height,
    p.id, p.title, p.authors, p.year, p.file_path, p.domain_id, p.created_at,
    (SELECT metadata FROM research_papers WHERE paper_id=p.id) AS research
    FROM board_nodes n JOIN papers p ON p.id = n.paper_id WHERE n.board_id = ?1";
const SELECT_EDGES: &str = "SELECT id, board_id, source_node_id, target_node_id,
    relation_type, explanation, evidence,
    (SELECT metadata FROM research_edges WHERE edge_id=board_edges.id) AS research
    FROM board_edges WHERE board_id = ?1";
const SELECT_PAPERS: &str = "SELECT id, title, authors, year, file_path, domain_id, created_at,
    (SELECT metadata FROM research_papers WHERE paper_id=papers.id) AS research FROM papers";

pub(crate) fn get_paper(db: &Connection, id: &str) -> Result<Option<Paper>, String> {
    identifier(id)?;
    db.query_row(&format!("{SELECT_PAPERS} WHERE id = ?1"), [id], paper)
        .optional()
        .map_err(err)
}

fn list<T>(
    db: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
    map: fn(&Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>, String> {
    db.prepare(sql)
        .map_err(err)?
        .query_map(params, map)
        .map_err(err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(err)
}

fn revision(db: &Connection) -> Result<i64, String> {
    db.query_row(
        "SELECT revision FROM workspace_revision WHERE id = 1",
        [],
        |row| row.get(0),
    )
    .map_err(err)
}

/// Execute against a migrated connection. All writes (including cascades and
/// revision increments) roll back on error. No IPC state or origin is required.
pub fn execute(
    db: &Connection,
    request: WorkspaceRequest,
    expected_revision: Option<i64>,
) -> Result<WorkspaceResponse, String> {
    db.pragma_update(None, "foreign_keys", true).map_err(err)?;
    let mutating = request.is_mutation();
    let behavior = if mutating {
        TransactionBehavior::Immediate
    } else {
        TransactionBehavior::Deferred
    };
    let transaction = Transaction::new_unchecked(db, behavior).map_err(err)?;
    let before = revision(&transaction)?;
    if mutating && expected_revision.is_some_and(|expected| expected != before) {
        return Err(WORKSPACE_CONFLICT.into());
    }
    let changes_before: i64 = transaction
        .query_row("SELECT total_changes()", [], |row| row.get(0))
        .map_err(err)?;
    let value = apply(&transaction, request)?;
    let revision = if mutating {
        revision(&transaction)?
    } else {
        before
    };
    let changes_after: i64 = transaction
        .query_row("SELECT total_changes()", [], |row| row.get(0))
        .map_err(err)?;
    transaction.commit().map_err(err)?;
    Ok(WorkspaceResponse {
        revision,
        value,
        changed: changes_after != changes_before,
    })
}

fn apply(db: &Transaction<'_>, request: WorkspaceRequest) -> Result<WorkspaceValue, String> {
    use WorkspaceRequest::*;
    match request {
        ImportResearchBatch { batch } => return research::import(db, batch).map(WorkspaceValue::Research),
        ReadResearchContext { intent, paper_ids } => return research::context(db, intent, paper_ids).map(WorkspaceValue::Research),
        ListResearchBatches {} => return research::batches(db).map(WorkspaceValue::Research),
        UndoResearchBatch { batch_id } => return research::undo(db, &batch_id).map(WorkspaceValue::Research),
        LoadBoard {} => return Ok(WorkspaceValue::Board(BoardSnapshot {
            nodes: list(db, &format!("{SELECT_NODES} ORDER BY n.id"), [DEFAULT_BOARD_ID], node)?,
            edges: list(db, &format!("{SELECT_EDGES} ORDER BY id"), [DEFAULT_BOARD_ID], edge)?,
        })),
        ListPapers { search_term } => return Ok(WorkspaceValue::Papers(list(
            db, &format!("{SELECT_PAPERS} WHERE title LIKE ?1 COLLATE NOCASE
                OR COALESCE(authors, '') LIKE ?1 COLLATE NOCASE
                ORDER BY created_at DESC, title COLLATE NOCASE ASC"),
            [format!("%{}%", search_term.as_deref().unwrap_or("").trim())], paper,
        )?)),
        GetPaper { id } => {
            return Ok(WorkspaceValue::Paper(get_paper(db, &id)?));
        }
        ListDomains {} => return Ok(WorkspaceValue::Domains(list(db,
            "SELECT id, name, created_at, updated_at FROM paper_domains ORDER BY name COLLATE NOCASE, id", [], domain,
        )?)),
        CreateDomain { name } => {
            let name = domain_name(&name)?.to_owned();
            let timestamp = now();
            let domain = PaperDomain { id: uuid::Uuid::new_v4().to_string(), name, created_at: timestamp, updated_at: timestamp };
            db.execute("INSERT INTO paper_domains (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
                params![domain.id, domain.name, timestamp]).map_err(err)?;
            return Ok(WorkspaceValue::Domain(domain));
        }
        RenameDomain { domain_id, name } => {
            identifier(&domain_id)?;
            let name = domain_name(&name)?;
            update_existing(db, "UPDATE paper_domains
                SET updated_at = MAX(updated_at, ?2), name = ?1 WHERE id = ?3 AND name IS NOT ?1",
                params![name, now(), domain_id], DOMAIN_EXISTS, &domain_id,
                "找不到要重命名的领域。")?;
        }
        DeleteDomain { domain_id } => {
            identifier(&domain_id)?;
            single_row(db.execute("DELETE FROM paper_domains WHERE id = ?1", [&domain_id]).map_err(err)?,
                "找不到要删除的领域。")?;
        }
        AssignPaper { paper_id, domain_id } => {
            identifier(&paper_id)?;
            if let Some(id) = &domain_id { identifier(id)?; }
            update_existing(db, "UPDATE papers SET domain_id = ?1 WHERE id = ?2 AND domain_id IS NOT ?1",
                params![domain_id, paper_id], PAPER_EXISTS, &paper_id,
                "找不到要归类的论文。")?;
        }
        UpdatePaperTitle { paper_id, title } => {
            identifier(&paper_id)?;
            if title.trim().is_empty() { return Err("Paper title must not be empty.".into()); }
            update_existing(db, "UPDATE papers SET title = ?1 WHERE id = ?2 AND title IS NOT ?1",
                params![title, paper_id], PAPER_EXISTS, &paper_id,
                "Paper not found.")?;
        }
        CreatePaperNode { paper_id, position } => {
            identifier(&paper_id)?;
            coordinates(position.x, position.y)?;
            let sql = format!("{SELECT_NODES} AND p.id = ?2");
            if let Some(existing) = db.query_row(&sql, params![DEFAULT_BOARD_ID, paper_id], node).optional().map_err(err)? {
                return Ok(WorkspaceValue::Node(existing));
            }
            db.execute("INSERT INTO board_nodes (id, board_id, paper_id, x, y, width, height)
                VALUES (?1, ?2, ?3, ?4, ?5, 280, 128)",
                params![uuid::Uuid::new_v4().to_string(), DEFAULT_BOARD_ID, paper_id, position.x, position.y]).map_err(err)?;
            return Ok(WorkspaceValue::Node(db.query_row(&sql, params![DEFAULT_BOARD_ID, paper_id], node).map_err(err)?));
        }
        CreateEdge { source_node_id, target_node_id } => {
            identifier(&source_node_id)?;
            identifier(&target_node_id)?;
            if source_node_id == target_node_id { return Err("A paper card cannot connect to itself.".into()); }
            let count: i64 = db.query_row("SELECT COUNT(*) FROM board_nodes WHERE board_id = ?1 AND id IN (?2, ?3)",
                params![DEFAULT_BOARD_ID, source_node_id, target_node_id], |row| row.get(0)).map_err(err)?;
            if count != 2 { return Err("Edge endpoints must exist on the default board.".into()); }
            // Legacy reverse duplicates remain intact. Both orientations choose
            // the same oldest record, including its annotations and relation.
            let sql = format!("{SELECT_EDGES} AND ((source_node_id = ?2 AND target_node_id = ?3)
                OR (source_node_id = ?3 AND target_node_id = ?2)) ORDER BY created_at, id LIMIT 1");
            if let Some(existing) = db.query_row(&sql, params![DEFAULT_BOARD_ID, source_node_id, target_node_id], edge).optional().map_err(err)? {
                return Ok(WorkspaceValue::Edge(existing));
            }
            let id = uuid::Uuid::new_v4().to_string();
            db.execute("INSERT INTO board_edges (id, board_id, source_node_id, target_node_id, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5)", params![id, DEFAULT_BOARD_ID, source_node_id, target_node_id, now()]).map_err(err)?;
            return Ok(WorkspaceValue::Edge(BoardEdgeRecord {
                id, board_id: DEFAULT_BOARD_ID.into(), source_node_id, target_node_id,
                relation: None, explanation: String::new(), evidence: String::new(),
                research: None,
            }));
        }
        UpdateEdgeRelation { edge_id, relation } => {
            identifier(&edge_id)?;
            update_existing(db, "UPDATE board_edges SET relation_type = ?1 WHERE id = ?2 AND board_id = ?3 AND relation_type IS NOT ?1",
                params![relation.as_ref().map(BoardEdgeRelation::as_str), edge_id, DEFAULT_BOARD_ID], EDGE_EXISTS, &edge_id,
                format!("Board edge relation is stale: {edge_id}"))?;
        }
        UpdateEdgeAnnotations { edge_id, annotations } => {
            identifier(&edge_id)?;
            update_existing(db, "UPDATE board_edges SET explanation = ?1, evidence = ?2 WHERE id = ?3 AND board_id = ?4
                AND (explanation IS NOT ?1 OR evidence IS NOT ?2)",
                params![annotations.explanation, annotations.evidence, edge_id, DEFAULT_BOARD_ID], EDGE_EXISTS, &edge_id,
                format!("Board edge annotations are stale: {edge_id}"))?;
        }
        SaveNodePositions { updates } => {
            identifiers(updates.iter().map(|update| update.id.as_str()))?;
            for update in updates {
                coordinates(update.x, update.y)?;
                update_existing(db, "UPDATE board_nodes SET x = ?1, y = ?2 WHERE id = ?3 AND board_id = ?4 AND (x IS NOT ?1 OR y IS NOT ?2)",
                    params![update.x, update.y, update.id, DEFAULT_BOARD_ID], NODE_EXISTS, &update.id,
                    format!("Board node snapshot is stale: {}", update.id))?;
            }
        }
        DeleteNodes { node_ids } => {
            identifiers(node_ids.iter().map(String::as_str))?;
            for id in node_ids {
                single_row(db.execute("DELETE FROM board_nodes WHERE id = ?1 AND board_id = ?2", params![id, DEFAULT_BOARD_ID]).map_err(err)?,
                    format!("Board node deletion is stale: {id}"))?;
            }
        }
        DeleteEdges { edge_ids } => {
            identifiers(edge_ids.iter().map(String::as_str))?;
            for id in edge_ids {
                single_row(db.execute("DELETE FROM board_edges WHERE id = ?1 AND board_id = ?2", params![id, DEFAULT_BOARD_ID]).map_err(err)?,
                    format!("Board edge deletion is stale: {id}"))?;
            }
        }
    }
    Ok(WorkspaceValue::Empty)
}

#[cfg(feature = "tauri-shell")]
#[tauri::command(async)]
pub fn workspace_command(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    request: WorkspaceRequest,
    expected_revision: Option<i64>,
    origin: Option<String>,
) -> Result<WorkspaceResponse, String> {
    use tauri::{Emitter, Manager};
    if webview.label() != "main" {
        return Err("Only the main webview can access the workspace.".into());
    }
    let path = app
        .path()
        .app_config_dir()
        .map_err(err)?
        .join("papercanvas.db");
    let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(err)?;
    db.busy_timeout(std::time::Duration::from_secs(3))
        .map_err(err)?;
    let response = execute(&db, request, expected_revision)?;
    if response.changed {
        // A failed notification cannot turn an already committed write into an
        // apparent failure. Origin is attribution only, never a trust check.
        if let Err(error) = app.emit(
            "workspace-changed",
            serde_json::json!({"revision": response.revision, "origin": origin}),
        ) {
            eprintln!("Could not emit workspace-changed: {error}");
        }
    }
    Ok(response)
}
