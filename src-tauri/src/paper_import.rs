use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use std::{
    fmt,
    fs::{self, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

const PDF_SIGNATURE: &[u8; 5] = b"%PDF-";
const MAX_PDF_BYTES: u64 = 250 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPaper {
    pub id: String,
    pub title: String,
    pub authors: Option<String>,
    pub year: Option<i64>,
    pub file_path: String,
    pub domain_id: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImportPdfError {
    InvalidSource,
    InvalidPdf,
    TooLarge,
    InvalidPaperId,
    StorageUnavailable,
    DatabaseUnavailable,
}

impl fmt::Display for ImportPdfError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidSource => "Choose a readable PDF file.",
            Self::InvalidPdf => "The selected file is not a valid PDF.",
            Self::TooLarge => "The selected PDF is larger than 250 MB.",
            Self::InvalidPaperId => "Could not create a safe paper identifier.",
            Self::StorageUnavailable => "The local papers folder is unavailable.",
            Self::DatabaseUnavailable => "The paper could not be added to the local library.",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for ImportPdfError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeletePaperError {
    InvalidPaperId,
    InvalidManagedPath,
    StorageUnavailable,
    DatabaseUnavailable,
}

impl fmt::Display for DeletePaperError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidPaperId => "The paper identifier is invalid.",
            Self::InvalidManagedPath => "The paper does not reference a managed PDF.",
            Self::StorageUnavailable => "The managed PDF could not be removed.",
            Self::DatabaseUnavailable => "The paper could not be removed from the library.",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for DeletePaperError {}

fn is_safe_library_paper_id(paper_id: &str) -> bool {
    !paper_id.is_empty()
        && paper_id.len() <= 128
        && paper_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn managed_directory_exists(papers_directory: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(papers_directory) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "managed papers path must be a real directory",
                ));
            }
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn path_entry_exists(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn sync_directory(directory: &Path) -> io::Result<()> {
    match fs::File::open(directory)?.sync_all() {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::InvalidInput | io::ErrorKind::Unsupported
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

#[cfg(not(unix))]
fn sync_directory(_directory: &Path) -> io::Result<()> {
    Ok(())
}

fn managed_pdf_path(papers_directory: &Path, paper_id: &str) -> PathBuf {
    papers_directory.join(format!("{paper_id}.pdf"))
}

fn tombstone_path(papers_directory: &Path, paper_id: &str) -> PathBuf {
    papers_directory.join(format!(".{paper_id}.pdf.delete"))
}

fn parse_tombstone_id(file_name: &str) -> Option<&str> {
    let paper_id = file_name.strip_prefix('.')?.strip_suffix(".pdf.delete")?;
    is_safe_library_paper_id(paper_id).then_some(paper_id)
}

fn parse_generated_managed_pdf_id(file_name: &str) -> Option<&str> {
    let paper_id = file_name.strip_suffix(".pdf")?;
    let parsed_id = Uuid::parse_str(paper_id).ok()?;
    (parsed_id.to_string() == paper_id).then_some(paper_id)
}

fn parse_generated_partial_pdf_id(file_name: &str) -> Option<&str> {
    let paper_id = file_name.strip_prefix('.')?.strip_suffix(".pdf.part")?;
    let parsed_id = Uuid::parse_str(paper_id).ok()?;
    (parsed_id.to_string() == paper_id).then_some(paper_id)
}

fn remove_if_present(path: &Path) {
    if fs::remove_file(path).is_ok() {
        if let Some(directory) = path.parent() {
            let _ = sync_directory(directory);
        }
    }
}

fn compensate_failed_import(papers_directory: &Path, paper_id: &str) {
    let managed = managed_pdf_path(papers_directory, paper_id);
    let tombstone = tombstone_path(papers_directory, paper_id);
    let tombstone_is_available = matches!(
        fs::symlink_metadata(&tombstone),
        Err(error) if error.kind() == io::ErrorKind::NotFound
    );

    if tombstone_is_available && fs::rename(&managed, &tombstone).is_ok() {
        let _ = sync_directory(papers_directory);
        remove_if_present(&tombstone);
        return;
    }

    // A locked file may reject both rename and removal. Reconciliation also
    // recognizes generated UUID.pdf files, so a later startup can retry safely.
    remove_if_present(&managed);
}

fn copy_pdf_atomically(
    source_file: &mut fs::File,
    expected_bytes: u64,
    temporary_path: &Path,
    destination_path: &Path,
) -> Result<(), ImportPdfError> {
    let copy_result = (|| -> io::Result<u64> {
        source_file.seek(SeekFrom::Start(0))?;
        let mut destination_file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(temporary_path)?;
        let copied_bytes = io::copy(
            &mut source_file.take(MAX_PDF_BYTES + 1),
            &mut destination_file,
        )?;
        destination_file.flush()?;
        destination_file.sync_all()?;
        Ok(copied_bytes)
    })();

    let copied_bytes = match copy_result {
        Ok(copied_bytes) => copied_bytes,
        Err(_) => {
            remove_if_present(temporary_path);
            remove_if_present(destination_path);
            return Err(ImportPdfError::StorageUnavailable);
        }
    };

    if copied_bytes > MAX_PDF_BYTES {
        remove_if_present(temporary_path);
        remove_if_present(destination_path);
        return Err(ImportPdfError::TooLarge);
    }
    if copied_bytes != expected_bytes {
        remove_if_present(temporary_path);
        remove_if_present(destination_path);
        return Err(ImportPdfError::InvalidSource);
    }
    if fs::rename(temporary_path, destination_path).is_err() {
        remove_if_present(temporary_path);
        remove_if_present(destination_path);
        return Err(ImportPdfError::StorageUnavailable);
    }
    if destination_path
        .parent()
        .is_none_or(|directory| sync_directory(directory).is_err())
    {
        remove_if_present(destination_path);
        return Err(ImportPdfError::StorageUnavailable);
    }

    Ok(())
}

pub fn import_pdf_into_library(
    source_path: &Path,
    papers_directory: &Path,
    database_path: &Path,
    paper_id: &str,
    created_at: i64,
) -> Result<ImportedPaper, ImportPdfError> {
    import_pdf_into_library_with_domain(
        source_path,
        papers_directory,
        database_path,
        paper_id,
        created_at,
        None,
    )
}

pub fn import_pdf_into_library_with_domain(
    source_path: &Path,
    papers_directory: &Path,
    database_path: &Path,
    paper_id: &str,
    created_at: i64,
    domain_id: Option<&str>,
) -> Result<ImportedPaper, ImportPdfError> {
    if Uuid::parse_str(paper_id).is_err() {
        return Err(ImportPdfError::InvalidPaperId);
    }

    let extension_is_pdf = source_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"));
    let mut source_file = fs::File::open(source_path).map_err(|_| ImportPdfError::InvalidSource)?;
    let metadata = source_file
        .metadata()
        .map_err(|_| ImportPdfError::InvalidSource)?;
    if !extension_is_pdf || !metadata.is_file() || metadata.len() < PDF_SIGNATURE.len() as u64 {
        return Err(ImportPdfError::InvalidPdf);
    }
    if metadata.len() > MAX_PDF_BYTES {
        return Err(ImportPdfError::TooLarge);
    }

    let mut signature = [0_u8; PDF_SIGNATURE.len()];
    source_file
        .read_exact(&mut signature)
        .map_err(|_| ImportPdfError::InvalidPdf)?;
    if &signature != PDF_SIGNATURE {
        return Err(ImportPdfError::InvalidPdf);
    }

    let title = source_path
        .file_stem()
        .map(|stem| stem.to_string_lossy().trim().to_string())
        .filter(|title| !title.is_empty())
        .ok_or(ImportPdfError::InvalidSource)?;
    let file_path = format!("papers/{paper_id}.pdf");
    let destination_path = papers_directory.join(format!("{paper_id}.pdf"));
    let temporary_path = papers_directory.join(format!(".{paper_id}.pdf.part"));

    managed_directory_exists(papers_directory).map_err(|_| ImportPdfError::StorageUnavailable)?;
    fs::create_dir_all(papers_directory).map_err(|_| ImportPdfError::StorageUnavailable)?;
    if !managed_directory_exists(papers_directory)
        .map_err(|_| ImportPdfError::StorageUnavailable)?
    {
        return Err(ImportPdfError::StorageUnavailable);
    }
    let mut connection =
        Connection::open(database_path).map_err(|_| ImportPdfError::DatabaseUnavailable)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|_| ImportPdfError::DatabaseUnavailable)?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON")
        .map_err(|_| ImportPdfError::DatabaseUnavailable)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| ImportPdfError::DatabaseUnavailable)?;

    if !managed_directory_exists(papers_directory)
        .map_err(|_| ImportPdfError::StorageUnavailable)?
        || path_entry_exists(&destination_path).map_err(|_| ImportPdfError::StorageUnavailable)?
        || path_entry_exists(&temporary_path).map_err(|_| ImportPdfError::StorageUnavailable)?
        || path_entry_exists(&tombstone_path(papers_directory, paper_id))
            .map_err(|_| ImportPdfError::StorageUnavailable)?
    {
        return Err(ImportPdfError::StorageUnavailable);
    }
    copy_pdf_atomically(
        &mut source_file,
        metadata.len(),
        &temporary_path,
        &destination_path,
    )?;

    if transaction
        .execute(
            "INSERT INTO papers
             (id, title, authors, year, file_path, domain_id, created_at)
             VALUES (?1, ?2, NULL, NULL, ?3, ?4, ?5)",
            params![paper_id, title, file_path, domain_id, created_at],
        )
        .is_err()
    {
        compensate_failed_import(papers_directory, paper_id);
        return Err(ImportPdfError::DatabaseUnavailable);
    }
    if transaction.commit().is_err() {
        compensate_failed_import(papers_directory, paper_id);
        return Err(ImportPdfError::DatabaseUnavailable);
    }

    Ok(ImportedPaper {
        id: paper_id.to_string(),
        title,
        authors: None,
        year: None,
        file_path,
        domain_id: domain_id.map(str::to_owned),
        created_at,
    })
}

fn open_library_database(database_path: &Path) -> Result<Connection, DeletePaperError> {
    let connection = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
    )
    .map_err(|_| DeletePaperError::DatabaseUnavailable)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|_| DeletePaperError::DatabaseUnavailable)?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON")
        .map_err(|_| DeletePaperError::DatabaseUnavailable)?;
    Ok(connection)
}

fn restore_live_tombstone(papers_directory: &Path, paper_id: &str) -> Result<(), DeletePaperError> {
    let tombstone = tombstone_path(papers_directory, paper_id);
    let tombstone_metadata = match fs::symlink_metadata(&tombstone) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(DeletePaperError::StorageUnavailable),
    };
    if !tombstone_metadata.file_type().is_file() {
        return Err(DeletePaperError::StorageUnavailable);
    }

    let managed = managed_pdf_path(papers_directory, paper_id);
    match fs::symlink_metadata(&managed) {
        Ok(_) => return Err(DeletePaperError::StorageUnavailable),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err(DeletePaperError::StorageUnavailable),
    }
    fs::rename(&tombstone, &managed).map_err(|_| DeletePaperError::StorageUnavailable)?;
    sync_directory(papers_directory).map_err(|_| DeletePaperError::StorageUnavailable)
}

fn stage_managed_pdf(
    papers_directory: &Path,
    paper_id: &str,
) -> Result<Option<(PathBuf, PathBuf)>, DeletePaperError> {
    let managed = managed_pdf_path(papers_directory, paper_id);
    let metadata = match fs::symlink_metadata(&managed) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(DeletePaperError::StorageUnavailable),
    };
    if !metadata.file_type().is_file() {
        return Err(DeletePaperError::StorageUnavailable);
    }

    let tombstone = tombstone_path(papers_directory, paper_id);
    match fs::symlink_metadata(&tombstone) {
        Ok(_) => return Err(DeletePaperError::StorageUnavailable),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err(DeletePaperError::StorageUnavailable),
    }
    fs::rename(&managed, &tombstone).map_err(|_| DeletePaperError::StorageUnavailable)?;
    if sync_directory(papers_directory).is_err() {
        let _ = fs::rename(&tombstone, &managed);
        let _ = sync_directory(papers_directory);
        return Err(DeletePaperError::StorageUnavailable);
    }
    Ok(Some((managed, tombstone)))
}

fn restore_staged_pdf(
    papers_directory: &Path,
    staged_file: &Option<(PathBuf, PathBuf)>,
) -> Result<(), DeletePaperError> {
    if let Some((managed, tombstone)) = staged_file {
        fs::rename(tombstone, managed).map_err(|_| DeletePaperError::StorageUnavailable)?;
        sync_directory(papers_directory).map_err(|_| DeletePaperError::StorageUnavailable)?;
    }
    Ok(())
}

pub fn delete_paper_from_library(
    papers_directory: &Path,
    database_path: &Path,
    paper_id: &str,
) -> Result<(), DeletePaperError> {
    if !is_safe_library_paper_id(paper_id) {
        return Err(DeletePaperError::InvalidPaperId);
    }
    let papers_directory_exists = managed_directory_exists(papers_directory)
        .map_err(|_| DeletePaperError::StorageUnavailable)?;

    let mut connection = open_library_database(database_path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| DeletePaperError::DatabaseUnavailable)?;
    let file_path = transaction
        .query_row(
            "SELECT file_path FROM papers WHERE id = ?1",
            [paper_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|_| DeletePaperError::DatabaseUnavailable)?;

    let Some(file_path) = file_path else {
        transaction
            .commit()
            .map_err(|_| DeletePaperError::DatabaseUnavailable)?;
        return Ok(());
    };

    let has_managed_pdf = match file_path {
        None => false,
        Some(stored_path) => {
            if stored_path != format!("papers/{paper_id}.pdf") {
                return Err(DeletePaperError::InvalidManagedPath);
            }
            true
        }
    };

    let staged_file = if has_managed_pdf && papers_directory_exists {
        restore_live_tombstone(papers_directory, paper_id)?;
        stage_managed_pdf(papers_directory, paper_id)?
    } else {
        None
    };

    if transaction
        .execute("DELETE FROM papers WHERE id = ?1", [paper_id])
        .is_err()
    {
        restore_staged_pdf(papers_directory, &staged_file)?;
        return Err(DeletePaperError::DatabaseUnavailable);
    }

    if transaction.commit().is_err() {
        restore_staged_pdf(papers_directory, &staged_file)?;
        return Err(DeletePaperError::DatabaseUnavailable);
    }

    if let Some((_, tombstone)) = staged_file {
        if fs::remove_file(&tombstone).is_ok() {
            let _ = sync_directory(papers_directory);
        }
    }
    Ok(())
}

pub fn reconcile_paper_storage(
    papers_directory: &Path,
    database_path: &Path,
) -> Result<(), DeletePaperError> {
    if !managed_directory_exists(papers_directory)
        .map_err(|_| DeletePaperError::StorageUnavailable)?
    {
        return Ok(());
    }
    let mut connection = open_library_database(database_path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| DeletePaperError::DatabaseUnavailable)?;

    for entry in fs::read_dir(papers_directory).map_err(|_| DeletePaperError::StorageUnavailable)? {
        let entry = entry.map_err(|_| DeletePaperError::StorageUnavailable)?;
        let file_name = match entry.file_name().into_string() {
            Ok(file_name) => file_name,
            Err(_) => continue,
        };
        if parse_generated_partial_pdf_id(&file_name).is_some() {
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|_| DeletePaperError::StorageUnavailable)?;
            // Only the exact, canonical UUID name produced by our importer is
            // eligible, and links/directories are deliberately left alone.
            if !metadata.file_type().is_file() {
                continue;
            }
            fs::remove_file(entry.path()).map_err(|_| DeletePaperError::StorageUnavailable)?;
            sync_directory(papers_directory).map_err(|_| DeletePaperError::StorageUnavailable)?;
            continue;
        }
        let tombstone_id = parse_tombstone_id(&file_name);
        let managed_pdf_id = parse_generated_managed_pdf_id(&file_name);
        let Some(paper_id) = tombstone_id.or(managed_pdf_id) else {
            continue;
        };
        let file_path = transaction
            .query_row(
                "SELECT file_path FROM papers WHERE id = ?1",
                [paper_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|_| DeletePaperError::DatabaseUnavailable)?;

        if managed_pdf_id.is_some() {
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|_| DeletePaperError::StorageUnavailable)?;
            if !metadata.file_type().is_file() {
                return Err(DeletePaperError::StorageUnavailable);
            }

            match file_path {
                None => {
                    fs::remove_file(entry.path())
                        .map_err(|_| DeletePaperError::StorageUnavailable)?;
                    sync_directory(papers_directory)
                        .map_err(|_| DeletePaperError::StorageUnavailable)?;
                }
                Some(Some(stored_path)) if stored_path == format!("papers/{paper_id}.pdf") => {}
                Some(_) => return Err(DeletePaperError::InvalidManagedPath),
            }
            continue;
        }

        match file_path {
            None => {
                fs::remove_file(entry.path()).map_err(|_| DeletePaperError::StorageUnavailable)?;
                sync_directory(papers_directory)
                    .map_err(|_| DeletePaperError::StorageUnavailable)?;
            }
            Some(Some(stored_path)) if stored_path == format!("papers/{paper_id}.pdf") => {
                let metadata = fs::symlink_metadata(entry.path())
                    .map_err(|_| DeletePaperError::StorageUnavailable)?;
                if !metadata.file_type().is_file() {
                    return Err(DeletePaperError::StorageUnavailable);
                }
                let managed = managed_pdf_path(papers_directory, paper_id);
                match fs::symlink_metadata(&managed) {
                    Ok(_) => return Err(DeletePaperError::StorageUnavailable),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(_) => return Err(DeletePaperError::StorageUnavailable),
                }
                fs::rename(entry.path(), managed)
                    .map_err(|_| DeletePaperError::StorageUnavailable)?;
                sync_directory(papers_directory)
                    .map_err(|_| DeletePaperError::StorageUnavailable)?;
            }
            Some(_) => return Err(DeletePaperError::InvalidManagedPath),
        }
    }
    transaction
        .commit()
        .map_err(|_| DeletePaperError::DatabaseUnavailable)
}
