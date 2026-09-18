# PaperCanvas V6

PaperCanvas is a minimal, local-first desktop workspace for arranging, reading,
annotating, and discussing research papers. PDFs and product data stay in
app-owned local storage. The reader can open ChatGPT in an embedded browser;
selection actions and mind maps use the existing Codex integration.

## What is included

- Resizable Paper Library with search, multi-PDF picker, Finder drag-and-drop,
  and confirmed deletion of app-managed copies
- Validated PDF import into app-owned `papers/<uuid>.pdf` storage
- Infinite React Flow whiteboard with an Obsidian-style force layout that
  separates domain groups before the first painted board, limits drag response to
  nearby graph neighbors, untangles crossing links, preserves dropped positions and
  reader round-trips, and creates straight connections only from explicit,
  keyboard-accessible handles
- Mac trackpad behavior: pinch zooms; two-finger horizontal or vertical scrolling
  pans; wheel scrolling does not zoom
- PDF.js reader with a bundled worker, lazy HiDPI page rendering, selectable text,
  continuous scrolling, cursor-anchored trackpad pinch zoom, toolbar zoom, and
  page navigation
- PaperCanvas-style selection actions for local Notes, Translate, and Ask AI
- Persistent page-relative highlights with comments, search, delete, jump-to-page,
  and zoom-safe overlays
- Autosaving paper Notes and an independent AI-generated Mind Map with straight
  parent links, overlap-free nodes, validation, cancellation, and local persistence
- Resizable ChatGPT discussion rail with multiple named conversations per paper,
  existing conversation links, and restoration of the last-opened discussion
- One coordinated close/navigation guard for canvas, notes, highlights, mind maps,
  and active AI work
- Additive SQLite migrations that preserve earlier PaperCanvas data

## Local-first and AI data boundary

- `papercanvas.db` is stored in Tauri's app configuration directory.
- Imported PDFs are stored under the app data directory in `papers/`.
- Original Finder paths are never persisted.
- Papers, layouts, edges, highlights, notes, mind maps, extracted text, and chat
  legacy Codex chat history are stored locally in SQLite/app-owned files.
- Embedded ChatGPT conversation names and links are stored locally; their message
  content remains in ChatGPT. Opening a linked discussion loads that website.
- Saving a Note never contacts a network service.
- Translate and Ask AI send the selected passage to Codex through the user's
  ChatGPT sign-in. A Mind Map or explicitly attached discussion context sends the
  complete extracted paper text after an in-app disclosure.
- AI turns run with read-only sandboxing, approvals disabled, tools/network access
  disabled, and no API key stored by PaperCanvas. Each turn is ephemeral, so the
  paper/chat prompt is not retained in Codex session history; PaperCanvas rebuilds
  context from its local SQLite history.
- Every turn receives a fresh private `HOME` and `CODEX_HOME` containing only a
  validated bridge to the existing ChatGPT sign-in. Global `AGENTS.md`, custom or
  user-installed skills and plugins, host paths, and Codex environment/permission
  metadata are not included in the model request. The pinned runtime still adds
  its standard built-in system instructions.

## Paper conversations in ChatGPT

Open a paper and select **AI chat**. Click **＋** to open a new discussion immediately,
or **关联已有对话** to paste its ChatGPT conversation URL (not a share link).
Each paper has its own discussion list and restores its most recently opened entry.
After the first message creates a conversation, its URL is saved automatically.
The initial name is 新对话; native page-title events synchronize ChatGPT’s
conversation title into the local list, including later title changes.
Use the app's **新对话** button for a separate topic; navigation inside ChatGPT
does not replace an existing binding. **回到绑定对话** returns to that saved link.

This uses native Tauri child webviews, not an iframe. Sign in inside the embedded
browser on first use; it does not borrow Chrome's login. **复制论文信息** copies only the paper title, without a success message. No PDF or question is automatically sent.
Messages are not copied into the local database or available offline. Projects
are optional; the app itself groups conversation links by paper.

## Codex for selection actions and mind maps

This personal macOS beta uses `@openai/codex-sdk@0.149.0-alpha.4.1` with the
matching local Codex runtime. The AI settings allowlist `gpt-5.6-sol`,
`gpt-5.6-terra`, and `gpt-5.6-luna`, plus Low through Max reasoning effort; the
active choice is always visible in the discussion rail. PaperCanvas deliberately
accepts only **Sign in with ChatGPT** authentication, so it uses the user's
ChatGPT/Codex plan allowance rather than an API Platform key balance.

Prerequisites for the current build:

- Node.js 18 or newer for the packaged Codex bridge
- Node.js 22.12 or newer is recommended for local Vite/Tauri development
- A matching local Codex runtime, currently `0.149.0-alpha.4.1`
- `codex login status` reports `Logged in using ChatGPT`
- A private, file-backed Codex login (`auth.json` must be a regular file readable
  only by its owner; permissive files and symlinks are rejected)
- Stable Rust and the Tauri 2 prerequisites for development builds

The app detects Codex/Node from the installed ChatGPT or Codex macOS app, common
local install locations, and the development environment. It fails closed on
unsupported platforms or incompatible versions.

## Run locally

```sh
git clone https://github.com/Skystellan/PaperCanvas.git
cd PaperCanvas
npm ci
npm run tauri -- dev
```

## Contributing

Bug reports and focused pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md)
for development setup, the project structure, and checks to run before submitting changes.

## Quality checks

```sh
npm run lint
npm run typecheck
npm run test:coverage
npm run build
node --test sidecar/tests/*.test.mjs
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets --locked
```

Create a macOS development bundle with:

```sh
npm run tauri -- build --debug --bundles app
```

The generated debug app is for local QA. External distribution still requires a
Developer ID signature, notarization, and a release build.
