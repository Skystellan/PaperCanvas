//! Trusted desktop commands only; no network, and no workspace/MCP operations.
use crate::{
    paper_import, research,
    workspace::{self, Paper},
};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;
use std::path::Path;

const CHANGED: &str = "ONLINE_PDF_CHANGED";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OnlinePdfInfo {
    paper_id: String,
    url: String,
    sha256: Option<String>,
    file_path: Option<String>,
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn paper(db: &Connection, id: &str) -> Result<Paper, String> {
    workspace::get_paper(db, id)?.ok_or_else(|| "Paper not found.".into())
}

fn pdf_url(base: &str, version: Option<&str>) -> String {
    match version {
        Some(version) => format!("https://arxiv.org/pdf/{base}v{version}"),
        None => format!("https://arxiv.org/pdf/{base}"),
    }
}

fn document_info(db: &Connection, paper: &Paper) -> Result<OnlinePdfInfo, String> {
    let metadata = paper
        .research
        .as_ref()
        .ok_or("No arXiv source for this paper.")?;
    let explicit = metadata
        .arxiv_id
        .as_deref()
        .map(research::arxiv_document)
        .transpose()?;
    let from_url = research::arxiv_document(&metadata.url).ok();
    let (base, mut version) = explicit
        .or_else(|| from_url.clone())
        .ok_or("No arXiv source for this paper.")?;
    version = metadata.arxiv_version.clone().or(version);
    if let Some((url_base, Some(url_version))) = from_url {
        if url_base == base {
            version = Some(url_version);
        }
    }
    let pinned: Option<(String, String)> = db
        .query_row(
            "SELECT source_url,sha256 FROM paper_pdf_documents WHERE paper_id=?1",
            [&paper.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(err)?;
    let (url, sha256) = match pinned {
        Some((url, sha)) => (url, Some(sha)),
        None => (pdf_url(&base, version.as_deref()), None),
    };
    Ok(OnlinePdfInfo {
        paper_id: paper.id.clone(),
        url,
        sha256,
        file_path: paper.file_path.clone(),
    })
}

fn check_document(info: &OnlinePdfInfo, url: &str, sha256: &str) -> Result<(), String> {
    if sha256.len() != 64
        || !sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid PDF SHA256: expected 64 lowercase hex characters.".into());
    }
    let (base, version) = research::arxiv_document(url).map_err(|_| CHANGED.to_string())?;
    // Only the canonical HTTPS PDF endpoint can be pinned, never arbitrary URLs.
    if url != pdf_url(&base, version.as_deref()) {
        return Err(CHANGED.into());
    }
    if let Some(pinned_sha) = &info.sha256 {
        if info.url != url || pinned_sha != sha256 {
            return Err(CHANGED.into());
        }
    } else {
        let (expected_base, expected_version) = research::arxiv_document(&info.url)?;
        if base != expected_base || expected_version.is_some() && version != expected_version {
            return Err(CHANGED.into());
        }
    }
    Ok(())
}

pub(crate) fn info(db: &Connection, id: &str) -> Result<OnlinePdfInfo, String> {
    let tx = Transaction::new_unchecked(db, TransactionBehavior::Deferred).map_err(err)?;
    let result = document_info(&tx, &paper(&tx, id)?)?;
    tx.commit().map_err(err)?;
    Ok(result)
}

pub(crate) fn pin(
    db: &Connection,
    id: &str,
    url: &str,
    sha256: &str,
) -> Result<OnlinePdfInfo, String> {
    let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate).map_err(err)?;
    let mut info = document_info(&tx, &paper(&tx, id)?)?;
    check_document(&info, url, sha256)?;
    if info.sha256.is_none() {
        if info.file_path.is_some() {
            return Err("The paper already has a local PDF.".into());
        }
        tx.execute(
            "INSERT INTO paper_pdf_documents(paper_id,source_url,sha256) VALUES (?1,?2,?3)",
            params![id, url, sha256],
        )
        .map_err(err)?;
        info.url = url.into();
        info.sha256 = Some(sha256.into());
    }
    tx.commit().map_err(err)?;
    Ok(info)
}

pub(crate) fn save(
    db: &Connection,
    papers: &Path,
    id: &str,
    source: &Path,
    url: &str,
    sha256: &str,
) -> Result<Paper, String> {
    let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate).map_err(err)?;
    let paper = paper(&tx, id)?;
    let info = document_info(&tx, &paper)?;
    check_document(&info, url, sha256)?;
    if info.sha256.is_none() {
        return Err("Load and pin the online PDF before saving it offline.".into());
    }
    paper_import::attach_pdf_to_paper(tx, source, papers, paper, sha256)
}
