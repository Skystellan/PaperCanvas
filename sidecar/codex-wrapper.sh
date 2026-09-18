#!/bin/sh
set -eu

if [ "${1-}" != "exec" ]; then
  exit 64
fi

if [ -z "${PAPERCANVAS_CODEX_BINARY-}" ] || [ ! -x "$PAPERCANVAS_CODEX_BINARY" ]; then
  exit 69
fi

shift
exec "$PAPERCANVAS_CODEX_BINARY" exec \
  --ignore-user-config \
  --ignore-rules \
  --ephemeral \
  --config 'cli_auth_credentials_store="file"' \
  --config 'forced_login_method="chatgpt"' \
  --config include_environment_context=false \
  --config include_permissions_instructions=false \
  --config include_apps_instructions=false \
  --config include_collaboration_mode_instructions=false \
  --disable apps \
  --disable artifact \
  --disable auth_elicitation \
  --disable browser_use \
  --disable browser_use_external \
  --disable browser_use_full_cdp_access \
  --disable code_mode \
  --disable code_mode_host \
  --disable code_mode_interrupt \
  --disable code_mode_only \
  --disable computer_use \
  --disable current_time_reminder \
  --disable default_mode_request_user_input \
  --disable deferred_executor \
  --disable deferred_tool_world_state \
  --disable enable_mcp_apps \
  --disable exec_permission_approvals \
  --disable executed_tool_call_metadata \
  --disable executor_capability_discovery \
  --disable external_agent_memory_import \
  --disable goals \
  --disable guardian_approval \
  --disable hooks \
  --disable image_generation \
  --disable in_app_browser \
  --disable in_app_updates \
  --disable memories \
  --disable mentions_v2 \
  --disable multi_agent \
  --disable multi_agent_v2 \
  --disable network_proxy \
  --disable plugins \
  --disable plugin_sharing \
  --disable prevent_idle_sleep \
  --disable psp \
  --disable realtime_conversation \
  --disable recommended_plugins \
  --disable remote_plugin \
  --disable request_permissions_tool \
  --disable shell_snapshot \
  --disable shell_tool \
  --disable skill_mcp_dependency_install \
  --disable skill_search \
  --disable standalone_web_search \
  --disable tool_call_mcp_elicitation \
  --disable tool_suggest \
  --disable unavailable_dummy_tools \
  --disable unified_exec \
  --disable view_image \
  --disable workspace_dependencies \
  "$@"
