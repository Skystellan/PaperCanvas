# 首次 GitHub 上传验证

2026-09-18，macOS；Node.js 22.23.2、npm 10.9.8、Cargo 1.97.1。
对应首次源码提交 `8122e21`。

| 检查 | 结果 |
| --- | --- |
| `npm run lint` | 通过 |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过；Vite 提示部分产物超过 500 kB |
| `node --test sidecar/tests/*.test.mjs` | 9 项通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --all-targets --locked` | 52 项通过 |
| `npm run test:coverage` | 396 项通过，1 项失败，未完成覆盖率验收 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 未通过，`src-tauri/src/codex_runtime/mod.rs` 存在两处格式差异 |

前端失败项是 `PdfViewer.test.tsx` 中的
`keeps a wheel-first pinch stream when duplicate WebKit events follow`：
全量运行时预期缩放标签为 `111%`，实际为 `100%`。随后单独执行：

```sh
npm test -- src/features/reader/PdfViewer.test.tsx -t 'keeps a wheel-first pinch stream'
```

该项通过。尚未确认其受测试顺序还是时序影响，也未修改应用代码或测试。
后续维护需要定位此差异，不能将单项通过视为全量覆盖率检查通过。

本轮未运行 Clippy、原生应用打包或登录后的 GUI 验证。
上传排除了依赖、构建输出、覆盖率产物及本地数据；待上传文件未匹配常见密钥格式。
