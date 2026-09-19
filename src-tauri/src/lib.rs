use tauri_plugin_sql::{Migration, MigrationKind};

pub mod backend;
pub mod codex_runtime;
mod markdown_notes;
mod paper_import;
mod web_chat;

use codex_runtime::{
    cancel_codex_turn, codex_runtime_status, start_codex_turn, CancellationRegistry,
};
pub use paper_import::{
    delete_paper_from_library, import_pdf_into_library, import_pdf_into_library_with_domain,
    reconcile_paper_storage, DeletePaperError, ImportPdfError, ImportedPaper,
};

const DATABASE_URL: &str = "sqlite:papercanvas.db";

pub fn initial_migration_sql() -> &'static str {
    include_str!("../migrations/0001_initial.sql")
}

pub fn library_migration_sql() -> &'static str {
    include_str!("../migrations/0002_paper_library.sql")
}

pub fn note_migration_sql() -> &'static str {
    include_str!("../migrations/0003_notes.sql")
}

pub fn edge_migration_sql() -> &'static str {
    include_str!("../migrations/0004_edges.sql")
}

pub fn highlight_migration_sql() -> &'static str {
    include_str!("../migrations/0005_pdf_highlights.sql")
}

pub fn mind_map_migration_sql() -> &'static str {
    include_str!("../migrations/0006_paper_mind_maps.sql")
}

pub fn runtime_settings_migration_sql() -> &'static str {
    include_str!("../migrations/0007_ai_runtime_settings.sql")
}

pub fn paper_text_migration_sql() -> &'static str {
    include_str!("../migrations/0008_paper_texts.sql")
}

pub fn chat_migration_sql() -> &'static str {
    include_str!("../migrations/0009_chat.sql")
}

pub fn model_settings_migration_sql() -> &'static str {
    include_str!("../migrations/0010_model_settings.sql")
}

pub fn atomic_model_settings_migration_sql() -> &'static str {
    include_str!("../migrations/0011_atomic_model_settings.sql")
}

pub fn paper_domains_migration_sql() -> &'static str {
    include_str!("../migrations/0012_paper_domains.sql")
}

pub fn atomic_chat_turns_migration_sql() -> &'static str {
    include_str!("../migrations/0013_atomic_chat_turns.sql")
}

pub fn edge_relations_migration_sql() -> &'static str {
    include_str!("../migrations/0014_edge_relations.sql")
}

pub fn paper_web_chats_migration_sql() -> &'static str {
    include_str!("../migrations/0015_paper_web_chats.sql")
}

#[tauri::command(async)]
fn import_pdf(
    app: tauri::AppHandle,
    source_path: String,
    domain_id: Option<String>,
) -> Result<ImportedPaper, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    use tauri::Manager;
    use tauri_plugin_fs::FsExt;

    if !app.fs_scope().is_allowed(&source_path) {
        return Err(ImportPdfError::InvalidSource.to_string());
    }

    let app_data_directory = app
        .path()
        .app_data_dir()
        .map_err(|_| ImportPdfError::StorageUnavailable.to_string())?;
    let database_directory = app
        .path()
        .app_config_dir()
        .map_err(|_| ImportPdfError::DatabaseUnavailable.to_string())?;
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ImportPdfError::DatabaseUnavailable.to_string())?
        .as_millis() as i64;
    let paper_id = uuid::Uuid::new_v4().to_string();

    import_pdf_into_library_with_domain(
        std::path::Path::new(&source_path),
        &app_data_directory.join("papers"),
        &database_directory.join("papercanvas.db"),
        &paper_id,
        created_at,
        domain_id.as_deref(),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command(async)]
fn delete_paper(app: tauri::AppHandle, paper_id: String) -> Result<(), String> {
    use tauri::Manager;

    let app_data_directory = app
        .path()
        .app_data_dir()
        .map_err(|_| DeletePaperError::StorageUnavailable.to_string())?;
    let database_directory = app
        .path()
        .app_config_dir()
        .map_err(|_| DeletePaperError::DatabaseUnavailable.to_string())?;

    delete_paper_from_library(
        &app_data_directory.join("papers"),
        &database_directory.join("papercanvas.db"),
        &paper_id,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command(async)]
fn reconcile_pdf_storage(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    let app_data_directory = app
        .path()
        .app_data_dir()
        .map_err(|_| DeletePaperError::StorageUnavailable.to_string())?;
    let database_directory = app
        .path()
        .app_config_dir()
        .map_err(|_| DeletePaperError::DatabaseUnavailable.to_string())?;

    reconcile_paper_storage(
        &app_data_directory.join("papers"),
        &database_directory.join("papercanvas.db"),
    )
    .map_err(|error| error.to_string())
}

pub fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create the V0 paper canvas",
            sql: initial_migration_sql(),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add the local paper library",
            sql: library_migration_sql(),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "add one primary note per paper",
            sql: note_migration_sql(),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "add ordinary board edges",
            sql: edge_migration_sql(),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "add persistent PDF highlights",
            sql: highlight_migration_sql(),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "add one paper mind map per paper",
            sql: mind_map_migration_sql(),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "add local Codex runtime settings",
            sql: runtime_settings_migration_sql(),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "cache complete extracted paper text",
            sql: paper_text_migration_sql(),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "persist AI discussions and explicit paper context",
            sql: chat_migration_sql(),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "allow selectable Codex models",
            sql: model_settings_migration_sql(),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "apply model settings to a chat atomically",
            sql: atomic_model_settings_migration_sql(),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "organize papers into domains",
            sql: paper_domains_migration_sql(),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 13,
            description: "persist both chat turn messages atomically",
            sql: atomic_chat_turns_migration_sql(),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 14,
            description: "classify board edges",
            sql: edge_relations_migration_sql(),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 15,
            description: "link multiple web conversations to each paper",
            sql: paper_web_chats_migration_sql(),
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = migrations();
    tauri::Builder::default()
        .manage(CancellationRegistry::default())
        .manage(markdown_notes::NoteFileState::default())
        .manage(web_chat::WebChatState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(DATABASE_URL, migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            markdown_notes::load_markdown_note,
            markdown_notes::save_markdown_note,
            markdown_notes::reveal_markdown_note,
            import_pdf,
            delete_paper,
            reconcile_pdf_storage,
            codex_runtime_status,
            start_codex_turn,
            cancel_codex_turn,
            web_chat::list_paper_web_chats,
            web_chat::save_paper_web_chat,
            web_chat::layout_paper_web_chat,
            web_chat::open_paper_web_chat_external,
            web_chat::restore_paper_web_chat,
            web_chat::reload_paper_web_chat
        ])
        .run(tauri::generate_context!())
        .expect("PaperCanvas failed to start");
}
