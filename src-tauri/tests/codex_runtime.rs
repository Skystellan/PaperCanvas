use std::path::{Path, PathBuf};

use paper_canvas_lib::codex_runtime::{
    candidate_executables, parse_sidecar_event, validate_turn_request, CancellationRegistry,
    CodexRuntimeEvent, StartCodexTurnRequest,
};

#[test]
fn request_validation_rejects_paths_and_argument_injection() {
    let valid = StartCodexTurnRequest {
        request_id: "turn-01".into(),
        prompt: "Explain the selected passage.".into(),
        model: "gpt-5.6-luna".into(),
        reasoning_effort: Some("medium".into()),
        output_schema: None,
    };
    assert!(validate_turn_request(&valid).is_ok());

    let invalid_id = StartCodexTurnRequest {
        request_id: "../turn".into(),
        ..valid.clone()
    };
    assert!(validate_turn_request(&invalid_id).is_err());

    let invalid_model = StartCodexTurnRequest {
        model: "gpt-5.6-luna --dangerously-bypass-approvals-and-sandbox".into(),
        ..valid
    };
    assert!(validate_turn_request(&invalid_model).is_err());
}

#[test]
fn renderer_request_protocol_rejects_legacy_thread_ids() {
    let request = serde_json::from_value::<StartCodexTurnRequest>(serde_json::json!({
        "requestId": "turn-01",
        "prompt": "Explain the selected passage.",
        "model": "gpt-5.6-luna",
        "threadId": "0198f4f0-42b6-7000-8000-000000000001"
    }));

    assert!(request.is_err());
}

#[test]
fn sidecar_protocol_accepts_only_projected_events() {
    let event =
        parse_sidecar_event(r#"{"type":"message","itemId":"message-1","text":"safe snapshot"}"#)
            .expect("agent messages are allowed");
    assert_eq!(
        event,
        CodexRuntimeEvent::Message {
            item_id: "message-1".into(),
            text: "safe snapshot".into()
        }
    );

    assert!(parse_sidecar_event(
        r#"{"type":"command_execution","command":"cat ~/.codex/auth.json"}"#
    )
    .is_err());
    assert!(parse_sidecar_event(
        r#"{"type":"message","itemId":"message-1","text":"safe","secret":"leak"}"#
    )
    .is_err());
}

#[test]
fn finder_safe_candidates_include_path_chatgpt_and_nvm_locations() {
    let home = Path::new("/Users/researcher");
    let candidates = candidate_executables(
        "codex",
        Some("/usr/bin:/custom/bin"),
        Some(home),
        &[PathBuf::from(
            "/Applications/ChatGPT.app/Contents/Resources/codex",
        )],
        &[PathBuf::from(
            "/Users/researcher/.nvm/versions/node/v22.0.0/bin/codex",
        )],
    );

    assert!(candidates.contains(&PathBuf::from("/custom/bin/codex")));
    assert!(candidates.contains(&PathBuf::from(
        "/Applications/ChatGPT.app/Contents/Resources/codex"
    )));
    assert!(candidates.contains(&PathBuf::from(
        "/Users/researcher/.nvm/versions/node/v22.0.0/bin/codex"
    )));
    assert!(candidates.contains(&PathBuf::from("/Users/researcher/.local/bin/codex")));
}

#[tokio::test]
async fn cancellation_registry_delivers_once_and_forgets_finished_requests() {
    let registry = CancellationRegistry::default();
    let receiver = registry
        .register("request-1")
        .expect("first registration succeeds");
    assert!(registry.register("request-1").is_err());
    assert!(registry.cancel("request-1"));
    receiver.await.expect("cancel is delivered");
    assert!(!registry.cancel("request-1"));
    registry.finish("request-1");

    assert!(registry.cancel("request-before-start"));
    let receiver = registry
        .register("request-before-start")
        .expect("a prompt cancellation is consumed when start registers");
    receiver
        .await
        .expect("the prompt cancellation is delivered");
    assert!(!registry.cancel("request-before-start"));
    registry.finish("request-before-start");
}

#[tokio::test]
async fn cancellation_registry_limits_global_codex_concurrency() {
    let registry = CancellationRegistry::default();
    let first = registry
        .register("request-1")
        .expect("first turn registers");
    let second = registry
        .register("request-2")
        .expect("second turn registers");

    assert!(registry.register("request-3").is_err());
    assert!(registry.cancel("request-1"));
    assert!(registry.cancel("request-2"));
    assert!(registry.register("request-3").is_err());
    first.await.expect("first cancellation arrives");
    second.await.expect("second cancellation arrives");
    registry.finish("request-1");
    assert!(registry.register("request-3").is_ok());
}
