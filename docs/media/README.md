# README demo

`paper-network-demo.gif` is the inline README preview; `paper-network-demo.mp4`
is the higher-quality version. `paper-network-poster.png` is a still alternative.
Both animated versions include English and Chinese captions and play at 2× speed.

The recording uses the actual application and its SQLite backend with a fresh
temporary profile. It shows dropping papers onto the canvas, connecting and
moving cards, opening a paper discussion, copying/pasting a title and question,
and copying a Markdown outline into the real interactive mind-map renderer.

The PDFs come from the original arXiv papers: [Attention Is All You Need](https://arxiv.org/abs/1706.03762),
[BERT](https://arxiv.org/abs/1810.04805), [Language Models are Few-Shot Learners](https://arxiv.org/abs/2005.14165),
[LoRA](https://arxiv.org/abs/2106.09685), and [QLoRA](https://arxiv.org/abs/2305.14314).
Their connections illustrate a user's organization, not citation data.
The original paper is shown in the actual PDF reader alongside the **real ChatGPT
website**. The prompt and reply are live; the Markdown is selected/copied from
that reply. A separate, signed-out browser profile avoids personal accounts and
history. No fake chat page, prerecorded reply, or account cookies are injected.

The recorder drives the existing UI handlers, checks the 5% pinch zoom limit,
verifies saved cards and connections, verifies copied text, folds/expands the
rendered map, and checks that normal navigation saves the pasted outline.
The captions, cursor, and drag preview are recording overlays. The real native
chat surface is captured separately and composited at its actual window bounds.

To regenerate on macOS with Node, Rust, and `ffmpeg` installed:

```sh
npm run build
npm run chromium:backend
node scripts/record-demo.mjs
```

The recorder downloads the original PDFs into the ignored `release/demo-papers/`
cache. It requires a working connection to ChatGPT and stops if the site is not
available; site layout or access changes may require updating its selectors.

The recorder logs its isolated temporary directory, which holds source PNG
frames and chat/map checkpoints. The final GIF, MP4, and poster are written
here. Preview all three before committing; UI layout changes can affect framing.
