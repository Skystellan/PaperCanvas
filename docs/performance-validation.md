# Chat and PDF performance checks — 2026-09-19

## Follow-up: same-account email/password login — authenticated history observed

The user's signed-in Chrome account visibly offers **账户安全与登录 → 密码 → 添加**.
Opening that action navigates to OpenAI's identity-verification page, which
requests an existing passkey or another configured authentication method.
The user completed password setup in the browser; a subsequent settings check
showed the masked password row in place of **添加**. The user also reported
having to sign in to Codex again after this account-credential change.
No password or verification code was entered or retrieved by the agent.

The running `release/chat-fix/` Chromium app was normally closed and reopened
without changing its profile. Reopening the same unstarted paper conversation
loaded the real ChatGPT homepage, and **登录** opened a dialog containing an
email-address field and **继续**. Before that restart, the guest was stuck on
the previously blocked Google-login route.

After the user continued the embedded login, the actual app displayed
OpenAI's **查看你的身份验证器应用** page with an empty one-time-code field.
The user completed MFA directly in the app and confirmed login succeeded.
Native app inspection then showed an existing long conversation with Chinese
responses, formulas, citations and the message composer. No manual conversation
link was pasted during this login validation. The exact password-entry
interaction was user-operated and was not observed by the agent.

The same verified app bundle was installed at `~/Applications/PaperCanvas.app`.
After normally quitting the preview and launching the installed copy, process
inspection confirmed that executable path, and native UI inspection again
showed the authenticated historical conversation and composer. The existing
library and recent discussions remained available, using the same application
data and Chromium profile.

This verifies successful embedded authentication, historical content access
and login persistence across this restart for this account. Message submission
has not been tested by the agent. The user is separately evaluating ChatGPT
responsiveness; these observations do not establish a typing, scrolling or
panel-resize speedup.

Publication checks passed: all 446 frontend tests across 50 files, the 12
Electron/sidecar tests, Rust tests, ESLint, TypeScript/production build, Rust
formatting and Clippy. One pinch-coalescing test was corrected to await the
rendered page before sending input; no PDF runtime code changed during this
installation and publication step.

References: [OpenAI password settings](https://help.openai.com/en/articles/4936828),
[social-login account password setup](https://help.openai.com/en/articles/4936827).
Google's embedded OAuth restriction is not a finding that all OpenAI login
methods are unavailable inside the app.

## Follow-up: embedded ChatGPT stays blank

The user confirmed PDF zoom is now smooth. No PDF runtime changes were made in
this follow-up. The running Chromium build was inspected through macOS UI:
the guest had title “请稍候…” but displayed no page content. An isolated live
ChatGPT request reproduced the empty, fully loaded document; a subsequent
fresh-session request returned HTTP 200 with the real unauthenticated ChatGPT
homepage. Both used the system-configured proxy. No proxy settings, cookies,
login credentials or security checks were changed.

A local HTML fixture was visibly rendered in the native child view, with
nonzero parent/child bounds and visible state, ruling out the display-layer
hypothesis for the reproduction. The existing “重试网页” action only reissued
layout and could not recover a failed page.

Changes: reload now invokes the browser's real reload operation (Chromium
ignores HTTP cache), website challenge responses are recognized from the
`cf-mitigated: challenge` header, failed/slow loads are reported per conversation,
and status is replayed when a cached view is reopened. Ready pages stop showing
the underlying opening placeholder. Challenge titles no longer overwrite
saved conversation names.

Verification: 10 WebChatPanel tests and three Rust web-chat tests passed;
TypeScript/build and ESLint passed. The real-window fixture exercised an HTTP
403 challenge followed by a successful reload, observed another page request,
cleared the verification notice, and retained the same guest/session. Native
UI inspection confirmed the local test page was actually visible. Live
homepage loading was observed, but the user's signed-in historical conversation
was not recovered or verified. Third-party verification can still block a
request; this change does not bypass it.

For an explicit fresh-session live probe after building, run
`PAPERCANVAS_LIVE_CHAT=1 node electron/run-smoke.mjs`. It never imports the
user's chat profile or sends a message. The default smoke remains offline.

The reported issues were slow historical ChatGPT conversations (both opening
and interacting) and stuttering PDF pinch/button zoom in macOS PaperCanvas.

## Follow-up: Google login and remaining zoom stutter

The Chromium preview did not validate the user's Google sign-in method before
delivery. Google explicitly blocks OAuth in embedded browsers; replacing
WKWebView with Chromium does not provide a supported Google login flow.
[Google's policy](https://developers.googleblog.com/upcoming-security-changes-to-googles-oauth-20-authorization-endpoint-in-embedded-webviews/)
explains the restriction.

The preview now catches Google account navigation/redirects and popups and
shows a local login-help panel. Its browser action opens the saved ChatGPT
conversation or ChatGPT home, never an OAuth URL from the embedded session.
The panel explicitly says browser login is not synchronized to the app and
explains how to bind a newly created browser conversation back to the paper.
Both shells have a manual help button. This is a usable external-browser path;
Google login inside the embedded view remains unsupported.

A real-window smoke check using intercepted local fixtures passed Google
popup and same-window navigation handling, draft retention, and remote
isolation. It did not enter credentials or verify a live Google login.

The initial PDF fix below only coalesced expensive work. The follow-up previews
zoom using a transform of the existing page layer, then applies PDF.js layout
after interaction settles. The runnable `electron/pdf-performance-smoke.mjs`
measures frame intervals plus Chromium layout/style/script CPU durations and
checks pointer-anchor movement and actual text selection after settling.
The fixture and a copy of a real 25-page library PDF are measured in separate
temporary profiles. No source PDF or user database is modified.

The baseline already maintained roughly 60 Hz in these scripted tests (real
paper pinch p95 17.5 ms, maximum 18.4 ms). Consequently, these tests alone do
not reproduce or establish resolution of the user's full perceptual complaint.
No side-by-side alphaXiv benchmark has been completed.

The follow-up also fixes two input issues: fast synthetic Ctrl-wheel pinches
were being classified as discrete mouse-wheel ticks by a 5% magnitude cutoff,
and sub-percent scale rounding made small pinch motion visually step. Pinch
previews now retain the fractional scale, and a physically held Ctrl key still
selects the mouse-wheel path.

Final local measurements (one scripted run per case; durations include 90
animation frames and 700 ms for settling):

| PDF / input | Before layout + style CPU | After layout + style CPU | Before p95 frame | After p95 frame |
| --- | ---: | ---: | ---: | ---: |
| Real 25-page / pinch | 63.14 ms | 42.30 ms | 17.5 ms | 17.7 ms |
| Real 25-page / buttons | 33.72 ms | 35.96 ms | 18.9 ms | 17.7 ms |
| Synthetic 150-page / pinch | 75.61 ms | 39.28 ms | 17.4 ms | 17.3 ms |
| Synthetic 150-page / buttons | 40.45 ms | 24.73 ms | 19.8 ms | 17.5 ms |

Neither final run changed PDF.js's layout scale during continuous input. Both
cleared the preview transform after settling; page-point movement was below
0.3 CSS pixels in the preview and below 0.3 pixels at commit. Selecting text
after commit returned nonempty text in both documents. These measurements
show less work for pinch/long-document zoom, not a universal FPS gain: the
real-document button case's layout/style CPU did not improve.

An intermediate real-window run left a preview transform and produced an
unexpected initial zoom. It did not reproduce after preventing real mouse
input from mixing with scripted events. The cause is not established; the
final harness explicitly checks both initial scales and transform cleanup.

Final checks: 90 focused frontend tests and three Electron boundary tests
passed, with TypeScript, ESLint and the production frontend build. A flaky
test-only renderer check was corrected to wait for the page canvas to render
before dispatching pinch events; the page-count label alone was insufficient.
The final real-window smoke passed 100% → 210% → 267% zoom, Google-login help,
guest draft retention and isolation with no renderer errors. The Chromium
bundle is under `release/zoom-fix/` to avoid replacing the running preview.

## First iteration: changes and rationale

- The PDF.js production runtime previously ran `updateScale` for every input
  event. Its drawing delay defers rasterization but still updates page layout.
  Zoom targets now accumulate and flush once per animation frame, including
  wheel/trackpad, WebKit gesture events, touch gestures and repeated buttons.
  Gesture completion flushes the last target; teardown cancels queued work.
- The existing Tauri app keeps WKWebView and adds **在浏览器中打开** for a bound
  discussion. This allows comparison using the browser's existing session.
- The optional Chromium app uses Electron `WebContentsView`. Returning to an
  open discussion reuses the view and retains its draft. Page navigation/title
  events replace address polling. Remote pages have no preload, Node access,
  or local database/file IPC.
- The Electron transport retains the original Rust import, note-conflict,
  migration and Codex-isolation logic. PDF bytes use binary IPC rather than a
  JSON array of individual numbers.

## First iteration: observed verification

- Frontend: 433 tests passed; coverage thresholds passed (93.95% lines,
  81.27% branches). TypeScript and ESLint passed.
- Rust: 55 tests passed, including migrations, import/delete rollback, note
  conflicts, Codex isolation/cancellation and the JSON-lines bridge.
- Zoom regression: 128 gesture events in eight simulated frames cause eight
  PDF.js scale updates; final zoom remains 360%. Repeated buttons are also
  coalesced. This measures work count, not display FPS.
- Real Electron 44.4.3 / Chromium 152.0.7977.130: a synthetic 20-page PDF rendered
  through production PDF.js; six zoom buttons changed 100% to 210%, then twelve
  pinch events changed it to 267%; text-layer content remained available.
- A local remote-page fixture confirmed no `window.paperCanvas` or `require`,
  sandbox enabled, and the same webContents/draft retained after hide/show.
- The packaged Chromium app started with a temporary data directory, displayed
  the native library/canvas UI, and closed through its normal save-on-close path.
- Both the Tauri debug bundle and the separate Chromium preview were built.

## Limits

These checks used synthetic PDFs and an intercepted local chat fixture, not the
user's ChatGPT login or real historical conversations. They do not establish a
ChatGPT loading-time improvement or an FPS comparison between engines. Actual
long-conversation performance requires opening the same conversation in the
preview after signing in. Network delays are not fixed by changing the engine.
Large or complex PDFs can still have expensive individual raster/layout work.

The preview shares the existing paper/notes database while storing its own
ChatGPT browser session. Compare with one PaperCanvas version open at a time.
No existing ChatGPT cookies were copied or cleared.
