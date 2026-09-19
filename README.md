# PaperCanvas V6

PaperCanvas is a minimal, local-first desktop workspace for arranging, reading,
annotating, and discussing research papers. PDFs and product data stay in
app-owned local storage. The current macOS desktop uses Chromium through Electron.
The reader can open ChatGPT in an embedded browser;
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
- Autosaving Markdown paper Notes with inline live preview, source/split/reading modes,
  formatting shortcuts, and one `.md` file bound to each paper
- An independent AI-generated Mind Map with straight
  parent links, overlap-free nodes, validation, cancellation, and local persistence
- Resizable ChatGPT discussion rail with multiple named conversations per paper,
  existing conversation links, and restoration of the last-opened discussion
- One coordinated close/navigation guard for canvas, notes, highlights, mind maps,
  and active AI work
- Additive SQLite migrations that preserve earlier PaperCanvas data

## Local-first and AI data boundary

- `papercanvas.db` remains in the existing `com.papercanvas.desktop` application
  data directory, shared with the earlier Tauri build.
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

## Markdown notes

Opening Notes creates `papers/<paper-id>.md` beside the managed PDF. Existing
SQLite notes migrate on first open; their original database rows remain as a
backup. From then on the Markdown file is the source of truth. The binding uses
the paper ID, so editing a paper title does not break it.

**Live preview** is the default: click a rendered block to edit its Markdown
in place. The selected block stays as highlighted source while other blocks
render headings, emphasis, quotes, fenced code, tables and task lists. Moving
the cursor away renders it again. CodeMirror keeps one underlying Markdown
document with undo/redo, multiline selection and input composition support.
**Source**, **Split**, and **Read** remain available. Formatting buttons and
Cmd/Ctrl+B, I and K format selections; Enter continues lists. Notes autosave, and navigation/closing
waits for pending saves. **Show .md** reveals the file for use in another editor
or an Obsidian vault opened at the papers directory. **Reload** reads external
changes after confirming that the current unsaved draft may be discarded.
If the file changed outside PaperCanvas, saving stops: copy your draft, reload,
then merge your changes. Files are replaced atomically on save. External edits
are checked before each save, not continuously watched; avoid simultaneous writes
in two editors. Deleting a paper retains its Markdown file as a safety copy.
Inline rendering operates on Markdown blocks (a whole list, table, or code
fence becomes source when selected). Obsidian plugins, wikilinks, and math
rendering are not included.

## Paper conversations in ChatGPT

Open a paper and select **AI chat**. Click **＋** to open a new discussion immediately,
or **关联已有对话** to paste its ChatGPT conversation URL (not a share link).
Each paper has its own discussion list and restores its most recently opened entry.
The canvas’s Recent discussions reads these same ChatGPT bindings, shows the
associated paper, and refreshes when returning from the reader, when titles
change, or when papers are removed. Clicking an entry opens that exact
conversation in its paper’s AI chat tab.
After the first message creates a conversation, its URL is saved automatically.
The initial name is 新对话; native page-title events synchronize ChatGPT’s
conversation title into the local list, including later title changes.
Use the app's **新对话** button for a separate topic; navigation inside ChatGPT
does not replace an existing binding. **回到绑定对话** returns to that saved link.

This uses native Chromium child views, not an iframe. Sign in inside the embedded
browser on first use; it does not borrow Chrome's login. Use the email/password
login path described below. **复制论文信息** copies only the paper title, without a success message. No PDF or question is automatically sent.
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
npm run chromium:dev
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

Create the current macOS desktop bundle with:

```sh
npm run chromium:build
```

The bundle is generated under
`release/PaperCanvas Chromium-darwin-arm64/PaperCanvas Chromium.app` on Apple
Silicon. Quit the running copy before installing it in a fixed location such as
`~/Applications/PaperCanvas.app`. Moving the application does not move its
paper database or persistent ChatGPT profile. External distribution still
requires a Developer ID signature, notarization, and a release build.

## Chromium desktop and embedded login

The current desktop uses Electron's `WebContentsView` for embedded ChatGPT and retains the existing
Rust storage, Markdown notes, and isolated Codex runtime:

```sh
npm run chromium:dev
npm run chromium:build
```

It uses the existing `com.papercanvas.desktop` data directory. ChatGPT uses its
own persistent Chromium profile under that directory's `chromium` subdirectory;
Chrome's cookies are not imported or synchronized. The original Tauri/WKWebView
build remains available through `npm run tauri -- dev`; quit the other version
before comparing them.

To sign in inside PaperCanvas, choose **登录**, enter the email address of your
existing ChatGPT account, and continue with its password and configured MFA.
Once authenticated, ChatGPT shows that account's existing history. PaperCanvas
automatically saves the URL of a new paper discussion after its first message.

If the account was created with Google and has no OpenAI password, open the
already signed-in ChatGPT account in a regular browser and find
**Settings → Security and login → Password → Add** (some versions place it
under **Account**). Complete identity verification and password setup there,
then use the same email and new password inside PaperCanvas. This adds a
credential to the existing account. Password changes affect the shared OpenAI
account and may require signing in again to other sessions, including Codex.
See [OpenAI password settings](https://help.openai.com/en/articles/4936828) and
[social-login account password setup](https://help.openai.com/en/articles/4936827).

Google prohibits OAuth sign-in inside embedded browsers, including Chromium
webviews. The **使用 Google 账户继续** button therefore shows **登录帮助**;
use the email/password path for embedded login. The external-browser button
remains available, but signing in there does not sign the embedded view in.
See [Google's embedded-webview policy](https://developers.googleblog.com/upcoming-security-changes-to-googles-oauth-20-authorization-endpoint-in-embedded-webviews/).

If the embedded page stays blank, **重新加载网页** reloads the current page
(ignoring HTTP cache in Chromium) while keeping its login/session storage.
Chromium now displays website-verification, network-failure and slow-load
notices. Reopening a cached view restores its load status instead of reporting
an unqualified “opening” message. Website verification titles such as
“请稍候…” do not overwrite conversation names.

In either version, **在浏览器中打开** opens the selected discussion in the default
browser, using that browser's existing session. This is the smallest workaround
when WKWebView is slow. Switching engines can help rendering compatibility; it
does not guarantee faster ChatGPT network responses.

PDF pinch and repeated zoom buttons preview the existing page layer with a CSS
transform. PDF.js applies the final scale after input settles, preserving the
page point under the pointer, then redraws at full resolution.

`npm run chromium:test` checks desktop boundaries.
`npm run chromium:smoke` runs a real Chromium window with a synthetic 20-page
PDF and local chat fixture in a temporary profile. It checks zoom, selectable
text, retained chat drafts, and remote page isolation without accessing real
ChatGPT conversations or the user's library.

`PAPERCANVAS_PERFORMANCE=1 node electron/run-smoke.mjs` measures frame times and
Chromium layout/style/script work on a synthetic 150-page PDF. Set
`PAPERCANVAS_SMOKE_PDF=/absolute/path/to/paper.pdf` to import a local copy into the
temporary profile instead. This mode also checks the zoom anchor and text
selection after settling. Build first with `npm run build`.
