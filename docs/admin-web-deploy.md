# 5.3 admin-web 部署（独立 Nginx/静态站）与 server 安全配置

目标：让 `admin-web/` 可以作为“独立静态站点”部署，同时服务端启用可测试的 CORS/TrustedHost/安全头加固；仅允许受信 origin；避免 token 落日志。

## 1) 构建 admin-web

在仓库根目录执行：

```bash
npm -C admin-web install
npm -C admin-web run build
```

默认产物在：`admin-web/dist/`。

## 2) Nginx 静态站点（SPA）示例

参考示例配置：`deploy/nginx/admin-web.conf`。

关键点：
- SPA fallback：`try_files $uri $uri/ /index.html`
- 安全头（边界兜底）：`X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy` / `Permissions-Policy`

### 方案 A（推荐）：admin-web 与 API 同源

做法：同一个 Nginx `server {}` 托管静态文件，并反代后端：
- `/api/*` -> 后端 HTTP（例如 `127.0.0.1:8000`）
- `/ws/*` -> 后端 WS（`proxy_set_header Upgrade/Connection`）

优点：
- 浏览器同源调用 API/WS，几乎不需要 CORS（后端 `CORS_ALLOWED_ORIGINS` 可以保持为空）。

### 方案 B：admin-web 与 API 分离域名

示例：
- admin-web：`https://admin.example`
- API：`https://api.example`

此时浏览器跨域请求 API，必须在 server 配置 CORS allowlist（只允许受信的 admin-web origin）。

## 3) server 侧配置：CORS / TrustedHost / 安全头

### 3.1 CORS（仅 allowlist origin 返回 Access-Control-Allow-Origin）

Settings 字段：
- `CORS_ALLOWED_ORIGINS` -> `Settings.cors_allowed_origins: list[str]`

行为：
- 空列表：不启用 CORS（适合本地开发、同源反代场景）
- 非空：仅 allowlist 中的 Origin 才会获得 `Access-Control-Allow-Origin`；
  - 普通请求：非受信 Origin 仍会返回业务响应，但不会带 CORS 放行头
  - 预检 OPTIONS：非受信 Origin 直接返回 400

配置格式支持两种（等价）：

```bash
# 逗号分隔
export CORS_ALLOWED_ORIGINS="https://admin.example,https://admin2.example"

# JSON 数组
export CORS_ALLOWED_ORIGINS='["https://admin.example","https://admin2.example"]'
```

### 3.2 TrustedHost（仅 allowlist host 允许访问）

Settings 字段：
- `TRUSTED_HOSTS` -> `Settings.trusted_hosts: list[str]`

行为：
- 空列表：不启用 TrustedHost（默认不会把本地开发锁死）
- 非空：Host 不在 allowlist 则直接 400

示例：

```bash
export TRUSTED_HOSTS="api.example,admin.example"
```

说明：
- 方案 A（同源）：通常只需要配置对外域名（例如 `admin.example`），因为 Nginx 会把原始 Host 透传给后端。
- 方案 B（分离域名）：在 API 进程上配置 `api.example`（以及你实际会访问的域名）。

### 3.3 安全头

server 侧会对 HTTP 响应统一添加：
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), usb=()`

建议：
- 保持 Nginx 与 server 同时加安全头（多一层边界兜底）；
- 若后续引入更严格的 `Content-Security-Policy`，优先在 Nginx 做灰度与按路径分流。

## 4) Token 不落日志（运维注意事项）

本项目 server 侧日志 formatter 已对 `Authorization: Bearer ...` 与 `access_token/refresh_token` 做脱敏（见 `server/app/core/logging.py`）。

仍建议在部署侧确保：
- Nginx 的 `log_format` 不要包含 `$http_authorization`；
- 不要开启会记录请求头的 debug 日志（除非在隔离环境、且确认会脱敏）。
