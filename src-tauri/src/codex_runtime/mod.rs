use std::{
    collections::{HashMap, HashSet, VecDeque},
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{ipc::Channel, AppHandle, Manager};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::oneshot,
    time::timeout,
};

mod privacy;

use privacy::{create_turn_privacy_home, validate_auth_source, TurnPrivacyHome};

pub const EXPECTED_CODEX_VERSION: &str = "0.149.0-alpha.4.1";
const SUPPORTED_CODEX_MODELS: [&str; 3] = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const MINIMUM_NODE_MAJOR: u32 = 18;
const MAX_PROMPT_BYTES: usize = 8 * 1024 * 1024;
const MAX_OUTPUT_SCHEMA_BYTES: usize = 256 * 1024;
const MAX_SIDECAR_REQUEST_BYTES: usize = 12 * 1024 * 1024;
const MAX_EVENT_LINE_BYTES: usize = 12 * 1024 * 1024 + 4096;
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_ACTIVE_CODEX_TURNS: usize = 2;
const MAX_PENDING_CODEX_CANCELLATIONS: usize = 16;
const PENDING_CODEX_CANCELLATION_TTL: Duration = Duration::from_secs(5);
#[cfg(not(test))]
const CANCEL_GRACE_PERIOD: Duration = Duration::from_secs(2);
#[cfg(test)]
const CANCEL_GRACE_PERIOD: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartCodexTurnRequest {
    pub request_id: String,
    pub prompt: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub output_schema: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexUsage {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_write_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum CodexRuntimeEvent {
    #[serde(rename = "thread", rename_all = "camelCase")]
    Thread { thread_id: String },
    #[serde(rename = "message", rename_all = "camelCase")]
    Message { item_id: String, text: String },
    #[serde(rename = "completed", rename_all = "camelCase")]
    Completed { usage: CodexUsage },
    #[serde(rename = "interrupted")]
    Interrupted,
    #[serde(rename = "error")]
    Error { message: String },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LoginMethod {
    Chatgpt,
    Api,
    None,
    Unknown,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexRuntimeStatus {
    pub available: bool,
    pub authenticated: bool,
    pub compatible: bool,
    pub login_method: LoginMethod,
    pub node_version: Option<String>,
    pub runtime_version: Option<String>,
    pub message: Option<String>,
}

#[derive(Default)]
pub struct CancellationRegistry {
    state: Mutex<CancellationState>,
}

#[derive(Default)]
struct CancellationState {
    pending: VecDeque<(String, Instant)>,
    senders: HashMap<String, Option<oneshot::Sender<()>>>,
}

fn prune_pending_cancellations(state: &mut CancellationState) {
    let now = Instant::now();
    while state.pending.front().is_some_and(|(_, created_at)| {
        now.duration_since(*created_at) >= PENDING_CODEX_CANCELLATION_TTL
    }) {
        state.pending.pop_front();
    }
}

impl CancellationRegistry {
    pub fn register(&self, request_id: &str) -> Result<oneshot::Receiver<()>, String> {
        let (sender, receiver) = oneshot::channel();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "The Codex cancellation state is unavailable.".to_string())?;
        if state.senders.contains_key(request_id) {
            return Err("A Codex turn with this request id is already running.".into());
        }
        if state.senders.len() >= MAX_ACTIVE_CODEX_TURNS {
            return Err("PaperCanvas already has two active Codex turns.".into());
        }
        prune_pending_cancellations(&mut state);
        let prompt_cancelled = state
            .pending
            .iter()
            .position(|(pending_id, _)| pending_id == request_id)
            .and_then(|position| state.pending.remove(position))
            .is_some();
        if prompt_cancelled {
            state.senders.insert(request_id.to_string(), None);
            drop(state);
            let _ = sender.send(());
            return Ok(receiver);
        }
        state.senders.insert(request_id.to_string(), Some(sender));
        drop(state);
        Ok(receiver)
    }

    pub fn cancel(&self, request_id: &str) -> bool {
        let sender = {
            let Ok(mut state) = self.state.lock() else {
                return false;
            };
            if state.senders.contains_key(request_id) {
                state.senders.get_mut(request_id).and_then(Option::take)
            } else {
                prune_pending_cancellations(&mut state);
                if !state
                    .pending
                    .iter()
                    .any(|(pending_id, _)| pending_id == request_id)
                {
                    if state.pending.len() >= MAX_PENDING_CODEX_CANCELLATIONS {
                        state.pending.pop_front();
                    }
                    state
                        .pending
                        .push_back((request_id.to_string(), Instant::now()));
                }
                return true;
            }
        };
        sender.is_some_and(|sender| sender.send(()).is_ok())
    }

    pub fn finish(&self, request_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.senders.remove(request_id);
        }
    }
}

#[derive(Debug, Clone)]
struct DiscoveredRuntime {
    node_path: PathBuf,
    codex_path: PathBuf,
    codex_home: PathBuf,
    login_method: LoginMethod,
}

#[derive(Debug, Clone)]
struct RuntimeAssets {
    root: PathBuf,
    runner: PathBuf,
    wrapper: PathBuf,
}

struct ProcessGroupGuard {
    #[cfg(unix)]
    process_group_id: Option<i32>,
}

impl ProcessGroupGuard {
    fn new(child: &Child) -> Self {
        Self {
            #[cfg(unix)]
            process_group_id: child.id().map(|id| id as i32),
        }
    }

    fn terminate(&mut self) {
        #[cfg(unix)]
        if let Some(process_group_id) = self.process_group_id.take() {
            // Safety: the child was spawned into a fresh process group with this id.
            unsafe {
                libc::kill(-process_group_id, libc::SIGKILL);
            }
        }
    }
}

impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[derive(Debug)]
struct SupervisionResult {
    status: std::process::ExitStatus,
    cancelled: bool,
    collected_output: Option<bool>,
}

pub fn validate_turn_request(request: &StartCodexTurnRequest) -> Result<(), String> {
    if !is_bounded_identifier(&request.request_id, false, 128) {
        return Err("The Codex request id is invalid.".into());
    }
    if request.prompt.trim().is_empty() {
        return Err("The Codex prompt must not be empty.".into());
    }
    if request.prompt.len() > MAX_PROMPT_BYTES {
        return Err("The Codex prompt is too large to transfer safely.".into());
    }
    if !SUPPORTED_CODEX_MODELS.contains(&request.model.as_str()) {
        return Err("The selected Codex model is not supported by PaperCanvas.".into());
    }
    if request
        .reasoning_effort
        .as_deref()
        .is_some_and(|effort| !matches!(effort, "low" | "medium" | "high" | "xhigh" | "max"))
    {
        return Err("The selected reasoning effort is invalid.".into());
    }
    if let Some(schema) = &request.output_schema {
        if !schema.is_object() {
            return Err("The Codex output schema must be a JSON object.".into());
        }
        let encoded = serde_json::to_vec(schema)
            .map_err(|_| "The Codex output schema is invalid.".to_string())?;
        if encoded.len() > MAX_OUTPUT_SCHEMA_BYTES {
            return Err("The Codex output schema is too large.".into());
        }
    }
    Ok(())
}

fn is_bounded_identifier(value: &str, allow_dot: bool, maximum: usize) -> bool {
    if value.is_empty() || value.len() > maximum || !value.is_ascii() {
        return false;
    }
    value.bytes().enumerate().all(|(index, byte)| {
        byte.is_ascii_alphanumeric()
            || (index > 0 && matches!(byte, b'_' | b'-'))
            || (allow_dot && index > 0 && byte == b'.')
    })
}

pub fn parse_sidecar_event(line: &str) -> Result<CodexRuntimeEvent, String> {
    if line.len() > MAX_EVENT_LINE_BYTES {
        return Err("The local Codex runtime returned an oversized event.".into());
    }
    serde_json::from_str(line)
        .map_err(|_| "The local Codex runtime returned an invalid event.".to_string())
}

pub fn candidate_executables(
    executable_name: &str,
    path_environment: Option<&str>,
    home: Option<&Path>,
    application_candidates: &[PathBuf],
    nvm_candidates: &[PathBuf],
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    candidates.extend(application_candidates.iter().cloned());
    candidates.extend(nvm_candidates.iter().cloned());
    if let Some(home) = home {
        candidates.push(home.join(".local/bin").join(executable_name));
    }
    if let Some(path_environment) = path_environment {
        candidates.extend(
            std::env::split_paths(&OsString::from(path_environment))
                .map(|directory| directory.join(executable_name)),
        );
    }

    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|candidate| seen.insert(candidate.clone()))
        .collect()
}

#[tauri::command]
pub async fn codex_runtime_status() -> CodexRuntimeStatus {
    discover_runtime().await.0
}

#[tauri::command]
pub async fn start_codex_turn(
    app: AppHandle,
    request: StartCodexTurnRequest,
    on_event: Channel<CodexRuntimeEvent>,
    cancellations: tauri::State<'_, CancellationRegistry>,
) -> Result<(), String> {
    validate_turn_request(&request)?;
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let cancellation = cancellations.register(&request.request_id)?;
    let request_id = request.request_id.clone();
    let result = run_codex_turn(&resources, &cache, request, on_event, cancellation).await;
    cancellations.finish(&request_id);
    result
}

#[tauri::command]
pub fn cancel_codex_turn(
    request_id: String,
    cancellations: tauri::State<'_, CancellationRegistry>,
) -> bool {
    if !is_bounded_identifier(&request_id, false, 128) {
        return false;
    }
    cancellations.cancel(&request_id)
}

pub async fn run_codex_turn(
    resources: &Path,
    cache: &Path,
    request: StartCodexTurnRequest,
    on_event: Channel<CodexRuntimeEvent>,
    mut cancellation: oneshot::Receiver<()>,
) -> Result<(), String> {
    if cancellation.try_recv().is_ok() {
        let _ = on_event.send(CodexRuntimeEvent::Interrupted);
        return Ok(());
    }
    let (status, runtime) = tokio::select! {
        discovered = discover_runtime() => discovered,
        _ = &mut cancellation => {
            let _ = on_event.send(CodexRuntimeEvent::Interrupted);
            return Ok(());
        }
    };
    if !status.compatible {
        return Err(status
            .message
            .unwrap_or_else(|| "The local Codex runtime is unavailable or incompatible.".into()));
    }
    let runtime = runtime.ok_or_else(|| "The local Codex runtime is unavailable.".to_string())?;
    if runtime.login_method != LoginMethod::Chatgpt {
        return Err("Sign in to the local Codex runtime with ChatGPT before using AI.".into());
    }

    let privacy_home = create_turn_privacy_home(&runtime.codex_home)?;
    let assets = prepare_runtime_assets(resources, cache)?;
    if cancellation.try_recv().is_ok() {
        let _ = on_event.send(CodexRuntimeEvent::Interrupted);
        let _ = std::fs::remove_dir_all(&assets.root);
        return Ok(());
    }
    let result = spawn_and_stream(
        &runtime,
        &assets,
        &privacy_home,
        &request,
        &on_event,
        &mut cancellation,
    )
    .await;
    let _ = std::fs::remove_dir_all(&assets.root);
    result
}

async fn spawn_and_stream(
    runtime: &DiscoveredRuntime,
    assets: &RuntimeAssets,
    privacy_home: &TurnPrivacyHome,
    request: &StartCodexTurnRequest,
    on_event: &Channel<CodexRuntimeEvent>,
    cancellation: &mut oneshot::Receiver<()>,
) -> Result<(), String> {
    let mut command = Command::new(&runtime.node_path);
    command
        .arg(&assets.runner)
        .current_dir(privacy_home.work_directory())
        .env_clear()
        .env("PATH", minimal_path(&runtime.node_path))
        .env("HOME", privacy_home.home_directory())
        .env("CODEX_HOME", privacy_home.codex_home())
        .env("TMPDIR", std::env::temp_dir())
        .env("PAPERCANVAS_CODEX_BINARY", &runtime.codex_path)
        .env("PAPERCANVAS_CODEX_WRAPPER", &assets.wrapper)
        .env("PAPERCANVAS_WORK_DIR", privacy_home.work_directory())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(unix)]
    command.process_group(0);

    let mut child = command
        .spawn()
        .map_err(|_| "The local Codex sidecar could not be started.".to_string())?;
    let mut process_group_guard = ProcessGroupGuard::new(&child);
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "The local Codex sidecar input is unavailable.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "The local Codex sidecar output is unavailable.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "The local Codex sidecar diagnostics are unavailable.".to_string())?;

    let request_line = sidecar_request_json(request)?;
    let write_result = tokio::select! {
        result = async {
            stdin
                .write_all(&request_line)
                .await
                .map_err(|_| "The local Codex sidecar could not receive the request.".to_string())?;
            stdin
                .write_all(b"\n")
                .await
                .map_err(|_| "The local Codex sidecar could not receive the request.".to_string())?;
            stdin
                .flush()
                .await
                .map_err(|_| "The local Codex sidecar could not receive the request.".to_string())
        } => Some(result),
        _ = &mut *cancellation => None,
    };
    match write_result {
        Some(result) => result?,
        None => {
            process_group_guard.terminate();
            force_kill_process_group(&mut child).await;
            let _ = child.wait().await;
            let _ = on_event.send(CodexRuntimeEvent::Interrupted);
            return Ok(());
        }
    }

    let event_channel = on_event.clone();
    let mut output_task = tokio::spawn(async move { forward_events(stdout, event_channel).await });
    let diagnostic_task = tokio::spawn(async move {
        let mut diagnostics = stderr;
        let mut buffer = [0_u8; 4096];
        while diagnostics.read(&mut buffer).await.unwrap_or(0) > 0 {}
    });

    let process_result = supervise_process(
        &mut child,
        &mut stdin,
        &request.request_id,
        cancellation,
        &mut output_task,
        &mut process_group_guard,
    )
    .await;
    drop(stdin);

    let SupervisionResult {
        status,
        cancelled,
        collected_output,
    } = match process_result {
        Ok(result) => result,
        Err(message) => {
            process_group_guard.terminate();
            force_kill_process_group(&mut child).await;
            let _ = child.wait().await;
            let _ = diagnostic_task.await;
            return Err(message);
        }
    };
    let terminal_event = match collected_output {
        Some(terminal) => terminal,
        None => flatten_output_task(output_task.await)?,
    };
    let _ = diagnostic_task.await;

    if cancelled && !terminal_event {
        let _ = on_event.send(CodexRuntimeEvent::Interrupted);
        return Ok(());
    }
    if !status.success() && !terminal_event {
        return Err("The local Codex runtime could not complete this turn.".into());
    }
    if !terminal_event {
        return Err("The local Codex runtime ended without a completion event.".into());
    }
    Ok(())
}

async fn supervise_process(
    child: &mut Child,
    stdin: &mut tokio::process::ChildStdin,
    request_id: &str,
    cancellation: &mut oneshot::Receiver<()>,
    output_task: &mut tokio::task::JoinHandle<Result<bool, String>>,
    process_group_guard: &mut ProcessGroupGuard,
) -> Result<SupervisionResult, String> {
    let mut collected_output = None;
    let outcome = tokio::select! {
        status = child.wait() => {
            status
                .map(|status| (status, false))
                .map_err(|_| "The local Codex sidecar stopped unexpectedly.".to_string())
        }
        output = &mut *output_task => {
            match flatten_output_task(output) {
                Ok(terminal) => {
                    collected_output = Some(terminal);
                    wait_or_force_kill(child).await.map(|status| (status, false))
                }
                Err(message) => {
                    force_kill_process_group(child).await;
                    let _ = child.wait().await;
                    Err(message)
                }
            }
        }
        _ = cancellation => {
            let cancel_line = serde_json::to_vec(&json!({
                "type": "cancel",
                "requestId": request_id,
            })).map_err(|_| "The Codex cancel request could not be encoded.".to_string())?;
            let _ = stdin.write_all(&cancel_line).await;
            let _ = stdin.write_all(b"\n").await;
            let _ = stdin.flush().await;
            wait_or_force_kill(child).await.map(|status| (status, true))
        }
    };
    process_group_guard.terminate();
    let (status, cancelled) = outcome?;
    Ok(SupervisionResult {
        status,
        cancelled,
        collected_output,
    })
}

fn flatten_output_task(
    result: Result<Result<bool, String>, tokio::task::JoinError>,
) -> Result<bool, String> {
    result.map_err(|_| "The local Codex event bridge stopped unexpectedly.".to_string())?
}

async fn wait_or_force_kill(child: &mut Child) -> Result<std::process::ExitStatus, String> {
    match timeout(CANCEL_GRACE_PERIOD, child.wait()).await {
        Ok(wait_result) => {
            wait_result.map_err(|_| "The local Codex sidecar stopped unexpectedly.".to_string())
        }
        Err(_) => {
            force_kill_process_group(child).await;
            child
                .wait()
                .await
                .map_err(|_| "The local Codex sidecar could not be stopped.".to_string())
        }
    }
}

async fn forward_events(
    stdout: tokio::process::ChildStdout,
    on_event: Channel<CodexRuntimeEvent>,
) -> Result<bool, String> {
    let mut reader = BufReader::new(stdout);
    let mut terminal = false;
    while let Some(line) = read_bounded_line(&mut reader, MAX_EVENT_LINE_BYTES).await? {
        let line = std::str::from_utf8(&line)
            .map_err(|_| "The local Codex runtime returned a non-UTF-8 event.".to_string())?;
        let event = parse_sidecar_event(line.trim_end_matches(['\r', '\n']))?;
        if terminal {
            return Err("The local Codex runtime returned data after a terminal event.".into());
        }
        terminal = matches!(
            event,
            CodexRuntimeEvent::Completed { .. }
                | CodexRuntimeEvent::Interrupted
                | CodexRuntimeEvent::Error { .. }
        );
        on_event
            .send(event)
            .map_err(|_| "The PaperCanvas AI event channel was closed.".to_string())?;
    }
    Ok(terminal)
}

async fn read_bounded_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    maximum: usize,
) -> Result<Option<Vec<u8>>, String> {
    let mut line = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .await
            .map_err(|_| "The local Codex event stream could not be read.".to_string())?;
        if available.is_empty() {
            return Ok((!line.is_empty()).then_some(line));
        }
        let consumed = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |position| position + 1);
        if line.len().saturating_add(consumed) > maximum {
            return Err("The local Codex runtime returned an oversized event.".into());
        }
        let finished = available.get(consumed.saturating_sub(1)) == Some(&b'\n');
        line.extend_from_slice(&available[..consumed]);
        reader.consume(consumed);
        if finished {
            return Ok(Some(line));
        }
    }
}

fn sidecar_request_json(request: &StartCodexTurnRequest) -> Result<Vec<u8>, String> {
    let mut value = json!({
        "type": "start",
        "requestId": request.request_id,
        "prompt": request.prompt,
        "model": request.model,
    });
    let object = value
        .as_object_mut()
        .expect("the fixed sidecar request is an object");
    if let Some(reasoning_effort) = &request.reasoning_effort {
        object.insert("reasoningEffort".into(), json!(reasoning_effort));
    }
    if let Some(output_schema) = &request.output_schema {
        object.insert("outputSchema".into(), output_schema.clone());
    }
    let encoded = serde_json::to_vec(&value)
        .map_err(|_| "The Codex request could not be encoded.".to_string())?;
    if encoded.len() > MAX_SIDECAR_REQUEST_BYTES {
        return Err("The encoded Codex request is too large to transfer safely.".into());
    }
    Ok(encoded)
}

async fn discover_runtime() -> (CodexRuntimeStatus, Option<DiscoveredRuntime>) {
    if std::env::consts::OS != "macos" {
        return (
            unavailable_status(
                "The local Codex SDK bridge in this PaperCanvas build currently supports macOS.",
            ),
            None,
        );
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from));
    let Some(home_directory) = home else {
        return (
            unavailable_status("The user home directory could not be located."),
            None,
        );
    };
    let path_environment = std::env::var("PATH").ok();
    let codex_candidates = candidate_executables(
        if cfg!(windows) { "codex.exe" } else { "codex" },
        path_environment.as_deref(),
        Some(&home_directory),
        &application_codex_candidates(&home_directory),
        &nvm_candidates(
            &home_directory,
            if cfg!(windows) { "codex.exe" } else { "codex" },
        ),
    );
    let node_candidates = candidate_executables(
        if cfg!(windows) { "node.exe" } else { "node" },
        path_environment.as_deref(),
        Some(&home_directory),
        &application_node_candidates(&home_directory),
        &nvm_candidates(
            &home_directory,
            if cfg!(windows) { "node.exe" } else { "node" },
        ),
    );
    let codex_available = codex_candidates.iter().any(|path| is_executable(path));
    let node_available = node_candidates.iter().any(|path| is_executable(path));
    if !codex_available || !node_available {
        return (
            unavailable_status("Install or open ChatGPT/Codex with a Node.js 18+ runtime."),
            None,
        );
    }

    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home_directory.join(".codex"));
    let (selected_node, node_version) =
        select_compatible_node(node_candidates, &home_directory, &codex_home).await;
    let (selected_codex, detected_codex) =
        select_compatible_codex(codex_candidates, &home_directory, &codex_home).await;
    let runtime_version = detected_codex.as_ref().map(|(_, version)| version.clone());
    let binaries_compatible = selected_node.is_some() && selected_codex.is_some();
    let login_method =
        if let Some((codex_path, _)) = selected_codex.as_ref().or(detected_codex.as_ref()) {
            probe(
                codex_path,
                &["login", "status"],
                &home_directory,
                &codex_home,
            )
            .await
            .as_deref()
            .map(parse_login_method)
            .unwrap_or(LoginMethod::Unknown)
        } else {
            LoginMethod::Unknown
        };
    let auth_source_is_safe =
        login_method != LoginMethod::Chatgpt || validate_auth_source(&codex_home).is_ok();
    let status = build_runtime_status(
        selected_node.is_some(),
        selected_codex.is_some(),
        binaries_compatible && auth_source_is_safe,
        login_method,
        node_version.clone(),
        runtime_version.clone(),
    );
    let runtime = if status.compatible && login_method == LoginMethod::Chatgpt {
        let (node_path, _) = selected_node.expect("compatible Node selection is present");
        let (codex_path, _) = selected_codex.expect("compatible Codex selection is present");
        Some(DiscoveredRuntime {
            node_path,
            codex_path,
            codex_home,
            login_method,
        })
    } else {
        None
    };
    (status, runtime)
}

fn build_runtime_status(
    node_compatible: bool,
    codex_compatible: bool,
    safe_and_compatible: bool,
    login_method: LoginMethod,
    node_version: Option<String>,
    runtime_version: Option<String>,
) -> CodexRuntimeStatus {
    let message = if !node_compatible {
        Some("PaperCanvas requires Node.js 18 or newer for the Codex SDK.".into())
    } else if !codex_compatible {
        Some(format!(
            "PaperCanvas requires Codex runtime {EXPECTED_CODEX_VERSION}."
        ))
    } else if login_method != LoginMethod::Chatgpt {
        Some("Sign in to Codex with ChatGPT to use your ChatGPT/Codex plan.".into())
    } else if !safe_and_compatible {
        Some("The local ChatGPT sign-in is not private enough for safe isolation.".into())
    } else {
        None
    };
    CodexRuntimeStatus {
        available: true,
        authenticated: matches!(login_method, LoginMethod::Chatgpt | LoginMethod::Api),
        compatible: safe_and_compatible,
        login_method,
        node_version,
        runtime_version,
        message,
    }
}

async fn select_compatible_node(
    candidates: Vec<PathBuf>,
    home: &Path,
    codex_home: &Path,
) -> (Option<(PathBuf, String)>, Option<String>) {
    let mut first_version = None;
    for path in candidates.into_iter().filter(|path| is_executable(path)) {
        let version = probe(&path, &["--version"], home, codex_home)
            .await
            .as_deref()
            .and_then(parse_node_version);
        if let Some(version) = version {
            first_version.get_or_insert_with(|| version.clone());
            if node_major(&version).is_some_and(|major| major >= MINIMUM_NODE_MAJOR) {
                return (Some((path, version.clone())), Some(version));
            }
        }
    }
    (None, first_version)
}

async fn select_compatible_codex(
    candidates: Vec<PathBuf>,
    home: &Path,
    codex_home: &Path,
) -> (Option<(PathBuf, String)>, Option<(PathBuf, String)>) {
    let mut detected = None;
    for path in candidates.into_iter().filter(|path| is_executable(path)) {
        let version = probe(&path, &["--version"], home, codex_home)
            .await
            .as_deref()
            .and_then(parse_codex_version);
        if let Some(version) = version {
            if detected.is_none() {
                detected = Some((path.clone(), version.clone()));
            }
            if version == EXPECTED_CODEX_VERSION {
                return (Some((path, version)), detected);
            }
        }
    }
    (None, detected)
}

fn unavailable_status(message: &str) -> CodexRuntimeStatus {
    CodexRuntimeStatus {
        available: false,
        authenticated: false,
        compatible: false,
        login_method: LoginMethod::None,
        node_version: None,
        runtime_version: None,
        message: Some(message.into()),
    }
}

async fn probe(
    executable: &Path,
    arguments: &[&str],
    home: &Path,
    codex_home: &Path,
) -> Option<String> {
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .env_clear()
        .env("PATH", minimal_path(executable))
        .env("HOME", home)
        .env("CODEX_HOME", codex_home)
        .env("TMPDIR", std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = timeout(PROBE_TIMEOUT, command.output()).await.ok()?.ok()?;
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.stderr.is_empty() {
        text.push('\n');
        text.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    Some(text)
}

fn parse_node_version(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .find(|word| word.trim_start_matches('v').split('.').count() >= 2)
        .map(|word| word.trim_start_matches('v').to_string())
}

fn parse_codex_version(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .find(|word| {
            word.chars()
                .next()
                .is_some_and(|character| character.is_ascii_digit())
        })
        .map(|word| word.trim().to_string())
}

fn node_major(version: &str) -> Option<u32> {
    version.split('.').next()?.parse().ok()
}

fn parse_login_method(output: &str) -> LoginMethod {
    let lower = output.to_ascii_lowercase();
    if lower.contains("not logged in") || lower.contains("logged out") {
        LoginMethod::None
    } else if lower.contains("logged in using chatgpt") {
        LoginMethod::Chatgpt
    } else if lower.contains("api key") {
        LoginMethod::Api
    } else {
        LoginMethod::Unknown
    }
}

fn minimal_path(executable: &Path) -> OsString {
    let mut directories = Vec::new();
    if let Some(parent) = executable.parent() {
        directories.push(parent.to_path_buf());
    }
    directories.extend([
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ]);
    std::env::join_paths(directories).unwrap_or_else(|_| OsString::from("/usr/bin:/bin"))
}

fn application_codex_candidates(home: &Path) -> Vec<PathBuf> {
    vec![
        PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex"),
        PathBuf::from("/Applications/Codex.app/Contents/Resources/codex"),
        home.join("Applications/ChatGPT.app/Contents/Resources/codex"),
        home.join("Applications/Codex.app/Contents/Resources/codex"),
    ]
}

fn application_node_candidates(home: &Path) -> Vec<PathBuf> {
    vec![
        PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"),
        PathBuf::from("/Applications/Codex.app/Contents/Resources/cua_node/bin/node"),
        home.join("Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"),
        home.join("Applications/Codex.app/Contents/Resources/cua_node/bin/node"),
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
    ]
}

fn nvm_candidates(home: &Path, executable_name: &str) -> Vec<PathBuf> {
    let versions = home.join(".nvm/versions/node");
    let mut candidates = std::fs::read_dir(versions)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("bin").join(executable_name))
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.cmp(left));
    candidates
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn prepare_runtime_assets(resources: &Path, cache: &Path) -> Result<RuntimeAssets, String> {
    let cache_root = cache
        .join(format!("codex-sdk-{EXPECTED_CODEX_VERSION}"))
        .join(uuid::Uuid::new_v4().to_string());
    let vendor_directory = cache_root.join("vendor");
    std::fs::create_dir_all(&vendor_directory)
        .map_err(|_| "The PaperCanvas runtime cache could not be created.".to_string())?;

    for (relative, destination) in [
        ("runner.mjs", cache_root.join("runner.mjs")),
        ("protocol.mjs", cache_root.join("protocol.mjs")),
        ("codex-wrapper.sh", cache_root.join("codex-wrapper.sh")),
        (
            "vendor/codex-sdk.mjs",
            vendor_directory.join("codex-sdk.mjs"),
        ),
        (
            "vendor/LICENSE.codex-sdk",
            vendor_directory.join("LICENSE.codex-sdk"),
        ),
    ] {
        let source = source_asset(resources, relative)?;
        std::fs::copy(source, destination).map_err(|_| {
            "The PaperCanvas Codex SDK resources could not be prepared.".to_string()
        })?;
    }

    let wrapper = cache_root.join("codex-wrapper.sh");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "The PaperCanvas Codex wrapper could not be secured.".to_string())?;
    }
    Ok(RuntimeAssets {
        root: cache_root.clone(),
        runner: cache_root.join("runner.mjs"),
        wrapper,
    })
}

fn source_asset(resources: &Path, relative: &str) -> Result<PathBuf, String> {
    let bundled = resources.join("sidecar").join(relative);
    if bundled.is_file() {
        return Ok(bundled);
    }
    #[cfg(debug_assertions)]
    {
        let development = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../sidecar")
            .join(relative);
        development
            .is_file()
            .then_some(development)
            .ok_or_else(|| "A bundled PaperCanvas Codex SDK resource is missing.".to_string())
    }
    #[cfg(not(debug_assertions))]
    Err("A bundled PaperCanvas Codex SDK resource is missing.".to_string())
}

async fn force_kill_process_group(child: &mut Child) {
    #[cfg(unix)]
    if let Some(process_id) = child.id() {
        // The sidecar is created as its own process group, so this also stops the SDK child.
        unsafe {
            libc::kill(-(process_id as i32), libc::SIGKILL);
        }
    }
    let _ = child.kill().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_request_omits_optional_fields_instead_of_sending_null() {
        let request = StartCodexTurnRequest {
            request_id: "request-1".into(),
            prompt: "hello".into(),
            model: "gpt-5.6-luna".into(),
            reasoning_effort: None,
            output_schema: None,
        };

        let encoded = sidecar_request_json(&request).expect("request encodes");
        let value: Value = serde_json::from_slice(&encoded).expect("request is JSON");
        assert!(!value.as_object().unwrap().contains_key("reasoningEffort"));
        assert!(!value.as_object().unwrap().contains_key("threadId"));
        assert!(!value.as_object().unwrap().contains_key("outputSchema"));
    }

    #[test]
    fn turn_validation_allows_selectable_models_and_supported_reasoning_efforts() {
        let request = StartCodexTurnRequest {
            request_id: "request-1".into(),
            prompt: "hello".into(),
            model: "gpt-5.6-sol".into(),
            reasoning_effort: Some("medium".into()),
            output_schema: None,
        };
        assert!(validate_turn_request(&request).is_ok());

        let terra = StartCodexTurnRequest {
            model: "gpt-5.6-terra".into(),
            reasoning_effort: Some("max".into()),
            ..request.clone()
        };
        assert!(validate_turn_request(&terra).is_ok());

        let invalid_effort = StartCodexTurnRequest {
            model: "gpt-5.6-luna".into(),
            reasoning_effort: Some("minimal".into()),
            ..request.clone()
        };
        assert!(validate_turn_request(&invalid_effort).is_err());

        let invalid_model = StartCodexTurnRequest {
            model: "gpt-5.6-unknown".into(),
            ..request
        };
        assert!(validate_turn_request(&invalid_model).is_err());
    }

    #[test]
    fn not_logged_in_help_text_is_not_misclassified_as_chatgpt_auth() {
        assert_eq!(
            parse_login_method("Not logged in. Sign in with ChatGPT to continue."),
            LoginMethod::None
        );
    }

    #[test]
    fn installed_versions_are_parsed_without_returning_probe_diagnostics() {
        assert_eq!(parse_node_version("v22.23.2\n"), Some("22.23.2".into()));
        assert_eq!(
            parse_codex_version("codex-cli 0.149.0-alpha.4.1\nwarning"),
            Some(EXPECTED_CODEX_VERSION.into())
        );
        assert_eq!(
            parse_login_method("Logged in using ChatGPT"),
            LoginMethod::Chatgpt
        );
    }

    #[test]
    fn runtime_status_fails_closed_when_chatgpt_auth_cannot_be_isolated() {
        let status = build_runtime_status(
            true,
            true,
            false,
            LoginMethod::Chatgpt,
            Some("22.23.2".into()),
            Some(EXPECTED_CODEX_VERSION.into()),
        );

        assert!(status.authenticated);
        assert!(!status.compatible);
        let message = status
            .message
            .expect("unsafe auth has a public status message");
        assert!(message.contains("not private enough"));
        assert!(!message.contains("auth.json"));
    }

    #[test]
    fn runtime_status_preserves_chatgpt_auth_across_a_version_mismatch() {
        let status = build_runtime_status(
            true,
            false,
            false,
            LoginMethod::Chatgpt,
            Some("22.23.2".into()),
            Some("0.150.0-alpha.1".into()),
        );

        assert!(status.authenticated);
        assert!(!status.compatible);
        assert_eq!(status.login_method, LoginMethod::Chatgpt);
        assert!(status
            .message
            .is_some_and(|message| message.contains(EXPECTED_CODEX_VERSION)));
    }

    #[tokio::test]
    async fn bounded_reader_rejects_a_line_before_buffering_past_its_limit() {
        let mut reader = BufReader::new(&b"12345\n"[..]);
        let error = read_bounded_line(&mut reader, 4)
            .await
            .expect_err("oversized line is rejected");
        assert!(error.contains("oversized"));
    }

    #[cfg(target_os = "macos")]
    async fn stubborn_process_group() -> (Child, tokio::process::ChildStdin, i32) {
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                "trap '' TERM; /bin/sleep 30 & descendant=$!; echo $descendant; wait",
            ])
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command.spawn().expect("stubborn process starts");
        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        let mut lines = BufReader::new(stdout).lines();
        let descendant = lines
            .next_line()
            .await
            .expect("pid line is readable")
            .expect("pid line exists")
            .trim()
            .parse()
            .expect("descendant pid is numeric");
        (child, stdin, descendant)
    }

    #[cfg(target_os = "macos")]
    async fn assert_process_gone(process_id: i32) {
        for _ in 0..20 {
            let exists = unsafe { libc::kill(process_id, 0) } == 0
                || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH);
            if !exists {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("process {process_id} survived process-group cleanup");
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn event_bridge_failure_kills_and_reaps_the_stubborn_process_group() {
        let (mut child, mut stdin, descendant) = stubborn_process_group().await;
        let mut guard = ProcessGroupGuard::new(&child);
        let (_cancel_sender, mut cancellation) = oneshot::channel();
        let mut output_task =
            tokio::spawn(async { Err("synthetic event sink failure".to_string()) });

        let result = supervise_process(
            &mut child,
            &mut stdin,
            "test-request",
            &mut cancellation,
            &mut output_task,
            &mut guard,
        )
        .await;

        assert_eq!(result.unwrap_err(), "synthetic event sink failure");
        assert_process_gone(descendant).await;
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn grace_timeout_force_kills_and_reaps_a_stubborn_descendant() {
        let (mut child, _stdin, descendant) = stubborn_process_group().await;
        let mut guard = ProcessGroupGuard::new(&child);

        let status = wait_or_force_kill(&mut child)
            .await
            .expect("stubborn child is force-killed and reaped");
        guard.terminate();

        assert!(!status.success());
        assert_process_gone(descendant).await;
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn leader_exit_still_cleans_a_lingering_descendant() {
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                "/bin/sleep 30 & descendant=$!; echo $descendant; exit 0",
            ])
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command.spawn().expect("leader starts");
        let mut stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        let mut lines = BufReader::new(stdout).lines();
        let descendant = lines
            .next_line()
            .await
            .expect("pid line is readable")
            .expect("pid line exists")
            .trim()
            .parse()
            .expect("descendant pid is numeric");
        let mut guard = ProcessGroupGuard::new(&child);
        let (_cancel_sender, mut cancellation) = oneshot::channel();
        let mut output_task = tokio::spawn(std::future::pending::<Result<bool, String>>());

        let result = supervise_process(
            &mut child,
            &mut stdin,
            "test-request",
            &mut cancellation,
            &mut output_task,
            &mut guard,
        )
        .await
        .expect("leader exit is observed");
        output_task.abort();
        let _ = output_task.await;

        assert!(result.status.success());
        assert_process_gone(descendant).await;
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn dropping_the_supervisor_future_kills_its_whole_process_group() {
        let (child, _stdin, descendant) = stubborn_process_group().await;
        let (ready_sender, ready_receiver) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _guard = ProcessGroupGuard::new(&child);
            let _ = ready_sender.send(());
            std::future::pending::<()>().await;
            drop(child);
        });
        ready_receiver
            .await
            .expect("supervisor installed its process-group guard");
        task.abort();
        let _ = task.await;

        assert_process_gone(descendant).await;
    }
}
