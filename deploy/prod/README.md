# para 生产 Docker Compose

目标：在 `pscly.cc` 按约定目录 `~/dockers/para/` 运行；数据持久化落在 `~/dockers/para/data/`；由外层 Nginx（`/root/dockers/nginx/`）反代到本机回环端口。

## 目录约定

建议结构（root 用户下 `~` 即 `/root`）：

```bash
mkdir -p /root/dockers/para/data
mkdir -p /root/dockers/para/data/postgres
mkdir -p /root/dockers/para/data/redis
mkdir -p /root/dockers/para/data/server/.data
```

本仓库中的生产编排文件：`deploy/prod/docker-compose.yml`。

## 启动/更新

在仓库根目录（例如 `/root/dockers/para/`）执行：

```bash
docker compose -f deploy/prod/docker-compose.yml pull
docker compose -f deploy/prod/docker-compose.yml up -d --remove-orphans
docker compose -f deploy/prod/docker-compose.yml ps
```

可选：运行迁移（只在需要时执行一次/每次升级后视情况执行）：

```bash
docker compose -f deploy/prod/docker-compose.yml --profile migrate run --rm migrate
```

可选：启用 Celery beat（默认不启用）：

```bash
docker compose -f deploy/prod/docker-compose.yml --profile beat up -d beat
```

## 端口（仅本机回环）

- API：`127.0.0.1:${API_PORT:-18080} -> api:8000`
- admin-web：`127.0.0.1:${ADMIN_WEB_PORT:-18081} -> admin-web:80`

外层 Nginx 通过反代访问这两个端口即可（本 compose 不包含 Nginx）。

## 外层 Nginx vhost（para.pscly.cc）

仓库提供 aaPanel 风格的 vhost 示例：`deploy/nginx/para.pscly.cc.conf`。

约定：

- `https://para.pscly.cc/api/*` 与 `https://para.pscly.cc/ws/*` -> `http://127.0.0.1:${API_PORT:-18080}`
- `https://para.pscly.cc/admin/*` 与 `https://para.pscly.cc/assets/*` -> `http://127.0.0.1:${ADMIN_WEB_PORT:-18081}`

说明：admin-web 生产在 `/admin/` 下反代，但 Vite 默认会从绝对路径 `/assets/*` 加载静态资源，因此 vhost 需要额外把 `/assets/` 指向 admin-web。

## 必须的环境变量（生产必配）

本 compose 不在仓库内写任何真实 secrets；生产请在服务器侧用环境变量或 `.env` 注入：

- `AUTH_ACCESS_TOKEN_SECRET`
- `ADMIN_ACCESS_TOKEN_SECRET`
- `OPENAI_MODE=openai`
- `KNOWLEDGE_EMBEDDING_PROVIDER=openai`
- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`

说明：服务端在 `ENV=prod|production` 下会做 fail-fast 校验；缺失/默认值会直接拒绝启动（预期行为）。

补充：下列配置在服务端是“复杂类型”（list/dict），建议用 JSON 形式注入，避免空字符串导致解析歧义：

- `CORS_ALLOWED_ORIGINS`：例如 `[]` 或 `["https://para.pscly.cc"]`（也兼容逗号分隔字符串）
- `TRUSTED_HOSTS`：例如 `[]` 或 `["para.pscly.cc"]`（也兼容逗号分隔字符串）
- `PARA_APPENC_KEYS`：例如 `{}` 或 `{"kid":"<base64url_32bytes>"}`（也兼容 `kid:base64url_key,kid2:...` 形式）

## 数据持久化（重要）

server 侧文件写盘路径在代码中硬编码为 `server_root/.data/<module>`；生产容器内固定 `WORKDIR=/app`，因此持久化卷必须挂载到：

- 容器内：`/app/.data`
- 宿主机：`/root/dockers/para/data/server/.data`

数据库中会保存这些文件的绝对路径；保持容器内根路径稳定（`/app`）有利于未来迁移。
