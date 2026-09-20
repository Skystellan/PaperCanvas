# PaperCanvas

PaperCanvas is a minimal, local-first desktop workspace for arranging, reading,
annotating, and discussing research papers. PDFs and product data stay in
app-owned local storage. The current macOS desktop uses Chromium through Electron.
The reader can open ChatGPT in an embedded browser;
annotations and Markdown-based Markmap mind maps work entirely offline.

## What is included

- Resizable Paper Library with search, multi-PDF import, Finder drag-and-drop,
  domains, and compact per-paper action menus
- Double-click a library paper to read it; single-click to locate its canvas card
- Infinite whiteboard with domain views, force layout, and explicit connections
- Remove canvas cards without deleting their library papers; remove connections
  with selection actions or Delete/Backspace
- Support/challenge relationships with locally saved explanations and evidence
- PDF.js reader with selectable text, continuous scrolling, trackpad pinch zoom,
  and restoration of each paper's reading position and reader layout
- Persistent highlights and comments, with coherent backgrounds for overlapping
  formula symbols, plus source-linked quotations in Markdown notes
- Autosaving Markdown notes with live preview, optional source/reading views,
  formatting shortcuts, and one `.md` file bound to each paper
- Paste a Markdown outline from a conversation or write it manually, then render and
  save a local mind map; no AI SDK, runtime, or account is required for this
- Resizable embedded ChatGPT discussion rail with named conversations per paper,
  existing conversation links, and restoration of the last-opened discussion
- Recent discussions remains expanded by default
- Coordinated navigation/close saving and additive SQLite migrations

## Local data and embedded conversations

- `papercanvas.db` stays in the existing `com.papercanvas.desktop` application
  data directory, shared with the earlier Tauri build.
- Imported PDFs are copied into app-owned `papers/<uuid>.pdf` storage. Original
  Finder paths are not persisted.
- Papers, layouts, connections, annotations, notes, and mind-map sources are local.
  Saving or rendering them does not contact an AI service.
- Embedded ChatGPT conversation names and links are stored locally; message
  content remains in ChatGPT. Opening a linked discussion loads that website.
- No PDF, selection, or question is sent automatically. Copy paper information
  copies only the paper title; the user chooses what to paste or attach in ChatGPT.
- The former Codex SDK, runtime bridge, selection Translate/Ask AI, and automatic
  mind-map generation have been removed. Historical migrations and legacy stored
  data remain intact so existing libraries can upgrade without data loss.

## Mind maps

Ask your AI chat for a Markdown outline, then paste it into the paper's Mind map
panel. Markmap is the only renderer. It lays out branches left-to-right with
wrapped labels and short horizontal gaps, suited to the tall reading sidebar.
Click node circles to fold branches, drag to pan, and use the zoom or Fit controls.
Rendering hides the source editor; choose **Edit source** to open it again.

```markdown
# Paper
## Research question
- Gap in prior work
## Method
- Key assumptions
## Results
- Supporting evidence
```

Fenced `markdown`, `md`, or `markmap` blocks are accepted. Source and unfinished
drafts stay local and are saved before navigation/closing. The bundled renderer
loads no external scripts, images or fonts from pasted content. Historical tree
records convert to Markdown on first open; existing Mermaid text is kept intact
for copying/editing, with guidance to convert it to a Markdown outline.

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
**Source** and **Read** remain available through the view menu. Formatting buttons and
Cmd/Ctrl+B, I and K format selections; Enter continues lists. Notes autosave, and navigation/closing
waits for pending saves. **Show .md**, in the note actions menu, reveals the file for use in another editor
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

## Development prerequisites

- Node.js 22.12 or newer and npm
- Stable Rust and the Tauri 2 prerequisites for development builds
- macOS 13 or newer for the current desktop bundle

A Codex installation or SDK login is not required. Embedded ChatGPT uses its own
website sign-in only when the user opens a discussion.

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
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets --locked
```

Create the current macOS desktop bundle with:

```sh
npm run chromium:build
```

The bundle is generated under
`release/PaperCanvas-darwin-arm64/PaperCanvas.app` on Apple
Silicon. Quit the running copy before installing it in a fixed location such as
`~/Applications/PaperCanvas.app`. Moving the application does not move its
paper database or persistent ChatGPT profile. External distribution still
requires a Developer ID signature, notarization, and a release build.

## Chromium desktop and embedded login

The current desktop uses Electron's `WebContentsView` for embedded ChatGPT and retains the existing
Rust storage and Markdown notes:

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
