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

## 故障排查（最小集合）

- `/api/v1/health` 返回 `degraded`：优先看 `dependencies` 里哪一项是 `error`（db/redis/pgvector/worker）。
- 依赖未就绪：先跑 `docker compose ps` 确认容器健康，再看 `docker compose logs -f --tail=200 <service>`。
- Worker 不可达：确认 Celery worker 进程在跑、并且服务端与 worker 指向同一套 Redis（`CELERY_BROKER_URL`/`CELERY_RESULT_BACKEND`）。
