use paper_canvas_lib::{
    backend::{Backend, Request},
    codex_runtime::{self, CancellationRegistry, StartCodexTurnRequest},
};
use serde_json::{json, Value};
use std::{
    io::{BufRead, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::ipc::{Channel, InvokeResponseBody};

fn emit(output: &Mutex<std::io::Stdout>, value: Value) -> Result<(), String> {
    let mut output = output.lock().map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut *output, &value).map_err(|e| e.to_string())?;
    output
        .write_all(b"\n")
        .and_then(|_| output.flush())
        .map_err(|e| e.to_string())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), String> {
    let mut data = None;
    let mut resources = None;
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args.next().ok_or("Expected a path")?;
        match flag.as_str() {
            "--data-dir" => data = Some(PathBuf::from(value)),
            "--resources" => resources = Some(PathBuf::from(value)),
            _ => return Err(format!("Unknown argument: {flag}")),
        }
    }
    let data = data.ok_or("--data-dir is required")?;
    let resources = resources.ok_or("--resources is required")?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let backend = runtime.block_on(Backend::open(data.clone()))?;
    let output = Arc::new(Mutex::new(std::io::stdout()));
    let cancellations = Arc::new(CancellationRegistry::default());
    let (tx, rx) = std::sync::mpsc::channel();
    let worker_output = output.clone();
    let worker = std::thread::spawn(move || {
        for request in rx {
            if emit(&worker_output, backend.handle(request)).is_err() {
                break;
            }
        }
    });
    let mut turns: Vec<tokio::task::JoinHandle<()>> = Vec::new();
    for line in std::io::stdin().lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        let request: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                emit(&output, json!({"id":null,"error":e.to_string()}))?;
                continue;
            }
        };
        turns.retain(|turn| !turn.is_finished());
        if !request.args.is_object() {
            emit(
                &output,
                json!({"id":request.id,"error":"args must be an object"}),
            )?;
            continue;
        }
        match request.command.as_str() {
            "cancel_codex_turn" => {
                let id = request
                    .args
                    .get("requestId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                // Registry bounds both pending cancellations and identifier size.
                let valid = !id.is_empty()
                    && id.len() <= 128
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
                emit(
                    &output,
                    json!({"id":request.id,"result":valid && cancellations.cancel(id)}),
                )?;
            }
            "start_codex_turn" | "codex_runtime_status" => {
                let output = output.clone();
                let cancellations = cancellations.clone();
                let resources = resources.clone();
                let cache = data.join("cache");
                turns.push(runtime.spawn(async move {
                    let result: Result<Value,String>=async {
                        if request.command=="codex_runtime_status" { return serde_json::to_value(codex_runtime::codex_runtime_status().await).map_err(|e|e.to_string()); }
                        let turn: StartCodexTurnRequest=serde_json::from_value(request.args.get("request").cloned().ok_or("Missing request")?).map_err(|e|e.to_string())?;
                        codex_runtime::validate_turn_request(&turn)?;
                        let cancel=cancellations.register(&turn.request_id)?;
                        let id=turn.request_id.clone();
                        let event_id=id.clone(); let event_output=output.clone();
                        let channel=Channel::new(move |body| {
                            let event=match body { InvokeResponseBody::Json(s)=>serde_json::from_str::<Value>(&s)?, _=>return Err(tauri::Error::Io(std::io::Error::other("Expected JSON event"))) };
                            emit(&event_output,json!({"event":"codex-stream","payload":{"requestId":event_id,"event":event}})).map_err(|e|tauri::Error::Io(std::io::Error::other(e)))
                        });
                        let result=codex_runtime::run_codex_turn(&resources,&cache,turn,channel,cancel).await;
                        cancellations.finish(&id);
                        result.map(|_|Value::Null)
                    }.await;
                    let response=match result { Ok(result)=>json!({"id":request.id,"result":result}), Err(error)=>json!({"id":request.id,"error":error}) };
                    let _=emit(&output,response);
                }));
            }
            _ => tx.send(request).map_err(|e| e.to_string())?,
        }
    }
    drop(tx);
    worker.join().map_err(|_| "Database worker failed")?;
    for turn in turns {
        turn.abort();
    }
    runtime.shutdown_timeout(std::time::Duration::from_secs(3));
    Ok(())
}
