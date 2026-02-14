# Learnings

## 2026-02-13 Init
- 仓库当前为绿地：`client/`、`server/` 为空；仅有 `plan.md` 作为构想文档。
- 本机环境：Python 3.12 + `uv` 可用；Node 24 + npm 可用；`pnpm` 不存在；`rg` 不存在；`ast-grep` 的 `sg` 命令不存在（系统自带 `sg` 为 group 工具）。
- 执行原则：REST 用 OpenAPI 契约生成；WS 协议必须版本化且支持 ack/resume/interrupt；高风险能力默认关闭并可审计。

## 2026-02-14 Local Deps Bootstrap
- Local infra uses Docker Compose with only Postgres (pgvector image) + Redis.
- Compose vars use `${VAR:-default}` so `docker compose config` works even without a `.env` file.
- `Makefile` chooses `.env` if present, otherwise falls back to `.env.example` via `docker compose --env-file`.

## 2026-02-14 Verification Notes
- Because `COMPOSE_PROJECT_NAME` is provided via `--env-file`, follow-up commands like `docker compose ps` should also use `--env-file .env.example` (otherwise it won't find the project containers).
- Postgres image includes pgvector extension (available), but extension is not installed in DB by default; enable later via migration (`CREATE EXTENSION IF NOT EXISTS vector`).
- System package `make` was missing initially; installed `make` so `Makefile` targets can be used.

## 2026-02-14 Client E2E (Electron + Playwright)
- Headless Linux 默认没有 X server，直接跑 Electron/Playwright 会报 `Missing X server or $DISPLAY`；用 `xvfb-run -a` 包裹可解决。
- `electron` npm 包需要下载二进制到 `client/node_modules/electron/dist/`，有时 postinstall 不会自动完成；可手动执行：
  - `ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node node_modules/electron/install.js`
- e2e smoke 测试在通过时会输出截图证据：`.sisyphus/evidence/task-3-electron-smoke.png`

## 2026-02-14 Server scaffold
- `uv run pytest` executes the `pytest` console script (so `sys.path[0]` becomes `.venv/bin`), which can break imports of local packages like `app`.
- `uv run python -m pytest` keeps CWD on `sys.path`, so it works without extra help.
- To satisfy the required `uv run pytest` verification, add `server/tests/conftest.py` to inject the project root into `sys.path`.

## 2026-02-14 DB smoke test
- DB 冒烟测试用 `app.db.session.engine` 直接连 Postgres，并用 `sqlalchemy.text("SELECT 1")` 校验能跑通最小查询。
- 失败时要把“连接串来源”（`DATABASE_URL` vs `POSTGRES_*`）和隐藏密码后的 URI 打出来，方便定位 docker-compose 端口映射/环境变量问题。
- 基于 basedpyright 的 LSP 需要 `server/pyrightconfig.json` 显式指向 `server/.venv`，否则会误报第三方依赖（如 SQLAlchemy）无法解析。

## 2026-02-14 Client e2e (headless Linux)
- Electron/Playwright e2e 在无 `$DISPLAY` 的 Linux 上会因缺少 X server 报错；可靠的做法是仅在 `linux && !DISPLAY` 时用 `xvfb-run -a` 包裹。
- 为避免引入 cross-env 等依赖，可用 Node 脚本做平台检测，并通过 `npm exec -- playwright test` 调起本地 `node_modules/.bin/playwright`。

## 2026-02-14 Client scaffold (Electron + React + TS)
- Vite 以 `client/src/renderer` 作为 `root`，产物输出到 `client/dist/renderer`；Electron(主进程/预加载) 由 `tsc -p tsconfig.electron.json` 编译到 `client/dist/main`/`client/dist/preload`。
- Vitest 与 Vite 的 `root` 需求不同：Vite 为 renderer；Vitest 建议通过 `test.root` 指回 `client/`，才能让 `client/tests/**` 被发现。
- Day 1 固化 `data-testid`：集中在 `client/src/renderer/app/testIds.ts`，e2e 与单测都引用同一份常量。
- 内网/不稳定网络下 Electron 二进制下载容易失败；可在安装时指定 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

## 2026-02-14 Task 3 验收证据（e2e 成功截图）
- Playwright 的 `testInfo.outputPath()` 更适合 CI artifact，但验收证据要求固定落盘到仓库内；因此在 smoke spec 里直接 `page.screenshot({ path: <repo>/.sisyphus/evidence/... })`。
- 在 `npm -C client run e2e` 场景下，测试进程的 cwd 通常是 `client/`；用 `path.resolve(process.cwd(), '..', '.sisyphus', 'evidence', ...)` 可稳定回到仓库根目录。
- 为避免目录不存在导致失败，截图前用 `fs.promises.mkdir(path.dirname(target), { recursive: true })`。

## 2026-02-14 Contract pipeline (OpenAPI + TS)
- Placeholder auth routes live in `server/app/api/v1/auth.py` and are included via `server/app/api/v1/router.py` under `/api/v1`.
- OpenAPI export command (run from `server/`): `uv run python -m app.scripts.export_openapi --output ../contracts/openapi.json`.
- Client types are generated with `openapi-typescript` via `npm -C client run gen:api` into `client/src/gen/openapi.ts`.
- One-command regeneration + drift check: `scripts/generate-contracts.sh` (use `--check` to enforce `git diff --exit-code`).

## 2026-02-14 Contract check (untracked outputs)
- `git diff --exit-code -- <paths>` 只会比较已被 Git 跟踪的文件内容；对未跟踪(??)的生成物不会报错，导致 `--check` 形同虚设。
- 用 `git status --porcelain -- contracts/openapi.json client/src/gen` 可以同时覆盖 untracked 与 modified（包含 index/worktree 两侧），更适合作为 CI 的契约漂移检查。

## 2026-02-14 Task 6 Client login (REST + safeStorage + e2e stub)
- 新增 env：`PARA_SERVER_BASE_URL`、`PARA_USER_DATA_DIR`
- IPC channels：`auth:login`、`auth:me`、`auth:logout`（强调 token 仅主进程安全存储与使用；renderer 只拿到登录态/用户信息，不直接接触 token）
- e2e stub server：在 Playwright spec 内启动本地 http server，stub `/login` 与 `/me` 等 REST 路由，避免依赖真实后端环境与网络波动
- 证据路径：`.sisyphus/evidence/task-6-login-success.png`、`.sisyphus/evidence/task-6-login-fail.png`

## 2026-02-14 WS 协议 v1（Server）
- 控制帧/事件帧区分：`HELLO/ACK/PING/PONG` 统一为控制帧（`seq=0` 且 `server_event_id=null`）；只有“可回放事件”才分配 `seq>=1` 且 `server_event_id!=null`
- 断线重连参数：`resume_from` 采用 query 参数（`/ws/v1?save_id=...&resume_from=...`），服务端仅回放 `seq > resume_from` 的事件
- 模块与 API：`server/app/ws/v1.py` 提供 `append_event(stream_key, payload, ack_required=True)` 与 `get_events_after(stream_key, resume_from)` 供后续测试/业务调用

## 2026-02-14 WS 测试（Task 7 evidence 落盘）
- 在 `server/tests/*` 内写证据文件时，仓库根目录可用：`REPO_ROOT = Path(__file__).resolve().parents[2]`（`.../server/tests/test_*.py` -> repo root）
- evidence 路径固定：`REPO_ROOT / '.sisyphus' / 'evidence' / 'task-7-ws-resume.txt'`，先 `mkdir(parents=True, exist_ok=True)` 再 `write_text(..., encoding='utf-8')`
- WS 连接参数传法：`client.websocket_connect(f"/ws/v1?save_id={save_id}&resume_from={resume_from}", headers={"Authorization": f"Bearer {access_token}"})`

## 2026-02-14 Task 8 WS 流式聊天（Server 最小实现）
- 新增 WS 消息类型：
  - client -> server：`CHAT_SEND`、`INTERRUPT`
  - server -> client（可回放事件帧）：`CHAT_TOKEN`、`CHAT_DONE`
- `INTERRUPT` 语义：客户端发送 `{"type":"INTERRUPT"}` 表示中断当前正在进行的 chat stream；服务端停止继续推送 token，并发送一条 `CHAT_DONE`，其 `payload.interrupted=true`
- events log / resume 规则：`CHAT_TOKEN`/`CHAT_DONE` 作为事件帧必须分配 `seq>=1` 且 `server_event_id!=null`，并写入该 stream 的 events log；断线重连时仍通过 `resume_from` 回放 `seq > resume_from` 的历史事件

## 2026-02-14 Task 9 存档/Persona（Server+Client）
- Server API：新增 `GET/POST /api/v1/saves`、`PATCH /api/v1/saves/{save_id}`、`POST /api/v1/saves/{save_id}/persona`、`GET /api/v1/personas`、`GET /api/v1/personas/{persona_id}`（均需 Bearer JWT）。
- 数据模型：`Save`（软删字段 `deleted_at`）、`Persona`、`SavePersonaBinding`（`save_id` 主键保证“一存档最多一个 persona”）。
- WS 隔离验收：复用现有 `(user_id, save_id)` 的 in-memory events log，通过两条 save 分别 `CHAT_SEND` 不同文本，并在重连 replay 中断言 token 文本不串。
- 客户端 UI：为避免 e2e stub 被动触发 404，saves/personas 不在 mount 自动加载，只在点击“加载”按钮后通过 IPC 拉取；WS `connect(saveId)` 默认仍用 `'default'`。

## 2026-02-14 Task 10 桌宠窗口与多窗口 e2e
- Electron 同时创建“调试面板窗口 + 桌宠窗口”后，Playwright 的 `app.firstWindow()` 可能返回任一窗口；e2e 需要显式选择目标窗口（例如用 `window.innerWidth` 选最大为调试面板、最小为桌宠）。
- 桌宠窗口通过 `?window=pet` query 加载同一 renderer，并在 `client/src/renderer/main.tsx` 里按 query 切换渲染 `PetApp`。
- 桌宠默认 `setIgnoreMouseEvents(true,{forward:true})`，测试/唤醒需先切到可交互态（tray/hotkey 或 `app.evaluate` 调用 `setIgnoreMouseEvents(false)`）。

## 2026-02-14 Task 11 长记忆（pgvector）
- pgvector 扩展需要在 DB 里显式启用：`CREATE EXTENSION IF NOT EXISTS vector`；镜像带扩展不等于数据库已安装。
- 不引入第三方依赖时，可用 SQLAlchemy `UserDefinedType` 自己声明 `vector(N)`：`get_col_spec()` 返回 `vector(64)`，并在 `bind_processor` 把 `list[float]` 序列化成 pgvector 文本格式（例如 `"[0.1,0.2,...]"`）。
- 相似度检索可直接用 `<->` 运算符：`MemoryEmbedding.embedding.op('<->')(literal(query_vec, type_=Vector(N)))`，再 `.order_by(distance.asc())`。
- 为了测试可复现且不联网，embedding 可用“按字符 sha256 hash 到固定维度桶 + L2 归一化”的本地算法，让短中文句子也能产生稳定相似度。

## 2026-02-14 Task 9a Save/Persona 模型（仅 models.py）
- `Save`：表 `saves`，字段 `id/user_id/name/created_at/deleted_at`；`user_id` 外键到 `users.id`（`ondelete=CASCADE`）且 `index=True`，`deleted_at` 允许为空用于软删除。
- `Persona`：表 `personas`，字段 `id/name/prompt/version/created_at`；`name` 设为 `unique=True` + `index=True`，`prompt` 用 `Text()`，`version` 用 `Integer()` 且默认 `1`。
- `SavePersonaBinding`：表 `save_persona_bindings`，字段 `save_id/persona_id/bound_at`；用 `save_id` 作为主键来保证“每个 save 至多绑定一个 persona”，两端外键均 `ondelete=CASCADE`。

## 2026-02-14 Task 11 长记忆（pgvector）
- pgvector 镜像“自带扩展”不等于 DB 已安装：跑 `Base.metadata.create_all()` 之前需要先 `CREATE EXTENSION IF NOT EXISTS vector`，否则 `vector(N)` 列建表会直接失败。
- 不引入第三方依赖时，可用 SQLAlchemy `UserDefinedType` 声明 `vector(N)` 列类型，并在 `bind_processor` 把 `list[float]` 序列化为 pgvector 接受的文本输入（如 `"[0.1,0.2]"`）。
- SQLAlchemy 里用 `embedding.op("<->")(<query_vector>)` 做距离计算时，表达式类型推断可能落到“向量列类型”；稳妥做法是对距离表达式 `.cast(Float)`，避免结果处理器误把距离当向量解析。

## 2026-02-14 Celery + basedpyright（类型告警处理）
- Celery 相关对象（Celery app、task 装饰器、AsyncResult）在类型层面经常缺少稳定的 stub，basedpyright 容易报 `reportUnknown*` / `reportUntypedFunctionDecorator`。本仓库优先用文件级 `# pyright: ...=false` 做最小抑制，避免全局关规则。
- `.delay()`/`.get()` 在 FastAPI endpoint 内常被推断成 `Any`；做法是：要么对 task 变量做一次 `cast()`（保持代码可读），要么只在该文件里关闭 `reportAny/reportExplicitAny`，不要在全项目关闭。
- 现有代码大量使用 `datetime.utcnow()`（naive UTC）；为避免一次性改动面太大，可在 Celery 任务文件局部关闭 `reportDeprecated`，保持行为一致，后续再统一迁移到 timezone-aware。

## 2026-02-14 Task 13 学习投喂（knowledge）
- 文件落盘约定：上传后保存到 `server/.data/knowledge/<material_id>/original.<ext>`，路径由服务端生成，不信任原始文件名。
- 切片策略：按字符窗口切片（默认 `max_chars=800`，`overlap=120`），优先在换行/常见分隔符处分割，保证 chunk_index 从 0 递增。
- PDF 文本抽取：最小依赖选用 `pypdf`（仅做文本提取，不做 OCR）。
- FastAPI 上传：使用 `UploadFile + Form` 需要 `python-multipart` 依赖，否则路由注册阶段直接报错。
- Celery 测试：用 `celery_app.conf.task_always_eager=True` 让 `.delay()` 同进程执行，从而在 pytest 里稳定断言 material.status 从 pending 变为 indexed。

## 2026-02-14 Task 14 Client 投喂 UI（拖拽 + 进度三态）
- 拖拽上传要可被 Playwright 稳定模拟：renderer 侧用 `File.arrayBuffer()` 读 bytes，经 preload IPC 传给 main；不要依赖 `file.path`。
- 主进程上传走 `fetch + FormData` multipart：`POST /api/v1/knowledge/materials`（字段 `file` + `save_id`）；查询用 `GET /api/v1/knowledge/materials/{id}`。
- e2e 推荐在 spec 内启动本地 stub server：先返回 `pending`，再切到 `indexed`，确保 UI 的 `feed-progress` 可观测，最后落盘固定截图证据。

## 2026-02-14 Task 15 多模态截图理解（最小可用 + 强隐私开关）
- REST：新增 `POST /api/v1/sensors/screenshot`，Bearer JWT 鉴权 + `save_id` 归属校验，稳定返回 `{ "suggestion": "..." }`。
- 输入：JSON `image_base64` 支持裸 base64 与 data URL（仅剥离前缀，不落盘不记录内容）；对 base64 字符长度与解码后 bytes 都做上限保护（413）。
- 隐私：`privacy_mode` 默认 `strict`（仅同步返回，不写入 WS）；`standard` 或显式 `emit_ws_event=true` 时才追加一条 `SUGGESTION` typed event，payload 仅含 suggestion + 元信息（bytes/宽高）。

## 2026-02-14 Task 15 Client 多模态截图理解（toggle + 授权 UI + e2e stub）
- 新增 testids：
  - `toggle-vision`
  - `vision-consent-panel` / `vision-consent-accept` / `vision-consent-decline`
  - `vision-send-test-screenshot`
  - `vision-suggestion`
- IPC channel：`vision:uploadScreenshot`
  - renderer -> preload payload：`{ saveId, imageBase64, privacyMode }`
  - main -> server request：`POST /api/v1/sensors/screenshot` JSON `{ save_id, image_base64, privacy_mode }`
  - response：`{ suggestion }`（renderer 直接展示，提供稳定 testid 断言）
- e2e stub server 约定：
  - 路由：`POST /api/v1/sensors/screenshot`
  - 行为：记录 hit 次数（用于断言“默认关闭不发请求 / 授权开启后发 1 次”），并返回 `{ suggestion: "stub: ..." }`

## 2026-02-14 Task 16 Client 系统助手（assistant）
- 新增 testids（e2e 稳定选择器来源）：`toggle-assistant`、`toggle-assistant-idle`、`assistant-copy-english`、`assistant-suggestion`。
- IPC 设计：renderer 仅通过 preload 暴露的 `desktopApi.assistant` 控制开关/订阅建议；所有网络请求与 token 均留在 main 进程。
- main -> renderer 推送：复用 `safeSendToRenderer('assistant:suggestion', { suggestion, category })`，与 `ws:event/ws:status` 一致，避免 renderer 主动轮询。
- idle 计时器：默认 5 分钟，支持 env `PARA_ASSISTANT_IDLE_MS` 覆盖；本任务采用一次性 setTimeout（触发一次 idle 事件）。
