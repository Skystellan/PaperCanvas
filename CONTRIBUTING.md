# Contributing to PaperCanvas

欢迎通过 GitHub Issues 报告问题、讨论功能，或通过 Pull Request 参与维护。
提交问题时请附上复现步骤、预期和实际行为、操作系统版本，以及相关错误信息。
截图和日志请先移除论文内容、账号信息及其他私人数据。

## 本地开发

当前版本支持 macOS 13+ 和 Windows 10/11 x64。准备 Node.js 22.12+、npm、稳定版 Rust；
macOS 安装 Xcode Command Line Tools，Windows 安装 Visual Studio 2022 Build Tools
（勾选“使用 C++ 的桌面开发”和 Windows SDK），然后按 README 克隆并运行项目。
使用 `npm ci` 安装锁定的依赖版本。

Linux 0.2.9 的兼容目标为 Ubuntu 20.04 / 22.04 / 24.04 x64，按 README 安装 Linux 构建依赖后，
同样使用 `npm run chromium:dev` 和 `npm run chromium:build`。发布包在 Ubuntu 20.04 容器
构建，生成 `.deb` 和 AppImage，并在 Ubuntu 22.04 / 24.04 验证安装和更新。
Electron 后端使用 `--no-default-features`，无需 Tauri/WebKit 开发包；默认 Cargo features 保留旧 Tauri 壳。Linux CI 使用 Xvfb
运行 X11 冒烟测试；涉及 Wayland、中文输入法或真实 ChatGPT 登录的改动仍需实机验证。

标注和 Markmap 思维导图完全在本地运行，无需 AI SDK。内嵌 ChatGPT
需要在应用内单独登录；测试使用临时资料目录和本地网页，避免访问真实对话。

## 项目结构

- `src/features/`：论文库、白板、阅读器、思维导图、AI 和保存协调逻辑。
- `src/data/`：共享 SQLite 接口。
- `electron/`：当前 Chromium 桌面窗口、内嵌网页和本地进程桥接。
- `src/platform/`：共享前端使用的桌面能力适配。
- `src-tauri/src/`：共享 Rust 存储、PDF 导入，以及原 Tauri 桌面壳。
- `src-tauri/migrations/`：SQLite 迁移；已有迁移保持不变，以新增迁移扩展数据结构。
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

Rust 检查：

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --all-targets --locked
```

涉及原生窗口、PDF 交互或登录的改动，还应使用 `npm run chromium:dev`
进行对应的实机验证，并在 PR 中说明未验证的部分。
`npm run chromium:test` 检查桌面边界；`npm run chromium:smoke` 使用隔离临时
资料目录和本地网页测试窗口与 PDF，不会验证真实账号登录。

不要提交登录凭据、环境密钥、私人 PDF、应用数据库或构建输出。
