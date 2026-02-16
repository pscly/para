# macOS 打包 / 签名 / 公证（notarization）（Wave 8.1）

本项目桌面端（Electron）使用 `electron-builder` 打包。macOS 发行版建议走 **Developer ID 签名 + notarization**（非 Mac App Store 发行）。

约束与原则：

- 本仓库不提交任何证书/凭据；签名与公证 **完全通过 CI secrets/env 注入**。
- Linux 环境不要求实际执行 notarization；但 CI（macOS runner）线路要可用。

## 产物与目标

- 手动安装：`.dmg`
- 自动更新（electron-updater）：`.zip` + `latest-mac.yml`

仓库已配置：

- `client/package.json`：mac target `dmg` + `zip`，并启用 `hardenedRuntime`。
- `client/build/entitlements.mac.plist` / `client/build/entitlements.mac.inherit.plist`：最小占位 entitlements。
- `.github/workflows/macos-build.yml`：macOS CI 构建并上传 `client/dist-electron/**`；签名/公证在 secrets 存在时自动启用。

## 本地构建（macOS）

在 macOS 机器上：

```bash
npm -C client ci
npm -C client run package:mac
```

产物输出目录：`client/dist-electron/`。

说明：

- 未配置签名时：electron-builder 会生成未签名产物（Gatekeeper 可能拦截）。
- 配置了签名与 notarization 时：electron-builder 会在打包阶段完成签名，并在可用凭据下执行 notarization（使用 `notarytool`），成功后会 stapling 票据。

## CI（GitHub Actions）构建

Workflow：`/.github/workflows/macos-build.yml`

它会：

1) 安装 `client` 依赖
2) 运行 `npm -C client run package:mac`
3) 上传 `client/dist-electron/**` 为 artifacts

### 可选：代码签名（仅当 secrets 存在时启用）

electron-builder 的 macOS 签名遵循环境变量：

- `CSC_LINK`（必需）：证书来源（常见做法：base64 的 `.p12`，或可下载 URL）
- `CSC_KEY_PASSWORD`（可选）：证书密码

未提供 `CSC_LINK` 时，workflow 会设置：

- `CSC_IDENTITY_AUTO_DISCOVERY=false`

用意：避免 macOS runner 因为 keychain 中没有可用 identity 而让 electron-builder 报错。

### 可选：notarization（仅当 secrets 存在时启用）

electron-builder 内置 notarization（通过 `@electron/notarize` 调用 `xcrun notarytool`）。

支持两种凭据方式（任选其一）：

1) Apple ID（适合个人账号/小团队）

- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

2) App Store Connect API Key（更推荐用于 CI）

- `APPLE_API_KEY`（.p8 内容，通常以 base64 存放）
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

注意：

- notarization 通常要求应用先完成 Developer ID 签名，因此 workflow 里把 notarization 条件与 `CSC_LINK` 绑定。
- notarization 需要 Xcode Command Line Tools（GitHub 的 macOS runner 默认具备）。

## entitlements 说明（最小占位）

当前仓库提供了两个 entitlements 文件：

- `client/build/entitlements.mac.plist`
- `client/build/entitlements.mac.inherit.plist`

它们包含 Electron 常见的 hardened runtime 兼容项（例如 JIT 相关）。

风险提示：entitlements 过宽会扩大攻击面；后续如果你准备上生产分发，建议按功能收敛并在 macOS 上做完整签名/运行验证。

## 常见问题（排障线索）

- 签名失败：确认 `CSC_LINK` 是合法证书，并且密码正确；检查证书是否为 `Developer ID Application`。
- notarization 被跳过：通常是因为未提供 `APPLE_*` secrets（CI 条件未满足），或未提供 `CSC_LINK`。
- notarization 失败：查看 CI 日志里 `notarytool` 输出；必要时在 macOS 复现并用 `xcrun notarytool log <id>` 拉取更详细诊断。
