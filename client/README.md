# Para Desktop（Electron 客户端）

本目录为桌面端客户端（Electron）。

## /dev（开发者选项）开关：desired vs effective

桌面端的 `#/dev/*` 路由默认关闭并强制门控。用户在 Settings 里看到的“开发者选项（/dev）”有两个关键概念：

- `desiredEnabled`：用户意图（开关本身）。该状态会持久化到本机配置（`para.security.json`），用于“我想打开 /dev”。
- `effectiveEnabled`：实际是否生效（安全门控结果）。该状态用于“现在是否真的允许访问 /dev”。

判定逻辑（fail-closed）：

- 非 packaged（开发/测试构建）：`effectiveEnabled = desiredEnabled`。
- packaged（正式包）：只有同时满足下列条件才会生效：
  - `desiredEnabled=true`
  - 已登录（`/api/v1/auth/me` 可用且返回 200）
  - 后端返回 `debug_allowed=true`
- 任何异常都视为 `effectiveEnabled=false`：未登录、网络不可达、`/auth/me` 响应不符合 schema 等都会拒绝放行。

因此：即使用户把 desired 打开了，只要未登录或未被后端授权（`debug_allowed!=true`），`#/dev/*` 仍会被重定向到 `#/settings`。

## packaged 下如何让 /dev 生效（运维侧）

正式包的授权来自后端 `debug_allowed`。该标志只能由管理员在 `admin-web` 中管理（仅 `super_admin` 可写）：

1) 打开 `https://para.pscly.cc/admin/` 并使用 `<YOUR_ADMIN_EMAIL>` / `<YOUR_ADMIN_PASSWORD>` 登录（示例占位符）。
2) 进入 `Config -> Debug Users`。
3) 输入目标用户 email，查询后把 `debug_allowed` 切换为 `true` 并保存。

注意：客户端会严格按 `/api/v1/auth/me` 的 `debug_allowed` 字段做门控；缺失字段会被视为不合法并走拒绝路径（安全预期）。
