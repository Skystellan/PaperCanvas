use paper_canvas_lib::backend::{Backend, Request};
use serde_json::json;
use std::{
    io::{BufRead, Write},
    path::PathBuf,
};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut data = None;
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--data-dir" => data = Some(PathBuf::from(args.next().ok_or("Expected a path")?)),
            _ => return Err(format!("Unknown argument: {flag}")),
        }
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let backend = runtime.block_on(Backend::open(data.ok_or("--data-dir is required")?))?;
    let mut output = std::io::BufWriter::new(std::io::stdout().lock());
    for line in std::io::stdin().lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(request) => backend.handle(request),
            Err(error) => json!({"id": null, "error": error.to_string()}),
        };
        serde_json::to_writer(&mut output, &response).map_err(|e| e.to_string())?;
        output
            .write_all(b"\n")
            .and_then(|_| output.flush())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
