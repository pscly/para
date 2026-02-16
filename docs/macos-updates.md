# macOS 自动更新（generic provider 目录结构与发布物）（Wave 8.1）

本项目桌面端（Electron）使用 `electron-updater` 实现自动更新。

关键结论：

- macOS 自动更新通常以 **`zip`** 作为更新包；`.dmg` 更适合手动安装。
- 对 generic provider：需要提供 **`latest-mac.yml` + 对应 `*.zip`（以及可选的 `*.blockmap`）**。

## 更新启用策略（默认）

主进程更新模块位于：`client/src/main/updateManager.ts`

- 仅当 `app.isPackaged === true` 才默认启用更新。
- 默认平台：Windows（`win32`）+ macOS（`darwin`）。
- 开发/测试环境默认不触发真实更新（可用 fake updater 离线验收）。

这保证：

- CI/E2E 离线稳定（不依赖真实更新源/签名）。
- 生产打包版默认启用更新（减少版本碎片化）。

## generic provider：建议目录结构

建议把不同平台放在不同目录，便于灰度与运维：

```
updates/
  windows/
    latest.yml
    Para Desktop Setup 0.0.1.exe
    Para Desktop Setup 0.0.1.exe.blockmap
  macos/
    latest-mac.yml
    Para Desktop-0.0.1-mac.zip
    Para Desktop-0.0.1-mac.zip.blockmap
    Para Desktop-0.0.1.dmg
```

说明：

- `latest-mac.yml`：electron-updater 在 macOS 侧拉取的 metadata。
- `*.zip`：用于自动更新下载与安装。
- `*.dmg`：用于手动下载安装（通常不会被自动更新使用）。
- `*.blockmap`：用于差分更新（提升下载效率），缺失也能工作但会退化为全量下载。

## feed URL 的配置方式

electron-updater 的 feed URL 有两种来源：

1) 打包时写入（推荐）

- `client/package.json` 的 `build.publish` 中配置 generic provider 的 URL。
- macOS 与 Windows 若使用不同目录，建议在各自打包任务里注入不同 URL（例如通过 `-c.publish.url=...` 或分支配置）。

2) 运行时覆盖（可选）

- 通过环境变量 `PARA_UPDATES_URL` 覆盖 feed：主进程会调用 `autoUpdater.setFeedURL({ provider: 'generic', url })`。

适用场景：

- 内网多环境（dev/stage/prod）用同一个安装包，但希望运行时指向不同更新源。

## 安全注意事项（必须看）

- 强烈建议：生产更新必须配合代码签名与 notarization（macOS）/代码签名（Windows），否则用户侧会被 Gatekeeper/SmartScreen 强烈阻拦。
- 更新源必须是可信的 HTTPS/内网静态源；避免把更新目录暴露为可被未授权写入的路径。
- `allowDowngrade` 默认关闭（本项目通过 `PARA_UPDATES_ALLOW_DOWNGRADE=1` 才会打开）。降级会扩大供应链攻击面，且可能引发本地数据不兼容。

## 验证建议（macOS runner）

建议在 macOS runner 上做两类验证：

- 打包链路：`npm -C client run package:mac` 产出 `zip`/`dmg`/`latest-mac.yml`
- 更新链路：开发/CI 仍走 fake updater（不依赖真实发布源），以保持离线稳定
