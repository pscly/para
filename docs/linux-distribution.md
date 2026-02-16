# Linux 分发策略（AppImage / deb / rpm）

本文描述 Para Desktop（Electron）在 Linux 下的分发策略与可运行的 CI 打包链路。

## 目标与产物

我们使用 `electron-builder` 在 Linux 上同时产出以下目标（默认架构为 runner 的 `x64`）：

- `AppImage`：跨发行版的单文件分发包（下载即可运行）。
- `deb`：面向 Debian/Ubuntu 体系的安装包。
- `rpm`：面向 Fedora/RHEL/openSUSE 等体系的安装包。
- `dir`：解包目录（调试/排障用，类似“便携版”目录）。

产物统一输出到：`client/dist-electron/`

## 选型对比（优缺点与适用场景）

### AppImage

优点：

- 单文件分发，用户侧最简单；对发行版差异不敏感。
- 适合内测/灰度：可直接下载覆盖、便于回滚。

缺点：

- 与系统包管理器集成较弱（卸载/依赖/权限策略不如 deb/rpm）。
- 某些环境运行 AppImage 需要 FUSE2 兼容库（常见为 `libfuse2` 或 Ubuntu 24.04 的 `libfuse2t64`）。

适用：跨发行版下载分发、测试环境、内测用户。

### deb

优点：

- 与 Debian/Ubuntu 的包管理生态集成（安装/卸载/版本管理更规范）。
- 适合面向 Ubuntu 的企业内网分发与运维托管。

缺点：

- 发行版/版本差异带来兼容性成本（依赖、桌面集成细节）。

适用：Ubuntu/Debian 用户为主的分发场景。

### rpm

优点：

- 与 Fedora/RHEL/openSUSE 的包管理生态集成。

缺点：

- 在 Ubuntu runner 上生成 rpm 时通常需要额外安装 rpm 工具链（见下文依赖）。

适用：Fedora/RHEL/openSUSE 用户为主的分发场景。

## 本地构建（Ubuntu）

在仓库根目录执行：

```bash
npm -C client ci
npm -C client run package:linux:dist
```

仅生成调试目录（`dir`）时：

```bash
npm -C client run package:linux
```

## 依赖与常见坑

### Ubuntu 上构建 rpm / AppImage 的依赖

在 Ubuntu 上生成 rpm/AppImage 时，通常需要：

- `rpm`：生成 `.rpm` 需要。
- `fakeroot`：生成 deb/rpm 时常用（让打包过程以“伪 root”写入元数据）。
- `libfuse2` 或 `libfuse2t64`：用于运行 `appimagetool`（其本身常以 AppImage 形式分发）。

示例安装命令：

```bash
sudo apt-get update
sudo apt-get install -y rpm fakeroot
sudo apt-get install -y libfuse2 || sudo apt-get install -y libfuse2t64
```

### 自动更新说明

当前 Linux 仅落地“可分发包”的产出链路；自动更新策略保持现状（默认仍可保持关闭）。
若未来要对 Linux 启用自动更新（例如配合自建更新源/包仓库），建议单独做一轮设计与验收。

## CI（GitHub Actions）

Linux 打包 CI：`.github/workflows/linux-build.yml`

- `npm ci` 安装依赖
- `npm -C client run package:linux:dist` 产出 AppImage/deb/rpm/dir
- 上传 `client/dist-electron/**` 为 workflow artifacts
