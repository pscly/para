# Windows 打包（electron-builder）与可选代码签名

本文档说明如何在 Windows 上打包 Electron 客户端（NSIS 安装包 / unpacked 目录），以及如何在提供证书时启用代码签名。

## 本机打包（Windows）

在 Windows 机器上执行：

```bash
npm -C client ci
npm -C client run package:win
```

如需生成 unpacked 目录（便于 smoke/排查）：

```bash
npm -C client run package:win:dir
```

产物目录：

- `client/dist-electron/`（electron-builder `directories.output`）
- 常见子目录：`win-unpacked/`、`*.exe`（NSIS 安装包）

## 可选代码签名

项目使用 electron-builder 的默认签名机制：

- 当环境变量 `CSC_LINK` 存在时，electron-builder 会尝试使用其指向的证书进行签名。
- 若同时需要密码，则提供 `CSC_KEY_PASSWORD`。

未提供证书时：不会签名，但打包仍应成功。

### GitHub Actions secrets

在仓库 Secrets 中配置（可选）：

- `CSC_LINK`：证书来源（常见为 base64 编码的 `.p12/.pfx`，或可下载的 URL）
- `CSC_KEY_PASSWORD`：证书密码（如有）

Workflow：`.github/workflows/windows-build.yml` 会在 `CSC_LINK` 存在时才注入签名环境变量。

## 相关配置位置

- 打包配置：`client/package.json` 的 `build` 字段
  - `appId`: `com.pscly.para`
  - `productName`: `Para Desktop`
  - `win.target`: `nsis` + `dir`
  - `nsis`: `oneClick=false`、`allowToChangeInstallationDirectory=true`
