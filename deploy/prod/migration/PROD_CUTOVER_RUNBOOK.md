# 生产切换运行手册（task-17）

本文档从高层描述生产迁移与切换（cutover）流程。
它刻意不包含任何真实 DSN、IP、主机名、token 或 secret。

可执行辅助脚本：

- `deploy/prod/migration/cutover.sh`

证据目录约定（服务器侧）：

- `/root/dockers/para/backups/evidence/task-17/<timestamp>/`

## 概览（高层）

切换序列设计目标是“可审计、可重复”：

1) 冻结（停止写入）
2) 基线备份（采集“切换前”状态）
3) 恢复资产 + 恢复 DB（DESTRUCTIVE）
4) 迁移 schema/data（运行 migrations）
5) 拉起服务
6) 健康检查
7) 核心 smoke（交互式）

辅助脚本默认仅计划模式（不写入），除非显式传入 `--run`。

## 明确放行（必需）

在执行任何破坏性 restore 步骤前，必须获得明确放行。

破坏性步骤：

- `--restore-assets`（替换磁盘上的资产；会先把当前资产移到旁边）
- `--restore-db`（通过 `pg_restore --clean --if-exists` 恢复 dump）

这些步骤必须带上 `--i-know-what-im-doing` 才会执行。

## 前置条件

- 你已在生产服务器上操作（辅助脚本不会通过 SSH 登录/执行）。
- 源制品（DB dump 与 assets tarball）已放置在服务器上。
- 生产 `.env` 已存在于 `/root/dockers/para/.env`（或通过 `--env-file` 指定）。
- 应用根目录已存在于 `/root/dockers/para/app`（或通过 `--app-root` 指定）。

## 约定（重要）

- 始终用显式 env 文件调用 Docker Compose，避免 `.env` 查找歧义：
  `docker compose --env-file /root/dockers/para/.env ...`
- 在 `api` 容器内执行需要容器依赖的 Python 命令时，使用 `uv run python`。
  这可以确保可选依赖（例如 WS smoke 需要的 `websockets`）可用。
- WS smoke 不会打印 token 值；token 仅保留在内存中。
- DSN scheme 陷阱：
  - libpq 工具（`psql`, `pg_dump`, `pg_restore`）不接受 SQLAlchemy scheme（例如 `postgresql+psycopg://`）。
  - 对这些工具请使用 `postgresql://...`（或 libpq keyword DSN）。

## 证据与制品目录结构

辅助脚本会把日志/输出写入：

- `/root/dockers/para/backups/evidence/task-17/<timestamp>/`

在该目录下约定：

- `logs/`：命令日志
- `outputs/`：采集的输出（compose ps、health json 等）
- `src_artifacts/`：输入制品（由你提供）

源制品建议命名（restore 前先放置好）：

- `.../src_artifacts/para.src.dump`
- `.../src_artifacts/para.src.data.tar.gz`

你可以用以下参数固定 timestamp（也就固定了证据目录名）：

- `--timestamp <YYYYmmddHHMMSS>`

## 建议执行节奏

1) 始终从计划开始（`--dry-run` 或默认仅计划行为）。
2) 先执行非破坏性步骤（freeze、基线备份、migrate、up、health）。
3) 暂停并请求明确放行。
4) 执行破坏性 restore 步骤。
5) restore 后再次执行 migrate/up/health，然后运行 smoke-core。

## 安全示例调用

1) 查看帮助（无变更）：

```bash
bash deploy/prod/migration/cutover.sh --help
```

2) 打印标准非破坏流程的计划（无变更）：

```bash
bash deploy/prod/migration/cutover.sh --dry-run --freeze --backup --migrate --up --health
```

3) 执行非破坏流程（仍不 restore）并进行健康检查：

```bash
bash deploy/prod/migration/cutover.sh --run --freeze --backup --migrate --up --health \
  --prod-base-url "https://<prod-domain>"
```

说明：

- `--health` 需要 `--prod-base-url`，并会把 `.../api/v1/health` 拉取到 evidence 目录。
- `--smoke-core` 为交互式（会提示输入 email/password；密码不会回显）。

## 破坏性恢复（需要明确放行）

只有在明确放行之后才执行 restore 步骤。它们是破坏性的，并且必须带上
`--i-know-what-im-doing`。

典型调用（路径为占位符）：

```bash
bash deploy/prod/migration/cutover.sh --run --restore-assets --restore-db --i-know-what-im-doing \
  --src-assets "/root/dockers/para/backups/evidence/task-17/<timestamp>/src_artifacts/para.src.data.tar.gz" \
  --src-dump   "/root/dockers/para/backups/evidence/task-17/<timestamp>/src_artifacts/para.src.dump"
```

其行为（高层）：

- 资产恢复：先将 tarball 解压到临时目录，再替换目标资产目录。
- DB 恢复：将 dump 复制进 Postgres 容器，并执行 `pg_restore --clean --if-exists ...`。

restore 后继续执行：

- `--migrate`（migrations）
- `--up`（拉起 api/worker）
- `--health`（health check）
- `--smoke-core`（交互式 smoke）

## 回滚说明（高层）

- 基线备份的输出会保存在 evidence 目录的日志中。
- 资产恢复会把之前的目录保留为 `.prev_<timestamp>`。
- DB 回滚策略取决于你的备份/恢复策略；除非你有经过演练的回滚方案，否则将 DB restore 视为“单向操作”。
