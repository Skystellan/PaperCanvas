# Ubuntu 20.04 兼容试用（0.2.9）

这个适配面向仍使用 ROS1、需要保留 Ubuntu 20.04 x64 桌面环境的用户。安装 PaperCanvas 不需要改动 ROS、Python 环境或替换系统 glibc。

已发布的 0.2.8 后端要求 GLIBC 2.34，Ubuntu 20.04 提供 2.31，因此旧版 DEB 和 AppImage 都不能解决这个问题。0.2.9 将 Linux 构建移至 Ubuntu 20.04，并让 Electron 后端独立于旧 Tauri/WebKit 壳编译。

## 获取和安装

从 [0.2.9 测试构建](https://github.com/Skystellan/PaperCanvas/actions/runs/36536510663) 下载 `PaperCanvas-Linux-x64` artifact 并解压，源码提交为 `227b297`。GitHub 下载 CI artifact 需要登录；这是兼容试用包，尚未发布为正式 Release。

推荐安装 DEB：

```sh
sudo apt install ./PaperCanvas-0.2.9-Linux-amd64.deb
paper-canvas
```

也可以使用 AppImage：

```sh
chmod +x PaperCanvas-0.2.9-Linux-x86_64.AppImage
./PaperCanvas-0.2.9-Linux-x86_64.AppImage
```

AppImage 使用 FUSE 2；若没有 FUSE，可使用 `APPIMAGE_EXTRACT_AND_RUN=1 ./PaperCanvas-0.2.9-Linux-x86_64.AppImage`。以普通桌面用户启动，保留 Chromium 沙箱。

## 验证范围

CI 在 Ubuntu 20.04 容器中以普通用户测试完整 Electron 应用，包括 PDF、笔记、剪贴板、内嵌聊天隔离，以及两种格式的下载校验、安装和重新启动。相同安装包继续在 Ubuntu 22.04、24.04 验证。发布检查遍历包内 ELF 文件，阻止 GLIBC 要求高于 2.31 的二进制进入产物。

本次构建的后端最高要求 `GLIBC_2.30`，Electron 主程序最高要求 `GLIBC_2.25`，包内 7 个 ELF 文件全部通过 2.31 基线检查。20.04 的 DEB 和 AppImage 均已通过桌面测试，以及拒绝损坏下载、安装、重启和数据保留测试。

| 环境 | 验证结果 |
| --- | --- |
| Ubuntu 20.04 容器 | DEB、AppImage 桌面功能及更新通过 |
| Ubuntu 22.04 托管机器 | 同包 DEB、AppImage 桌面功能及 DEB 更新通过 |
| Ubuntu 24.04 托管机器 | 同包 DEB 桌面功能及更新通过 |
| Windows x64 / macOS arm64 | 构建与桌面回归通过 |

容器验证覆盖 20.04 用户空间，但共享托管机器的内核。ROS1 用户的实体机显卡、桌面输入法和真实 ChatGPT 登录仍应试用确认。当前 Electron 的官方支持政策未覆盖 Ubuntu 20.04，这里提供项目自行验证的兼容性。

建议在反馈者机器上确认：导入论文和阅读、笔记保存后重开、内嵌 ChatGPT 登录与粘贴，以及关闭重启。反馈时提供 `lsb_release -ds`、`uname -r` 和终端报错即可，不需要发送论文或账号资料。

## 数据和更新

两种格式继续使用 `~/.config/com.papercanvas.desktop`（或 `$XDG_CONFIG_HOME/com.papercanvas.desktop`），数据库迁移内容保持不变。

应用内更新流程保留：**Help → Check for Updates… → Restart and install**。DEB 通过系统授权调用 apt，AppImage 更新用户可写入的文件。测试包不会降级安装已发布的 0.2.8；在更新的稳定版发布前，检查更新显示没有新版属于正常情况。
