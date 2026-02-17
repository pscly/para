# 生产备份与回滚演练（Task 18）

目标：在 `pscly.cc` 上以“可重复、可审计、无 secrets 入库”的方式完成：

- DB 备份：Postgres `pg_dump`（推荐 `custom` 或 `directory`）
- 资产快照：宿主机 `server/.data` 打 tar（或 rsync 镜像）
- 恢复演练：起一套隔离的 staging（独立 compose project + 独立数据目录），restore DB + 解压 assets + `alembic upgrade head` + health smoke

约束：

- 本目录脚本不会也不应该写入任何真实凭据。
- 日志不得打印 `POSTGRES_PASSWORD`，也不得输出包含 `password=` 的 DSN。
- 生产 Postgres 不对外 publish 5432：DB dump 推荐通过 `docker compose exec -T postgres ...` 在容器内执行。

## 文件清单

- `deploy/prod/backup/backup_pg_dump.sh`：生产 PG dump
- `deploy/prod/backup/backup_assets.sh`：生产 assets 快照（默认 tar）
- `deploy/prod/backup/restore_to_staging.sh`：从备份恢复到 staging 并 smoke
- `deploy/prod/backup/systemd/para-backup.service` + `deploy/prod/backup/systemd/para-backup.timer`：可选 systemd 定时示例（默认不启用）

## 备份路径约定（可覆盖）

默认备份根目录：`/root/dockers/para/backups`。

- DB 备份：`$BACKUP_ROOT/pg/<timestamp>/para.dump` 或 `.../para.dir/`
- 资产备份：`$BACKUP_ROOT/assets/<timestamp>/.data.tar.gz` 或 `.../.data/`

所有脚本都支持：

- `--help`：确定性帮助文本
- `--dry-run`：只打印将执行的命令，不做写操作

## 1) PG dump（生产）

在服务器部署目录（例如 `/root/dockers/para/app`）执行：

```bash
# 只看计划（不执行写操作）
bash deploy/prod/backup/backup_pg_dump.sh --dry-run

# 执行：custom 格式（默认）
bash deploy/prod/backup/backup_pg_dump.sh

# 执行：directory 格式（更利于并行/选择性恢复）
bash deploy/prod/backup/backup_pg_dump.sh --format directory
```

可调环境变量（示例）：

```bash
export BACKUP_ROOT=/root/dockers/para/backups
export COMPOSE_PROJECT_NAME=para
export COMPOSE_FILE=/root/dockers/para/app/deploy/prod/docker-compose.yml
export ENV_FILE=/root/dockers/para/.env
export DUMP_FORMAT=custom
```

说明：脚本默认会尝试使用 `/root/dockers/para/.env` 作为 `docker compose --env-file`（若存在），以与远端部署脚本保持一致；不会打印该文件内容。

## 2) Assets 快照（生产）

默认读取宿主机资产目录：`/root/dockers/para/data/server/.data`。

```bash
# 只看计划
bash deploy/prod/backup/backup_assets.sh --dry-run

# 执行：tar（默认）
bash deploy/prod/backup/backup_assets.sh

# 执行：rsync 镜像（会 --delete，确保快照一致；仅用于备份目录）
bash deploy/prod/backup/backup_assets.sh --method rsync
```

自定义资产目录（示例）：

```bash
export ASSETS_DIR=/root/dockers/para/data/server/.data
```

## 3) 恢复演练到 staging（隔离）

恢复脚本会：

1. 生成一个 staging compose（写在 `$STAGING_ROOT/docker-compose.staging.yml`）
2. 用独立 `project name` 起一套 `postgres/redis/api/worker`（端口默认 `127.0.0.1:28080`）
3. 解压 assets 到 staging `.data`
4. `pg_restore` 恢复 DB
5. `alembic upgrade head`
6. `curl /api/v1/health` 断言 `status==ok`

推荐使用 `--timestamp` 直接指向同一批次备份：

```bash
# 只看计划
bash deploy/prod/backup/restore_to_staging.sh --timestamp 20260217123456 --dry-run

# 执行恢复演练
bash deploy/prod/backup/restore_to_staging.sh --timestamp 20260217123456
```

或显式指定路径（适合备份目录不在默认位置/或手动搬运后的情况）：

```bash
bash deploy/prod/backup/restore_to_staging.sh \
  --pg-dump /root/dockers/para/backups/pg/20260217123456/para.dump \
  --assets-archive /root/dockers/para/backups/assets/20260217123456/.data.tar.gz
```

staging 默认隔离策略：

- `STAGING_PROJECT_NAME=para-staging-<timestamp>`
- `STAGING_ROOT=$BACKUP_ROOT/staging/<timestamp>`（数据目录独立）
- `ENV=staging`（避免触发生产 guard）

staging Postgres 的默认账号（仅用于演练，不是生产凭据）：

- `STAGING_POSTGRES_DB=para`
- `STAGING_POSTGRES_USER=para`
- `STAGING_POSTGRES_PASSWORD=para`

如需自定义（建议至少改密码），可通过同名环境变量覆盖。

注意：恢复演练需要 `SERVER_IMAGE` 指向一个可运行的 server 镜像（默认 `para-server:prod`）。通常可在生产仓库目录先执行一次 `docker compose build` 生成该镜像，然后再跑恢复脚本。

演练完成后，如需清理 staging 容器：

```bash
docker compose -f "$BACKUP_ROOT/staging/<timestamp>/docker-compose.staging.yml" -p "para-staging-<timestamp>" down
```

说明：`down` 不会删除 `$STAGING_ROOT`（它是 bind-mount 的宿主机目录）。需要删除请自行确认后 `rm -rf`。

## 可选：systemd 定时（示例，不默认启用）

目录：`deploy/prod/backup/systemd/`。

安装步骤（示例）：

```bash
sudo cp deploy/prod/backup/systemd/para-backup.service /etc/systemd/system/
sudo cp deploy/prod/backup/systemd/para-backup.timer /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable --now para-backup.timer

systemctl list-timers | rg para-backup || true
journalctl -u para-backup.service -n 200 --no-pager
```

注意：systemd 示例只负责“触发脚本”，不会在 unit 文件中写任何 secrets；生产 `.env` 仍应仅保存在服务器侧（例如 `/root/dockers/para/.env`）。
