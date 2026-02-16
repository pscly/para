# Windows 自动更新与回滚（Wave 7.2）

本项目桌面端（Electron）在 Windows 生产环境下使用 `electron-updater` 执行自动更新；在开发/测试环境默认不触发真实更新，并提供可离线稳定验收的 fake updater。

## 目标与边界

- 目标：在 Windows（`process.platform === 'win32'`）生产环境（`app.isPackaged === true`）默认启用自动更新；提供可观察的状态链路（check -> available -> download progress -> downloaded -> install）。
- 边界：本仓库不在 renderer 内直接下载更新包；所有更新操作由主进程负责，renderer 仅通过受信 IPC 触发并展示。

## 生产更新策略（推荐）

### 1) Provider：generic + 内网静态文件

推荐使用 `generic` provider，把 Windows 更新产物放到内网静态文件服务器（或对象存储）上。

- 在打包产物侧：`client/package.json` 的 `build.publish` 提供了 `generic` 占位配置（URL 需要按环境替换）。
- 在运行时侧：主进程读取 `PARA_UPDATES_URL`（可选）并调用 `autoUpdater.setFeedURL({ provider: 'generic', url })`。

注意：生产更新需要配合 Windows 代码签名，否则用户侧会有强烈的安装/升级阻力；签名细节不在本文件展开。

### 2) 生产默认行为

- Windows + 打包版：默认启用自动更新，并在启动后自动检查一次。
- 非 Windows：默认关闭（避免误触发）。

### 3) IPC / UI 行为

renderer 通过 `window.desktopApi.update.*` 触发：

- `getState()`：拉取当前更新状态
- `check()`：检查更新
- `download()`：下载更新
- `install()`：安装更新（真实 updater 会 `quitAndInstall()` 并重启）
- `onState(handler)`：订阅更新状态事件

所有 IPC 入口均通过主进程的 `handleTrustedIpc()` 封装，强制校验 `senderFrame.url` 在 allowlist 内。

## 回滚方案

### A. 推荐回滚（默认方案）：发布更高 patch 但回退代码

这是 Windows 自动更新最稳妥的回滚方式：版本号单调递增，不需要允许降级。

示例：

- `0.2.5` 有问题
- 直接发布 `0.2.6`，代码回到 `0.2.4` 的行为（或修复后的分支）

优点：

- 不引入“允许降级”带来的安全风险
- 用户侧行为一致（仍然是“升级”）

### B. 受控降级回滚（仅测试/紧急）：allowDowngrade

当必须将客户端降级到更低版本（例如某个发布包灾难性错误）时，可以在受控条件下打开 `allowDowngrade`。

本项目约束：默认禁止降级；只有显式设置环境变量才开启：

- `PARA_UPDATES_ALLOW_DOWNGRADE=1`

风险与注意事项：

- 这是“降级通道”，会扩大供应链攻击面（若更新源被劫持，可能诱导用户安装更低版本）。
- 降级可能造成数据格式/迁移不兼容（例如本地数据结构变化）。
- 强烈建议：仅在封闭网络/可信更新源下临时启用，并在降级完成后立刻关闭该开关。

## 开发/测试（离线稳定）策略：fake updater

为保证 E2E/CI 在离线环境稳定可重复，本项目在以下情况默认使用 fake updater：

- `NODE_ENV === 'test'`
- 或显式 `PARA_UPDATES_FAKE=1`

fake updater 行为：

- `check()` 根据 `PARA_UPDATES_FAKE_REMOTE_VERSION` 与本地“已安装版本”做比较
- `download()` 以定时器模拟下载进度
- `install()` 将“已安装版本”写入 `app.getPath('userData')/updates.fake.state.json`，用于下一次启动继续模拟

生产差异：fake updater 不会真正下载/安装包，也不涉及签名与发布源；生产仍以 `electron-updater` 为准。

## 环境变量一览

- `PARA_UPDATES_ENABLE=1`：在开发环境显式启用更新模块（默认开发关闭）
- `PARA_UPDATES_AUTO_CHECK=1`：启动后自动检查（开发默认不自动）
- `PARA_UPDATES_DISABLE_AUTO_CHECK=1`：禁用启动自动检查
- `PARA_UPDATES_URL=<url>`：生产更新源（generic provider 根 URL）
- `PARA_UPDATES_ALLOW_DOWNGRADE=1`：允许降级（默认关闭，仅测试/紧急）
- `PARA_UPDATES_FAKE=1`：强制使用 fake updater
- `PARA_UPDATES_FAKE_REMOTE_VERSION=x.y.z`：fake updater 的“远端版本”

## 运维步骤（简版）

1) 构建并产出 Windows 更新文件（NSIS + latest.yml 等）。
2) 将产物上传到内网静态文件源（URL 对应 `PARA_UPDATES_URL`）。
3) 灰度：先让少量设备更新（观察崩溃率/关键业务指标）。
4) 若需要回滚：优先发布更高 patch 的回退版本；仅在紧急情况下启用 `PARA_UPDATES_ALLOW_DOWNGRADE` 并执行降级。
