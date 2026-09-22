# README demo

`paper-network-demo.gif` is the inline README preview; `paper-network-demo.mp4`
is the higher-quality version. `paper-network-poster.png` is a still alternative.
Both animated versions include English and Chinese captions and play at 2× speed.

The recording uses the actual built application and its SQLite backend. A fresh
temporary profile contains five example paper titles and blank placeholder PDFs.
The relationships illustrate a user's organization, not citation data or claims
about the papers. No personal library, notes, or account session is recorded.

The recorder drives the existing UI handlers: HTML5 drag events for dropping a
library paper, then native pointer events for connecting and moving cards. It
checks the resulting card and edge counts in the database and checks for visible
errors. The captions, visible cursor, and drag preview are recording overlays. The product
UI and layout physics are unchanged.

To regenerate on macOS with Node, Rust, and `ffmpeg` installed:

```sh
npm run build
npm run chromium:backend
node scripts/record-demo.mjs
```

The recorder logs its isolated temporary directory, which also holds the source
PNG frames. The final GIF, MP4, and poster are written here. Preview all three
before committing them; changes to titles or interface layout can affect framing.
