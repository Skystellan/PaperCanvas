//! Research operations run only inside the shared workspace transaction.
//! Import responses contain counts and IDs; context has an explicit allowlist.

use crate::workspace::DEFAULT_BOARD_ID;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    time::{SystemTime, UNIX_EPOCH},
};
use url::Url;

pub const RESEARCH_IDENTITY_CONFLICT: &str = "RESEARCH_IDENTITY_CONFLICT";
pub const RESEARCH_REQUEST_CONFLICT: &str = "RESEARCH_REQUEST_CONFLICT";
pub const RESEARCH_BATCH_UNDONE: &str = "RESEARCH_BATCH_UNDONE";
pub const RESEARCH_UNDO_CONFLICT: &str = "RESEARCH_UNDO_CONFLICT";
// Leave room for the workspace/transport envelope in the 4 MiB local bridge.
const MAX_PAYLOAD_BYTES: usize = 4 * 1024 * 1024 - 1024;

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResearchIntent {
    #[default]
    Independent,
    SelectedPapers,
    GapAnalysis,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextIntent {
    SelectedPapers,
    GapAnalysis,
    CodeReview,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CodeStatus {
    Official,
    ThirdParty,
    NotFound,
    NotReleased,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeReview {
    pub status: CodeStatus,
    pub evidence_url: String,
    pub evidence: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PaperCodeReview {
    #[serde(flatten)]
    pub review: CodeReview,
    pub checked_at: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeReviewUpdate {
    pub paper_id: String,
    pub expected_github_url: Option<String>,
    pub github_url: Option<String>,
    pub github_stars: Option<i64>,
    pub code_review: CodeReview,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResearchKind {
    Related,
    Extends,
    Compares,
    Uses,
    Cites,
    Supports,
    Challenges,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResearchBasis {
    #[default]
    Metadata,
    Abstract,
    FullText,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResearchBatch {
    pub request_id: String,
    pub title: String,
    #[serde(default)]
    pub intent: ResearchIntent,
    pub papers: Vec<ResearchPaperInput>,
    #[serde(default)]
    pub edges: Vec<ResearchEdgeInput>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResearchPaperInput {
    #[serde(rename = "ref")]
    pub reference: String,
    pub title: String,
    pub authors: Option<String>,
    pub year: Option<i64>,
    pub doi: Option<String>,
    pub arxiv_id: Option<String>,
    pub url: String,
    #[serde(rename = "abstract")]
    pub abstract_text: Option<String>,
    pub reason: Option<String>,
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github_stars: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResearchEdgeInput {
    pub source_ref: String,
    pub target_ref: String,
    pub kind: ResearchKind,
    pub explanation: String,
    pub evidence: Option<String>,
    #[serde(default)]
    pub basis: ResearchBasis,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PaperResearch {
    pub doi: Option<String>,
    pub arxiv_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arxiv_version: Option<String>,
    pub url: String,
    #[serde(rename = "abstract")]
    pub abstract_text: String,
    pub reason: String,
    pub group: String,
    pub batch_id: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EdgeResearch {
    pub kind: String,
    pub basis: String,
    pub batch_id: String,
}

pub(crate) fn metadata<T: serde::de::DeserializeOwned>(
    row: &Row<'_>,
    column: &str,
) -> rusqlite::Result<Option<T>> {
    row.get::<_, Option<String>>(column)?
        .map(|text| {
            serde_json::from_str(&text).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })
        })
        .transpose()
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn text_limit(value: &str, name: &str, max: usize, required: bool) -> Result<(), String> {
    if value.chars().count() > max || (required && value.trim().is_empty()) || value.contains('\0')
    {
        return Err(format!(
            "Invalid {name}: maximum {max} characters; required={required}."
        ));
    }
    Ok(())
}

// Decode percent escapes for identifiers; URLs retain reserved escapes and
// normalize unreserved characters and escape case for stable comparison.
fn percent_normalize(value: &str, identifier: bool) -> Result<String, String> {
    let mut bytes = Vec::with_capacity(value.len());
    let mut input = value.bytes();
    while let Some(byte) = input.next() {
        if byte != b'%' {
            bytes.push(byte);
            continue;
        }
        let hi = input.next().and_then(|b| (b as char).to_digit(16));
        let lo = input.next().and_then(|b| (b as char).to_digit(16));
        let (Some(hi), Some(lo)) = (hi, lo) else {
            return Err("Invalid percent escape.".into());
        };
        let decoded = (hi * 16 + lo) as u8;
        if decoded.is_ascii_control() {
            return Err("Control characters are not allowed in URLs or identifiers.".into());
        }
        if identifier || decoded.is_ascii_alphanumeric() || b"-._~".contains(&decoded) {
            bytes.push(decoded);
        } else {
            bytes.extend_from_slice(format!("%{decoded:02X}").as_bytes());
        }
    }
    String::from_utf8(bytes).map_err(err)
}

fn source_url(value: &str) -> Result<Url, String> {
    text_limit(value, "url", 4096, true)?;
    if value.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("URLs cannot contain whitespace or control characters.".into());
    }
    let normalized = percent_normalize(value, false)?;
    let mut url = Url::parse(&normalized).map_err(|_| "Invalid source URL.".to_string())?;
    let authority = value
        .split_once("://")
        .map(|(_, tail)| tail.split(['/', '?', '#']).next().unwrap_or(""));
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || authority.is_none_or(|part| part.is_empty() || part.contains('@') || part.contains('\\'))
    {
        return Err("Source URL must be HTTP(S) without credentials.".into());
    }
    url.set_fragment(None);
    Ok(url)
}

pub(crate) fn validate_github(value: Option<&str>, stars: Option<i64>) -> Result<(), String> {
    if let Some(value) = value {
        let url = source_url(value)?;
        // Inspect the supplied path before URL parsing can collapse dot segments.
        let path = value.split_once("://").and_then(|(_, tail)| tail.split_once('/'))
            .map(|(_, path)| path).unwrap_or("");
        let parts: Vec<_> = path.strip_suffix('/').unwrap_or(path).split('/').collect();
        if url.scheme() != "https" || url.host_str() != Some("github.com")
            || url.port().is_some() || url.query().is_some() || value.contains('#')
            || parts.len() != 2 || parts.iter().any(|part| part.is_empty() || *part == "." || *part == "..")
            || !parts[0].bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
            || !parts[1].bytes().all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
        {
            return Err("请输入 GitHub 仓库链接：https://github.com/owner/repo".into());
        }
    }
    if stars.is_some_and(|stars| value.is_none() || !(0..=9_007_199_254_740_991).contains(&stars)) {
        return Err("Stars 必须是非负整数，并关联一个 GitHub 仓库。".into());
    }
    Ok(())
}

fn validate_code_review(review: &CodeReview, github_url: Option<&str>) -> Result<(), String> {
    source_url(&review.evidence_url)?;
    text_limit(&review.evidence, "code review evidence", 4000, true)?;
    let has_code = matches!(review.status, CodeStatus::Official | CodeStatus::ThirdParty);
    if has_code != github_url.is_some() {
        return Err("Official/third-party reviews require a repository; not-found/not-released reviews must omit it.".into());
    }
    Ok(())
}

fn reviewed_at(review: &CodeReview) -> Result<String, String> {
    let mut value = serde_json::to_value(review).map_err(err)?;
    value["checkedAt"] = json!(SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64);
    Ok(value.to_string())
}

pub(crate) fn review_code(db: &Connection, updates: Vec<CodeReviewUpdate>) -> Result<Value, String> {
    if updates.is_empty() || updates.len() > 100 {
        return Err("Code reviews require 1–100 papers.".into());
    }
    let mut ids = HashSet::new();
    for update in &updates {
        text_limit(&update.paper_id, "paperId", 200, true)?;
        if !ids.insert(&update.paper_id) {
            return Err("Duplicate paperId.".into());
        }
        validate_github(update.github_url.as_deref(), update.github_stars)?;
        validate_code_review(&update.code_review, update.github_url.as_deref())?;
        let current: Option<String> = db.query_row("SELECT github_url FROM papers WHERE id=?1",
            [&update.paper_id], |row| row.get(0)).optional().map_err(err)?.ok_or("Paper not found.")?;
        if current != update.expected_github_url {
            return Err("CODE_REVIEW_CONFLICT: Repository changed; read context again before saving.".into());
        }
        if current.is_some() && matches!(update.code_review.status, CodeStatus::NotFound) {
            return Err("A failed search cannot remove an existing repository. Verify the recorded link first.".into());
        }
        // Preserve the live Stars snapshot when reviewing the same repository without a newer count.
        db.execute("UPDATE papers SET github_stars=CASE WHEN github_url IS ?1 AND ?2 IS NULL THEN github_stars ELSE ?2 END,
            github_url=?1, code_review=?3 WHERE id=?4",
            params![update.github_url, update.github_stars, reviewed_at(&update.code_review)?, update.paper_id]).map_err(err)?;
    }
    Ok(json!({"updatedPapers":updates.len()}))
}

fn doi(value: &str) -> Result<String, String> {
    text_limit(value, "doi", 512, true)?;
    if value.chars().any(char::is_control) {
        return Err("Invalid DOI.".into());
    }
    let mut value = value.trim().to_ascii_lowercase();
    if let Some(rest) = value.strip_prefix("doi:") {
        value = rest.trim().into();
    }
    if value.starts_with("http://") || value.starts_with("https://") {
        let url = source_url(&value)?;
        if !matches!(url.host_str(), Some("doi.org" | "dx.doi.org")) {
            return Err("Invalid DOI URL.".into());
        }
        value = percent_normalize(url.path().trim_start_matches('/'), true)?;
    }
    value = value.to_ascii_lowercase();
    let Some((registrant, suffix)) = value.split_once('/') else {
        return Err("Invalid DOI.".into());
    };
    let digits = registrant.strip_prefix("10.").unwrap_or("");
    if !(4..=9).contains(&digits.len())
        || !digits.bytes().all(|c| c.is_ascii_digit())
        || suffix.is_empty()
        || value.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("Invalid DOI.".into());
    }
    Ok(value)
}

fn arxiv(value: &str) -> Result<String, String> {
    arxiv_document(value).map(|(base, _)| base)
}

// Share identity validation while retaining the version needed by PDF readers.
pub(crate) fn arxiv_document(value: &str) -> Result<(String, Option<String>), String> {
    text_limit(value, "arxivId", 128, true)?;
    if value.chars().any(char::is_control) {
        return Err("Invalid arXiv ID.".into());
    }
    let mut value = value.trim().to_ascii_lowercase();
    if let Some(rest) = value.strip_prefix("arxiv:") {
        value = rest.trim().into();
    }
    if value.starts_with("http://") || value.starts_with("https://") {
        let url = source_url(&value)?;
        if !matches!(
            url.host_str(),
            Some("arxiv.org" | "www.arxiv.org" | "export.arxiv.org")
        ) {
            return Err("Invalid arXiv URL.".into());
        }
        value = percent_normalize(url.path().trim_start_matches('/'), true)?;
        value = value
            .strip_prefix("abs/")
            .or_else(|| value.strip_prefix("pdf/"))
            .ok_or("Invalid arXiv URL path.")?
            .into();
    }
    value = value.to_ascii_lowercase();
    if let Some(base) = value.strip_suffix(".pdf") {
        value = base.into();
    }
    let mut document_version = None;
    if let Some((base, version)) = value.rsplit_once('v') {
        if !version.is_empty() && version.bytes().all(|c| c.is_ascii_digit()) {
            if version.starts_with('0') {
                return Err("Invalid arXiv version.".into());
            }
            document_version = Some(version.to_owned());
            value = base.into();
        }
    }
    let digits = |s: &str| s.bytes().all(|c| c.is_ascii_digit());
    let valid = if let Some((date, number)) = value.split_once('.') {
        // Old IDs may contain a dot in the archive name, so check below too.
        date.len() == 4 && digits(date) && matches!(number.len(), 4 | 5) && digits(number)
    } else {
        false
    };
    let valid_old = value.split_once('/').is_some_and(|(archive, number)| {
        !archive.is_empty()
            && archive
                .bytes()
                .all(|c| c.is_ascii_alphabetic() || b".-".contains(&c))
            && number.len() == 7
            && digits(number)
    });
    if !valid && !valid_old {
        return Err("Invalid arXiv ID.".into());
    }
    Ok((value, document_version))
}

struct Identity {
    doi: Option<String>,
    arxiv: Option<String>,
    url: String,
}

impl Identity {
    fn for_paper(paper: &ResearchPaperInput) -> Result<Self, String> {
        let url = source_url(&paper.url)?;
        let mut doi_id = paper.doi.as_deref().map(doi).transpose()?;
        let mut arxiv_id = paper.arxiv_id.as_deref().map(arxiv).transpose()?;
        // Recognized source URLs also assert an identity. Explicit IDs must agree.
        let inferred = match url.host_str() {
            Some("doi.org" | "dx.doi.org") => Some((&mut doi_id, doi(url.as_str())?)),
            Some("arxiv.org" | "www.arxiv.org" | "export.arxiv.org")
                if url.path().starts_with("/abs/") || url.path().starts_with("/pdf/") =>
            {
                Some((&mut arxiv_id, arxiv(url.as_str())?))
            }
            _ => None,
        };
        if let Some((explicit, inferred)) = inferred {
            if explicit.as_ref().is_some_and(|id| id != &inferred) {
                return Err(RESEARCH_IDENTITY_CONFLICT.into());
            }
            *explicit = Some(inferred);
        }
        Ok(Self {
            doi: doi_id,
            arxiv: arxiv_id,
            url: url.into(),
        })
    }

    fn keys(&self) -> Vec<(&str, &str)> {
        let mut keys = vec![("url", self.url.as_str())];
        if let Some(id) = &self.doi {
            keys.push(("doi", id));
        }
        if let Some(id) = &self.arxiv {
            keys.push(("arxiv", id));
        }
        keys
    }
}

fn validate(batch: &ResearchBatch) -> Result<Vec<Identity>, String> {
    text_limit(&batch.request_id, "requestId", 200, true)?;
    text_limit(&batch.title, "batch title", 1000, true)?;
    if batch.papers.is_empty() || batch.papers.len() > 100 || batch.edges.len() > 300 {
        return Err("Research batches require 1–100 papers and at most 300 edges.".into());
    }
    let mut refs = HashSet::new();
    let mut identities = Vec::new();
    for paper in &batch.papers {
        text_limit(&paper.reference, "ref", 200, true)?;
        if !refs.insert(&paper.reference) {
            return Err("Duplicate paper ref.".into());
        }
        text_limit(&paper.title, "paper title", 1000, true)?;
        for (value, name, max) in [
            (&paper.authors, "authors", 4000),
            (&paper.abstract_text, "abstract", 20000),
            (&paper.reason, "reason", 4000),
            (&paper.group, "group", 200),
        ] {
            if let Some(value) = value {
                text_limit(value, name, max, false)?;
            }
        }
        if paper.year.is_some_and(|year| !(1..=9999).contains(&year)) {
            return Err("Invalid publication year.".into());
        }
        validate_github(paper.github_url.as_deref(), paper.github_stars)?;
        identities.push(Identity::for_paper(paper)?);
    }
    for edge in &batch.edges {
        text_limit(&edge.source_ref, "sourceRef", 200, true)?;
        text_limit(&edge.target_ref, "targetRef", 200, true)?;
        if edge.source_ref == edge.target_ref
            || !refs.contains(&edge.source_ref)
            || !refs.contains(&edge.target_ref)
        {
            return Err("Edge endpoints must be distinct refs in this batch.".into());
        }
        text_limit(&edge.explanation, "explanation", 4000, true)?;
        if let Some(evidence) = &edge.evidence {
            text_limit(evidence, "evidence", 8000, false)?;
        }
    }
    Ok(identities)
}

fn resolve(db: &Connection, identity: &Identity) -> Result<Option<String>, String> {
    let mut paper = None;
    for (kind, id) in identity.keys() {
        let candidate: Option<String> = db
            .query_row(
                "SELECT paper_id FROM research_identities WHERE kind=?1 AND identity=?2",
                params![kind, id],
                |row| row.get(0),
            )
            .optional()
            .map_err(err)?;
        if let Some(candidate) = candidate {
            if paper
                .as_ref()
                .is_some_and(|existing| existing != &candidate)
            {
                return Err(RESEARCH_IDENTITY_CONFLICT.into());
            }
            paper = Some(candidate);
        }
    }
    if let Some(paper) = &paper {
        for (kind, id) in identity
            .keys()
            .into_iter()
            .filter(|(kind, _)| *kind != "url")
        {
            let existing: Option<String> = db
                .query_row(
                    "SELECT identity FROM research_identities WHERE paper_id=?1 AND kind=?2",
                    params![paper, kind],
                    |row| row.get(0),
                )
                .optional()
                .map_err(err)?;
            if existing.as_deref().is_some_and(|existing| existing != id) {
                return Err(RESEARCH_IDENTITY_CONFLICT.into());
            }
        }
    }
    Ok(paper)
}

const NODE_SNAPSHOT: &str = "SELECT json_array(n.id,n.board_id,n.paper_id,n.x,n.y,n.width,n.height,
    p.title,p.authors,p.year,p.file_path,p.created_at,p.domain_id,r.metadata,p.github_url,p.github_stars,p.code_review)
    FROM board_nodes n JOIN papers p ON p.id=n.paper_id
    LEFT JOIN research_papers r ON r.paper_id=p.id WHERE n.id=?1";
const EDGE_SNAPSHOT: &str = "SELECT json_array(e.id,e.board_id,e.source_node_id,e.target_node_id,
    e.created_at,e.relation_type,e.explanation,e.evidence,r.metadata)
    FROM board_edges e LEFT JOIN research_edges r ON r.edge_id=e.id WHERE e.id=?1";

pub(crate) fn import(db: &Connection, batch: ResearchBatch) -> Result<Value, String> {
    let identities = validate(&batch)?;
    // Serialize typed input before normalization. Retrying reordered JSON keys is
    // harmless, but a different title/abstract/order under the same key is not.
    let body = serde_json::to_string(&batch).map_err(err)?;
    if body.len() > MAX_PAYLOAD_BYTES {
        return Err("Research batch exceeds the 4 MiB bridge limit.".into());
    }
    let previous: Option<(String, String, bool)> = db
        .query_row(
            "SELECT request_json,response_json,undone FROM research_batches WHERE request_id=?1",
            [&batch.request_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(err)?;
    if let Some((original, response, undone)) = previous {
        if undone {
            return Err(RESEARCH_BATCH_UNDONE.into());
        }
        if original != body {
            return Err(RESEARCH_REQUEST_CONFLICT.into());
        }
        let mut response: Value = serde_json::from_str(&response).map_err(err)?;
        response["replayed"] = json!(true);
        return Ok(response);
    }
    let batch_id = uuid::Uuid::new_v4().to_string();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let intent = serde_json::to_value(&batch.intent).map_err(err)?;
    db.execute("INSERT INTO research_batches
        (id,request_id,request_json,title,intent,created_at,response_json) VALUES (?1,?2,?3,?4,?5,?6,'{}')",
        params![batch_id,batch.request_id,body,batch.title,intent.as_str(),timestamp]).map_err(err)?;
    let right: f64 = db
        .query_row(
            "SELECT COALESCE(MAX(x+width),0) FROM board_nodes WHERE board_id=?1",
            [DEFAULT_BOARD_ID],
            |row| row.get(0),
        )
        .map_err(err)?;
    let start_x = right + 240.0;
    if !start_x.is_finite() {
        return Err("Existing board bounds are not finite.".into());
    }
    let mut groups: Vec<&str> = Vec::new();
    for paper in &batch.papers {
        let group = paper.group.as_deref().unwrap_or("");
        if !groups.contains(&group) {
            groups.push(group);
        }
    }
    let mut placements: Vec<Option<Value>> = vec![None; batch.papers.len()];
    let mut refs: HashMap<&str, String> = HashMap::new();
    let mut new_nodes = Vec::new();
    let mut new_edges = Vec::new();
    let mut created_papers = 0;
    let mut y = 0.0;
    // Stable first-seen group order, then original input order. Three columns;
    // a blank row separates groups. Reused cards do not consume grid cells.
    for group in groups {
        let mut cell = 0;
        for (index, (paper, identity)) in batch
            .papers
            .iter()
            .zip(&identities)
            .enumerate()
            .filter(|(_, (paper, _))| paper.group.as_deref().unwrap_or("") == group)
        {
            let paper_id = match resolve(db, identity)? {
                Some(id) => id,
                None => {
                    let id = uuid::Uuid::new_v4().to_string();
                    db.execute(
                        "INSERT INTO papers (id,title,authors,year,file_path,created_at,domain_id,github_url,github_stars)
                        VALUES (?1,?2,?3,?4,NULL,?5,NULL,?6,?7)",
                        params![id, paper.title, paper.authors, paper.year, timestamp, paper.github_url, paper.github_stars],
                    )
                    .map_err(err)?;
                    created_papers += 1;
                    id
                }
            };
            // Enrich older imports, but never overwrite a repository the user already recorded.
            if let Some(url) = &paper.github_url {
                db.execute("UPDATE papers SET github_url=?1, github_stars=?2, code_review=NULL WHERE id=?3 AND github_url IS NULL",
                    params![url, paper.github_stars, paper_id]).map_err(err)?;
            }
            for (kind, id) in identity.keys() {
                db.execute(
                    "INSERT INTO research_identities (kind,identity,paper_id) VALUES (?1,?2,?3)
                    ON CONFLICT(kind,identity) DO NOTHING",
                    params![kind, id, paper_id],
                )
                .map_err(err)?;
            }
            let details = PaperResearch {
                doi: identity.doi.clone(),
                arxiv_id: identity.arxiv.clone(),
                arxiv_version: paper
                    .arxiv_id
                    .as_deref()
                    .map(arxiv_document)
                    .transpose()?
                    .and_then(|(_, version)| version),
                url: identity.url.clone(),
                abstract_text: paper.abstract_text.clone().unwrap_or_default(),
                reason: paper.reason.clone().unwrap_or_default(),
                group: group.into(),
                batch_id: batch_id.clone(),
            };
            db.execute(
                "INSERT INTO research_papers (paper_id,metadata) VALUES (?1,?2)
                ON CONFLICT(paper_id) DO NOTHING",
                params![paper_id, serde_json::to_string(&details).map_err(err)?],
            )
            .map_err(err)?;
            let existing: Option<String> = db
                .query_row(
                    "SELECT id FROM board_nodes WHERE board_id=?1 AND paper_id=?2",
                    params![DEFAULT_BOARD_ID, paper_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(err)?;
            let node_id = match existing {
                Some(id) => id,
                None => {
                    let id = uuid::Uuid::new_v4().to_string();
                    db.execute(
                        "INSERT INTO board_nodes (id,board_id,paper_id,x,y,width,height)
                        VALUES (?1,?2,?3,?4,?5,280,128)",
                        params![
                            id,
                            DEFAULT_BOARD_ID,
                            paper_id,
                            start_x + (cell % 3) as f64 * 360.0,
                            y + (cell / 3) as f64 * 210.0
                        ],
                    )
                    .map_err(err)?;
                    cell += 1;
                    new_nodes.push(id.clone());
                    id
                }
            };
            placements[index] =
                Some(json!({"ref":paper.reference,"paperId":paper_id,"nodeId":node_id}));
            refs.insert(&paper.reference, node_id);
        }
        if cell > 0 {
            y += ((cell + 2) / 3 + 1) as f64 * 210.0;
        }
    }
    for edge in &batch.edges {
        let source = &refs[edge.source_ref.as_str()];
        let target = &refs[edge.target_ref.as_str()];
        if source == target {
            return Err("Edge refs resolve to the same paper.".into());
        }
        let existing: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM board_edges WHERE board_id=?1
            AND ((source_node_id=?2 AND target_node_id=?3) OR (source_node_id=?3 AND target_node_id=?2)))",
            params![DEFAULT_BOARD_ID,source,target], |row| row.get(0)).map_err(err)?;
        if existing {
            continue;
        }
        let id = uuid::Uuid::new_v4().to_string();
        let relation = match edge.kind {
            ResearchKind::Supports => Some("support"),
            ResearchKind::Challenges => Some("challenge"),
            _ => None,
        };
        db.execute("INSERT INTO board_edges (id,board_id,source_node_id,target_node_id,created_at,relation_type,explanation,evidence)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![id,DEFAULT_BOARD_ID,source,target,timestamp,relation,edge.explanation,edge.evidence.as_deref().unwrap_or("")]).map_err(err)?;
        let details = json!({"kind":edge.kind,"basis":edge.basis,"batchId":batch_id});
        db.execute(
            "INSERT INTO research_edges (edge_id,metadata) VALUES (?1,?2)",
            params![id, details.to_string()],
        )
        .map_err(err)?;
        new_edges.push(id);
    }
    for (ids, table, column, sql) in [
        (&new_nodes, "research_batch_nodes", "node_id", NODE_SNAPSHOT),
        (&new_edges, "research_batch_edges", "edge_id", EDGE_SNAPSHOT),
    ] {
        for id in ids {
            let snapshot: String = db.query_row(sql, [id], |row| row.get(0)).map_err(err)?;
            db.execute(
                &format!("INSERT INTO {table} (batch_id,{column},snapshot) VALUES (?1,?2,?3)"),
                params![batch_id, id, snapshot],
            )
            .map_err(err)?;
        }
    }
    let response = json!({"batchId":batch_id,"createdPapers":created_papers,
        "createdNodes":new_nodes.len(),"createdEdges":new_edges.len(),
        "reusedPapers":batch.papers.len()-created_papers,"reusedNodes":batch.papers.len()-new_nodes.len(),
        "reusedEdges":batch.edges.len()-new_edges.len(),"placements":placements,"replayed":false});
    db.execute(
        "UPDATE research_batches SET response_json=?1 WHERE id=?2",
        params![response.to_string(), batch_id],
    )
    .map_err(err)?;
    Ok(response)
}

pub(crate) fn context(
    db: &Connection,
    intent: ContextIntent,
    ids: Option<Vec<String>>,
) -> Result<Value, String> {
    if matches!(intent, ContextIntent::SelectedPapers) && ids.as_ref().is_none_or(Vec::is_empty) {
        return Err("selected_papers requires nonempty paperIds.".into());
    }
    if let Some(ids) = &ids {
        if ids.is_empty() {
            return Err("paperIds must not be empty.".into());
        }
        if ids.len() > 100 {
            return Err("Too many paperIds.".into());
        }
        for id in ids {
            text_limit(id, "paperId", 200, true)?;
        }
    }
    let scope = ids.as_ref().map(|ids| json!(ids).to_string());
    let mut stmt = db.prepare("SELECT p.id,p.title,p.authors,p.year,p.github_url,p.github_stars,p.code_review,
        (SELECT identity FROM research_identities WHERE paper_id=p.id AND kind='doi') AS doi,
        (SELECT identity FROM research_identities WHERE paper_id=p.id AND kind='arxiv') AS arxiv_id,
        COALESCE(json_extract(r.metadata,'$.url'),'') AS url,
        CASE WHEN ?3 THEN substr(COALESCE(json_extract(r.metadata,'$.abstract'),''),1,4000) ELSE '' END AS abstract,
        CASE WHEN ?3 THEN length(COALESCE(json_extract(r.metadata,'$.abstract'),''))>4000 ELSE 0 END AS abstract_truncated
        FROM papers p LEFT JOIN research_papers r ON r.paper_id=p.id
        WHERE (?1 IS NOT NULL AND p.id IN (SELECT value FROM json_each(?1)))
           OR (?1 IS NULL AND EXISTS (SELECT 1 FROM board_nodes WHERE board_id=?2 AND paper_id=p.id))
        ORDER BY p.id LIMIT 101").map_err(err)?;
    let mut papers = stmt.query_map(params![scope,DEFAULT_BOARD_ID,!matches!(intent, ContextIntent::GapAnalysis)], |row| Ok(json!({
        "id":row.get::<_,String>("id")?,"title":row.get::<_,String>("title")?,
        "authors":row.get::<_,Option<String>>("authors")?,"year":row.get::<_,Option<i64>>("year")?,
        "doi":row.get::<_,Option<String>>("doi")?,"arxivId":row.get::<_,Option<String>>("arxiv_id")?,
        "url":row.get::<_,String>("url")?,"abstract":row.get::<_,String>("abstract")?,
        "abstractTruncated":row.get::<_,bool>("abstract_truncated")?,
        "githubUrl":row.get::<_,Option<String>>("github_url")?,
        "githubStars":row.get::<_,Option<i64>>("github_stars")?,
        "codeReview":metadata::<PaperCodeReview>(row,"code_review")?
    }))).map_err(err)?.collect::<rusqlite::Result<Vec<_>>>().map_err(err)?;
    let truncated = papers.len() > 100;
    papers.truncate(100);
    let included = json!(papers
        .iter()
        .map(|p| p["id"].as_str().unwrap())
        .collect::<Vec<_>>())
    .to_string();
    let mut stmt = db
        .prepare(
            "SELECT e.id,s.paper_id AS source_paper_id,t.paper_id AS target_paper_id,
        CASE e.relation_type WHEN 'support' THEN 'supports' WHEN 'challenge' THEN 'challenges'
            ELSE COALESCE(json_extract(r.metadata,'$.kind'),'related') END AS kind,
        r.edge_id IS NOT NULL AS ai_suggested,json_extract(r.metadata,'$.basis') AS basis
        FROM board_edges e JOIN board_nodes s ON s.id=e.source_node_id
        JOIN board_nodes t ON t.id=e.target_node_id LEFT JOIN research_edges r ON r.edge_id=e.id
        WHERE e.board_id=?1 AND s.paper_id IN (SELECT value FROM json_each(?2))
        AND t.paper_id IN (SELECT value FROM json_each(?2)) ORDER BY e.id",
        )
        .map_err(err)?;
    let edges = stmt.query_map(params![DEFAULT_BOARD_ID,included], |row| Ok(json!({
        "id":row.get::<_,String>("id")?,"sourcePaperId":row.get::<_,String>("source_paper_id")?,
        "targetPaperId":row.get::<_,String>("target_paper_id")?,"kind":row.get::<_,String>("kind")?,
        "aiSuggested":row.get::<_,bool>("ai_suggested")?,"basis":row.get::<_,Option<String>>("basis")?
    }))).map_err(err)?.collect::<rusqlite::Result<Vec<_>>>().map_err(err)?;
    let response = json!({"intent":intent,"papers":papers,"edges":edges,"truncated":truncated});
    if serde_json::to_vec(&response).map_err(err)?.len() > MAX_PAYLOAD_BYTES {
        return Err("Research context exceeds the 4 MiB bridge limit; select fewer papers.".into());
    }
    Ok(response)
}

pub(crate) fn batches(db: &Connection) -> Result<Value, String> {
    let mut stmt = db
        .prepare(
            "SELECT id,title,intent,created_at,response_json,undone FROM research_batches
        ORDER BY created_at DESC,rowid DESC LIMIT 20",
        )
        .map_err(err)?;
    let values = stmt
        .query_map([], |row| {
            let response: String = row.get("response_json")?;
            // Responses are written by import inside the same transaction.
            let response: Value =
                serde_json::from_str(&response).map_err(|_| rusqlite::Error::InvalidQuery)?;
            Ok(
                json!({"id":row.get::<_,String>("id")?,"title":row.get::<_,String>("title")?,
            "intent":row.get::<_,String>("intent")?,"createdAt":row.get::<_,i64>("created_at")?,
            "createdNodes":response["createdNodes"],"createdEdges":response["createdEdges"],
            "undone":row.get::<_,bool>("undone")?}),
            )
        })
        .map_err(err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(err)?;
    Ok(json!(values))
}

pub(crate) fn undo(db: &Connection, batch_id: &str) -> Result<Value, String> {
    text_limit(batch_id, "batchId", 200, true)?;
    let undone: bool = db
        .query_row(
            "SELECT undone FROM research_batches WHERE id=?1",
            [batch_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(err)?
        .ok_or("Research batch not found.")?;
    if undone {
        return Ok(Value::Null);
    }
    for (table, column, sql) in [
        ("research_batch_nodes", "node_id", NODE_SNAPSHOT),
        ("research_batch_edges", "edge_id", EDGE_SNAPSHOT),
    ] {
        let mut stmt = db
            .prepare(&format!(
                "SELECT {column},snapshot FROM {table} WHERE batch_id=?1"
            ))
            .map_err(err)?;
        let snapshots = stmt
            .query_map([batch_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err)?;
        for (id, original) in snapshots {
            let current: Option<String> = db
                .query_row(sql, [&id], |row| row.get(0))
                .optional()
                .map_err(err)?;
            if current.as_ref() != Some(&original) {
                return Err(RESEARCH_UNDO_CONFLICT.into());
            }
        }
    }
    let outside_edge: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM board_edges e
        WHERE (e.source_node_id IN (SELECT node_id FROM research_batch_nodes WHERE batch_id=?1)
            OR e.target_node_id IN (SELECT node_id FROM research_batch_nodes WHERE batch_id=?1))
        AND e.id NOT IN (SELECT edge_id FROM research_batch_edges WHERE batch_id=?1))",
            [batch_id],
            |row| row.get(0),
        )
        .map_err(err)?;
    if outside_edge {
        return Err(RESEARCH_UNDO_CONFLICT.into());
    }
    db.execute("DELETE FROM board_edges WHERE id IN (SELECT edge_id FROM research_batch_edges WHERE batch_id=?1)", [batch_id]).map_err(err)?;
    db.execute("DELETE FROM board_nodes WHERE id IN (SELECT node_id FROM research_batch_nodes WHERE batch_id=?1)", [batch_id]).map_err(err)?;
    db.execute(
        "UPDATE research_batches SET undone=1 WHERE id=?1",
        [batch_id],
    )
    .map_err(err)?;
    Ok(Value::Null)
}
