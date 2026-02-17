# 迁移演练（dry-run）

目标：提供一套“可重复、可审计、无 secrets 入库”的迁移演练工具链，用于把旧环境数据/资产复制到新环境（staging），并做一致性校验与 smoke。

本目录文件：

- `deploy/prod/migration/dry_run.sh`：入口脚本（支持 `--help`/`--dry-run`）
- `deploy/prod/migration/validate_db.py`：DB 一致性校验（行数对比 + 孤儿检测）
- `deploy/prod/migration/validate_assets.py`：资产一致性校验（抽样存在性/可读性 + 路径前缀约束）

约束（安全底线）：

- 任何真实 DSN/密码/内网 IP/真实主机名都只能通过环境变量或服务器侧 `.env` 注入；本目录不会把这些信息写进仓库。
- 脚本输出会对 DSN 做脱敏（不打印密码）。
- 本演练只建议用于 staging；不要修改生产 `deploy/prod/docker-compose.yml`。

---

## Inventory（必须明确）

生产环境（宿主机）常见持久化目录：

- Postgres data：`/root/dockers/para/data/postgres`
- Server assets：`/root/dockers/para/data/server/.data`
- Redis data（可选迁移）：`/root/dockers/para/data/redis`

容器内映射约定：

- DB：`/var/lib/postgresql/data`
- Assets：`/app/.data`

Redis 是否迁移：

- 建议：大多数情况下不需要迁移 Redis（队列/缓存可重建），迁移反而可能把过期/无效数据带过去。
- 例外：如果你明确依赖 Redis 持久化的业务状态（例如长 TTL 的会话、关键的幂等键），才考虑迁移，并要评估“携带旧缓存导致的行为漂移”。

---

## Assets 路径约定（重要）

服务端写盘目录在代码中硬编码为 `server_root/.data/<module>`（例如 `knowledge/ugc/gallery`）。生产容器内固定 `WORKDIR=/app`，因此 DB 中常见的绝对路径形如：

- `knowledge_materials.storage_path`：`/app/.data/knowledge/<id>/...`
- `ugc_assets.storage_path`：`/app/.data/ugc/<id>/...`
- `gallery_items.storage_dir`：`/app/.data/gallery/<id>/`

迁移演练时建议 staging 也保持同样的容器内路径（把宿主机 `.data` 挂载到容器内 `/app/.data`），否则 DB 路径映射会漂移。

---

## 前置条件

- 命令：`bash`、`python3`、`psql`、`pg_dump`、`pg_restore`、`rsync`、`curl`
- staging 目标 Postgres 必须安装 `pgvector`（扩展名 `vector`）

关于 `pg_dump/pg_restore` 的实践要点：

- 推荐 dump 格式：`custom` 或 `directory`（便于 `pg_restore` 选择性恢复/并行）
- 推荐 flags：`--no-owner --no-acl`
- `pg_dump` 默认使用一致性快照；`directory + --jobs` 并行 dump 也会通过 synchronized snapshots 保持一致性（不需要也不支持 `--single-transaction`）。
- `pg_restore --single-transaction` 可提供“要么全部成功要么全部失败”的恢复，但与 `pg_restore --jobs` 互斥。
- 可选：如需更严格的一致性隔离，可考虑 `pg_dump --serializable-deferrable`（不建议默认启用，可能等待安全快照而阻塞）。

---

## 环境变量与参数（无 secrets 入库）

入口脚本：`bash deploy/prod/migration/dry_run.sh ...`

必须：

- `DST_DATABASE_URL`：目标 staging Postgres DSN（restore + 校验使用）
- `DST_ASSETS_DIR`：目标 staging 的 `.data` 根目录（宿主机目录或容器内 `/app/.data`）

推荐（做源/目标对比与导出）：

- `SRC_DATABASE_URL`：源 Postgres DSN（用于 dump 与 rowcount 对比）
- `SRC_ASSETS_DIR`：源 `.data` 根目录（rsync 来源；可为远端 rsync 格式）

dump 输入（二选一）：

- `SRC_DB_DUMP_PATH`：已有 dump（custom 为文件；directory 为目录）
- 或提供 `SRC_DATABASE_URL` 由脚本生成 dump

校验可调：

- `VALIDATE_TABLES`：逗号分隔关键表清单（覆盖默认）
- `ROWCOUNT_TIMEOUT_MS`：`count(*)` 超时（默认 3000ms；超时会回退估算）
- `ROWCOUNT_MAX_DIFF`：行数差异容忍阈值（默认 0；只对 exact/exact 生效）
- `ROWCOUNT_REQUIRE_EXACT=1`：强制所有关键表必须能跑 exact count（否则失败）
- `ASSETS_SAMPLE_N`：资产抽样条数（默认 50）
- `ASSETS_DB_PATH_PREFIX`：资产路径前缀约束（默认 `/app/.data`；建议保持不变）

危险开关（仅 staging）：

- `DST_DROP_SCHEMA=1`：restore 前先 drop+recreate public schema
- `ASSETS_DELETE=1`：rsync 时加 `--delete` 让目标资产与源一致

smoke：

- `STAGING_API_BASE_URL` 或 `STAGING_API_PORT`（默认 `http://127.0.0.1:18080`）

---

## 执行流程（可审计、可重复）

1) 计划模式（只打印，不执行任何写操作）：

```bash
bash deploy/prod/migration/dry_run.sh --dry-run
```

2) 执行模式（dump/restore/rsync/校验/smoke）：

```bash
bash deploy/prod/migration/dry_run.sh
```

3) 产物与退出码：

- 任一步失败会返回非 0（rowcount 差异、孤儿检查非 0、资产缺失/不可读、smoke 非 ok）
- dump 默认写到临时工作目录（见 `WORK_DIR` 输出；可通过 `WORK_DIR` 固定路径，便于审计/留存）

---

## 本机 staging（可选）

仓库内提供 `deploy/prod/docker-compose.dryrun.yml` 用于在本机起一套**隔离**的 staging 依赖（Postgres(pgvector) + Redis），只用于演练。

特性：

- 默认不占用 `5432/6379`（避免与本机已有依赖冲突）
- 仅使用项目内 named volumes（不会写到 `/root/dockers/para/...`）
- 端口可用环境变量覆盖：`DRYRUN_POSTGRES_PORT` / `DRYRUN_REDIS_PORT`

```bash
# 可选：覆盖端口（默认 55432/56379）
export DRYRUN_POSTGRES_PORT=55432
export DRYRUN_REDIS_PORT=56379

docker compose -f deploy/prod/docker-compose.dryrun.yml up -d
docker compose -f deploy/prod/docker-compose.dryrun.yml ps
```

把迁移脚本/服务端指向这套 dryrun deps（示例只用占位符 + localhost，不包含任何真实凭据）：

```bash
# Postgres（目标 staging）
# 如果你覆盖了 DRYRUN_POSTGRES_USER/DRYRUN_POSTGRES_PASSWORD/DRYRUN_POSTGRES_DB，请同步调整这里。
export DST_DATABASE_URL="postgresql+psycopg://<user>:<password>@127.0.0.1:${DRYRUN_POSTGRES_PORT:-55432}/<db>"

# Redis（Celery broker / WS redis）
export CELERY_BROKER_URL="redis://127.0.0.1:${DRYRUN_REDIS_PORT:-56379}/0"
export WS_REDIS_URL="redis://127.0.0.1:${DRYRUN_REDIS_PORT:-56379}/0"
```

清理（会删除演练用数据卷，确认不需要再执行）：

```bash
docker compose -f deploy/prod/docker-compose.dryrun.yml down -v
```
