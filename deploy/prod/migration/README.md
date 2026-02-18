# 迁移演练（staging）

目标：提供一套可重复、可审计、且仓库不落任何敏感信息的 dry-run 工具链，用于把旧系统的 DB + 文件资产复制到新的 staging 环境，验证一致性，并执行基础 smoke 检查。

本目录包含：

- `deploy/prod/migration/dry_run.sh`：入口脚本（`--help` / `--dry-run`）
- `deploy/prod/migration/validate_db.py`：数据库校验（rowcount + orphan checks）
- `deploy/prod/migration/validate_assets.py`：资产校验（抽样可读性 + 路径前缀约束）


安全护栏：

- 真实 DSN/密码/内网 IP/真实主机名必须只保存在环境变量或服务器侧的 `.env` 中。禁止写入仓库。
- 脚本输出会对 DSN 密码做脱敏。
- 本 dry-run 仅用于 staging。不要为此改动生产的 `deploy/prod/docker-compose.yml`。

---

## 清单

生产机常见宿主路径：

- Postgres 数据：`/root/dockers/para/data/postgres`
- 服务端资产：`/root/dockers/para/data/server/.data`
- Redis 数据（可选）：`/root/dockers/para/data/redis`

容器挂载约定：

- DB: `/var/lib/postgresql/data`
- Assets: `/app/.data`

是否需要迁移 Redis？

- 通常不需要。队列/缓存可重建，迁移 Redis 可能把过期/无效状态一并带过去。
- 只有在你明确把关键状态持久化在 Redis，且已评估“行为漂移”风险时才考虑迁移。

---

## 资产路径约定（重要）

服务端会把容器内的绝对路径写入数据库。生产环境容器根路径稳定（`WORKDIR=/app`），所以通常会看到：

- `knowledge_materials.storage_path`: `/app/.data/knowledge/<id>/...`
- `ugc_assets.storage_path`: `/app/.data/ugc/<id>/...`
- `gallery_items.storage_dir`: `/app/.data/gallery/<id>/`

在 staging 演练中，也要通过把宿主 `.data` 目录挂载到 `/app/.data` 来保持容器侧前缀一致。若改变容器侧前缀，DB 中路径会漂移，文件读取将失败。

---

## 前置条件

- 依赖命令：`bash`, `python3`, `psql`, `pg_dump`, `pg_restore`, `rsync`, `curl`
- 目标 staging Postgres 必须安装 `pgvector`（扩展名 `vector`）

关于 `pg_dump` / `pg_restore` 的实用说明：

- 优先选择 dump 格式：`custom` 或 `directory`（更利于选择性恢复/并行）。
- 推荐 flags：`--no-owner --no-acl`。
- `pg_dump` 默认会产出一致性快照；如需并行 dump，使用 `directory + --jobs`（使用同步快照）。
- `pg_restore --single-transaction` 提供 all-or-nothing 语义，但与 `pg_restore --jobs` 互斥。
- 可选：`pg_dump --serializable-deferrable` 可提供更强隔离，但可能会阻塞等待“安全快照”。

---

## DSN 格式：这里不要使用 `postgresql+psycopg://`

dry-run 脚本会调用 libpq 工具（`psql`, `pg_dump`, `pg_restore`）。这些工具不理解 SQLAlchemy 的驱动 scheme（例如 `postgresql+psycopg://`）。

请使用以下任一格式：

- URL DSN：`postgresql://<user>:<password>@<host>:<port>/<db>`
- libpq keyword DSN：`host=<host> port=<port> dbname=<db> user=<user> password=<password>`

如果你手头只有类似 `postgresql+psycopg://...` 的 SQLAlchemy URL，把 `+psycopg` 这段去掉即可：`postgresql://...`。

---

## 环境变量与参数（仓库不落敏感信息）

入口脚本：`bash deploy/prod/migration/dry_run.sh ...`

必需：

- `DST_DATABASE_URL`: 目标 staging Postgres DSN（libpq 格式；用于 restore + 校验）
- `DST_ASSETS_DIR`: 目标 staging `.data` 根目录（宿主路径或容器路径 `/app/.data`）

建议（用于 src/dst 对比与导出）：

- `SRC_DATABASE_URL`: 源 Postgres DSN（libpq 格式；用于 dump 与行数对比）
- `SRC_ASSETS_DIR`: 源 `.data` 根目录（rsync 源；可使用 rsync 远端语法）

Dump 输入（二选一）：

- `SRC_DB_DUMP_PATH`: 已存在 dump 的路径（custom: 文件；directory: 目录）
- 或提供 `SRC_DATABASE_URL` 让脚本自行创建 dump

校验参数：

- `VALIDATE_TABLES`: 逗号分隔的表清单（覆盖默认值）
- `ROWCOUNT_TIMEOUT_MS`: `count(*)` 超时（默认 3000ms；超时则回退为估算）
- `ROWCOUNT_MAX_DIFF`: 允许的最大行数差（默认 0；仅允许 exact/exact）
- `ROWCOUNT_REQUIRE_EXACT=1`: 要求所有表必须返回精确行数（否则失败）
- `ASSETS_SAMPLE_N`: 抽样检查的资产数量（默认 50）
- `ASSETS_DB_PATH_PREFIX`: 强制 DB 路径前缀（默认 `/app/.data`）

危险开关（仅 staging）：

- `DST_DROP_SCHEMA=1`: restore 前 drop+recreate `public` schema
- `ASSETS_DELETE=1`: 资产镜像时为 rsync 增加 `--delete`

Smoke：

- `STAGING_API_BASE_URL` 或 `STAGING_API_PORT`（默认 base 为 `http://127.0.0.1:18080`）

---

## 执行

1) 计划模式（打印将要执行的命令；不写入）：

```bash
bash deploy/prod/migration/dry_run.sh --dry-run
```

2) 执行模式（dump/restore/rsync/validate/smoke）：

```bash
bash deploy/prod/migration/dry_run.sh
```

3) 输出与退出码：

- 任一失败都会返回非 0（行数差异、孤儿检查、资产缺失/不可读、health 不通过等）。
- dump 与临时工作文件默认放在临时工作目录下（见 `WORK_DIR` 输出）。如需可审计性，可将 `WORK_DIR` 设为固定路径。

---

## 生产切换

生产迁移与切换手册：

- `deploy/prod/migration/PROD_CUTOVER_RUNBOOK.md`
- `deploy/prod/migration/cutover.sh`

---

## 本地 dry-run 依赖（可选）

仓库提供 `deploy/prod/docker-compose.dryrun.yml`，用于在本机启动隔离的 staging 依赖（带 pgvector 的 Postgres + Redis）以便演练。

特性：

- 不占用默认本地端口 `5432/6379`。
- 使用项目作用域的 named volumes（不会写入 `/root/dockers/para/...`）。
- 端口可通过环境变量覆盖：`DRYRUN_POSTGRES_PORT` / `DRYRUN_REDIS_PORT`。

```bash
export DRYRUN_POSTGRES_PORT=55432
export DRYRUN_REDIS_PORT=56379

docker compose -f deploy/prod/docker-compose.dryrun.yml up -d
docker compose -f deploy/prod/docker-compose.dryrun.yml ps
```

将迁移 dry-run 指向这些依赖（仅占位值；禁止提交真实凭据）：

```bash
# Postgres (target staging). If you override user/password/db in the dryrun compose, adjust here too.
export DST_DATABASE_URL="postgresql://<user>:<password>@127.0.0.1:${DRYRUN_POSTGRES_PORT:-55432}/<db>"

# Redis (Celery broker / WS redis)
export CELERY_BROKER_URL="redis://127.0.0.1:${DRYRUN_REDIS_PORT:-56379}/0"
export WS_REDIS_URL="redis://127.0.0.1:${DRYRUN_REDIS_PORT:-56379}/0"
```

清理（会移除演练 volumes；确认不再需要后再执行）：

```bash
docker compose -f deploy/prod/docker-compose.dryrun.yml down -v
```
