# Contributing to PaperCanvas

欢迎通过 GitHub Issues 报告问题、讨论功能，或通过 Pull Request 参与维护。
提交问题时请附上复现步骤、预期和实际行为、macOS 版本，以及相关错误信息。
截图和日志请先移除论文内容、账号信息及其他私人数据。

## 本地开发

当前版本以 macOS 13 及以上为目标。准备 Node.js 22.12+、npm、稳定版 Rust
和 Xcode Command Line Tools，然后按 README 克隆并运行项目。
使用 `npm ci` 安装锁定的依赖版本。

划词 AI 和思维导图依赖 README 中指定版本的 Codex runtime 及 ChatGPT 登录；
阅读 README 的运行条件和数据边界后再测试这些功能。
内嵌 ChatGPT 需要在应用内单独登录。

## 项目结构

- `src/features/`：论文库、白板、阅读器、思维导图、AI 和保存协调逻辑。
- `src/data/`：共享 SQLite 接口。
- `src-tauri/src/`：原生窗口、PDF 导入、Codex runtime 和内嵌网页。
- `src-tauri/migrations/`：SQLite 迁移；已有迁移保持不变，以新增迁移扩展数据结构。
- `sidecar/`：Codex Node.js 桥接及测试。
- `docs/`：人工验证记录，注意各记录的日期和验证边界。

## 提交改动

1. Fork 仓库，并从 `main` 创建自己的工作分支。
2. 保持每个 PR 聚焦一个问题，优先复用现有代码和标准库。
3. 按改动范围运行下列检查；行为修复应添加能复现问题的回归测试。
4. 提交 PR，描述问题、改动后的行为和实际完成的验证。
   UI 改动附截图；数据迁移说明如何保留已有数据。

前端检查：

```sh
npm run lint
npm run typecheck
npm run test:coverage
npm run build
```

Codex 桥接检查：

```sh
node --test sidecar/tests/*.test.mjs
```

Rust 检查：

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets --locked
```

涉及原生窗口、PDF 交互或登录的改动，还应使用 `npm run tauri -- dev`
进行对应的实机验证，并在 PR 中说明未验证的部分。

不要提交登录凭据、环境密钥、私人 PDF、应用数据库或构建输出。
保留 `sidecar/vendor/` 中的第三方许可证及归属说明。
