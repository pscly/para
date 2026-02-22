# Para Runbook（本地可重复跑通基线）

目标：建立一份“可复制粘贴、可重复跑通”的本地开发与生产运维基线 Runbook。

约束：本文档不记录任何敏感信息（API Key/密码/内网 IP 等）；需要的密钥与连接串只通过环境变量或服务器侧 `.env` 管理。

## 权威 QA 脚本（不要自创替代流程）

本仓库的验收脚本以以下 3 个为准：

- `./scripts/ci.sh`
- `./scripts/qa_alpha.sh`
- `./scripts/qa_beta.sh`

## 本地开发（Local Dev）

### 0) 先决条件

- 已安装：Docker + Docker Compose
- 已安装：Python + `uv`
- 已安装：Node.js + npm（用于 `client/` 的测试与 E2E）

说明：本仓库根目录的 `make dev-up` 会优先使用 `.env`；若不存在则回退到 `.env.example`。

### 1) 启动本地依赖（Postgres(pgvector) + Redis）

在仓库根目录执行：

```bash
make dev-up
```

这一步只负责拉起本地依赖容器（见 `docker-compose.yml`），不启动应用服务进程。

### 2) 迁移数据库（Alembic）

```bash
cd server && uv run alembic upgrade head
```

提示：服务端数据库连接优先读 `DATABASE_URL`；否则会基于 `POSTGRES_*` 环境变量拼接连接信息。

### 3) 启动 API（Uvicorn，多 worker）

```bash
cd server && uv run uvicorn app.main:app --workers 2
```

默认情况下 Uvicorn 会监听 `127.0.0.1:8000`。如需对局域网暴露，请自行追加 `--host 0.0.0.0 --port <port>`（生产不建议直接暴露，优先通过 Nginx 反代同源）。

### 4) 启动 Worker（Celery，单并发）

新开一个终端窗口：

```bash
cd server && uv run celery -A app.workers.celery_app:celery_app worker -l INFO -c 1
```

### 5) 最小 Smoke Checklist（可稍后执行）

目标：快速确认“依赖容器 + API + pgvector + worker”链路都可用。

```bash
# 1) 依赖容器是否健康
docker compose ps

# 2) 服务健康检查（返回 ok/degraded + db/redis/pgvector/worker 细分状态）
curl -fsS http://127.0.0.1:8000/api/v1/health
```

说明：健康检查路径为 `/api/v1/health`，其中 `pgvector` 会检测数据库是否已启用 `vector` 扩展。

### 6) 本地一键验收（只跑脚本，不要手搓步骤）

```bash
./scripts/ci.sh
```

### 7) 停止/清理

```bash
# 停止容器（保留卷）
make dev-down

# 停止容器并清理卷（会清空本地 Postgres/Redis 数据）
make dev-reset
```

## 生产运维基线（Production Ops Baseline）

### 约定与目录

生产侧约定（来自运维约束）：

- Docker Compose 部署目录统一放在：`~/dockers/`
- Nginx Docker 配置文件路径：`/root/dockers/nginx/conf.d/default.conf`（修改后需要重启 Nginx）
- 数据持久化目录约定：`~/dockers/<project>/data`

注意：生产环境的 `.env` 只在服务器侧维护，禁止在 CI 或仓库内生成/覆盖，更不要提交到 Git。

### 常用运维命令（可复制粘贴）

进入项目部署目录（示例以 `<project>` 占位）：

```bash
cd ~/dockers/<project>

# 查看容器状态
docker compose ps

# 拉取镜像并滚动启动（幂等）
docker compose pull
docker compose up -d --remove-orphans

# 查看日志（按需调整 --tail）
docker compose logs -f --tail=200
```

### Nginx 配置变更流程（基线）

```bash
# 编辑 Nginx 配置（路径固定）
vim /root/dockers/nginx/conf.d/default.conf

# 重启 Nginx（以 docker compose 管理为准）
cd ~/dockers/nginx
docker compose restart
```

### 生产侧最小 Smoke Checklist（可稍后执行）

```bash
# 1) 容器是否都在跑
cd ~/dockers/<project>
docker compose ps

# 2) 服务健康检查（按你的对外入口替换 <base_url>）
curl -fsS <base_url>/api/v1/health
```

## AppEnc（应用层加密，AES-256-GCM）

AppEnc 是服务端的 ASGI middleware：仅当请求头带 `X-Para-Enc: v1` 时才会进入解密流程。

### 范围与限制（保持现状，不扩展）

- 仅覆盖 `Content-Type: application/json` 且 **非空** body 的请求。
- 不对 GET/空 body “自动加密”。客户端应避免对这类请求发送 `X-Para-Enc: v1`。
- 响应加密仅在请求头额外带 `X-Para-Enc-Resp: v1` 且响应为 `application/json`（并且不是 streaming/multi-chunk body）时生效。

当 `X-Para-Enc: v1` 存在但不满足条件或 envelope 非法时，服务端会返回稳定的明文 JSON 错误码（fail-closed），例如：

- `PARA_APPENC_UNSUPPORTED_CONTENT_TYPE`
- `PARA_APPENC_EMPTY_BODY`
- `PARA_APPENC_BAD_ENVELOPE`
- `PARA_APPENC_UNKNOWN_KID`
- `PARA_APPENC_DECRYPT_FAILED`

### 启用方式（仅走 env / 服务器 .env，不入库不入仓）

以下环境变量仅给出占位符示例（严禁把真实 key 写入仓库/日志）：

```bash
# 是否启用 AppEnc middleware
PARA_APPENC_ENABLED=1

# keyring：kid -> base64url(32 bytes)
# 支持两种注入方式：
# 1) JSON：{"k1":"<base64url_32bytes>","k2":"<base64url_32bytes>"}
# 2) 逗号分隔：k1:<base64url_32bytes>,k2:<base64url_32bytes>
PARA_APPENC_KEYS='k1:<base64url_32bytes>,k2:<base64url_32bytes>'

# 时间窗（秒），用于 ts 校验与最小防重放窗口
PARA_APPENC_TS_WINDOW_SEC=120
```

说明：服务端会将 keyring 的第一个 `kid` 视为 primary（用于响应加密输出）。

### 最小验证（无需任何密钥/凭据）

构造一个“标记为加密但 envelope 非法”的请求，预期返回 `400` + `PARA_APPENC_BAD_ENVELOPE`：

```bash
curl -sS -i -X POST https://para.pscly.cc/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -H 'X-Para-Enc: v1' \
  --data '{"hello":"world"}'
```

该验证的意义：证明 middleware 已启用且对非法输入走 fail-closed，不会把请求落到业务 handler。

### 本地算法闭环（pytest 已覆盖）

如果需要验证“正确加密请求 + 正确解密响应”的端到端闭环（涉及真实 envelope/AAD/AES-GCM），仓库已提供 pytest 覆盖：`server/tests/test_task_19_appenc_login.py`。

```bash
cd server && uv run pytest -q tests/test_task_19_appenc_login.py
```

## 故障排查（最小集合）

- `/api/v1/health` 返回 `degraded`：优先看 `dependencies` 里哪一项是 `error`（db/redis/pgvector/worker）。
- 依赖未就绪：先跑 `docker compose ps` 确认容器健康，再看 `docker compose logs -f --tail=200 <service>`。
- Worker 不可达：确认 Celery worker 进程在跑、并且服务端与 worker 指向同一套 Redis（`CELERY_BROKER_URL`/`CELERY_RESULT_BACKEND`）。
