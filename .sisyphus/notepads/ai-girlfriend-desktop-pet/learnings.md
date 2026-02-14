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

## 2026-02-14 Task 17 生成式相册（Client + E2E）
- UI：调试面板新增“生成式相册”卡片，严格使用 `gallery-generate` / `gallery-refresh` / `gallery-masonry` / `gallery-item` 作为稳定选择器。
- 展示：瀑布流观感优先用 CSS columns（`.gallery-masonry`）实现；容器内滚动避免窗口高度不够时整体布局溢出。
- 自动刷新：列表存在 `pending` 条目时，每 900ms 轮询一次 `desktopApi.gallery.list(saveId)`；切换 save 会清空列表并停止轮询。
- e2e：新增 gallery spec，沿用“spec 内 stub server + 写入 stub auth.tokens.json”的策略；断言出现至少 1 张 `img.gallery-img` 后截图落盘 `.sisyphus/evidence/task-17-gallery.png`。
- 若 Electron e2e 报 `Electron failed to install correctly`，可执行：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node client/node_modules/electron/install.js` 补齐 `client/node_modules/electron/dist/`。
## 2026-02-14 Task 17 生成式相册（masonry + e2e 证据截图）
- Masonry Alpha 最小依赖优先选 `CSS columns`：`columns: <width>` + `break-inside: avoid`；优点是 0 JS/0 依赖，缺点是视觉顺序与 DOM 顺序可能不一致（键盘/读屏顺序更像“逐列向下”）。
- 若生成任务能拿到图片 `width/height` 元信息，可用 `CSS grid + 固定 row 高度 + grid-row-end: span N` 做近似 masonry：布局更稳定（更接近保留 DOM 顺序），但需要计算 span。
- 真·原生 masonry（`grid-template-rows: masonry` 或 `display: grid-lanes`）在 2026 仍属于实验/实现不统一；建议仅做渐进增强（`@supports`），默认仍走 columns 或轻量 JS。
- e2e 稳定性关键：相册根节点和每个图片必须有固定 `data-testid`（集中在 `client/src/renderer/app/testIds.ts`），并提供“加载完成”可等待信号（如 `gallery-ready` 或 `gallery-item-count`）。
- Playwright 等待图片加载的最稳策略：在目标容器可见后，等待 `img.complete && img.naturalWidth > 0` 对全部（或前 N 个）成立，再截图落盘到固定路径 `.sisyphus/evidence/task-17-gallery.png`（截图前 `mkdir -p`）。
- Headless Linux 跑 Electron e2e：在无 `$DISPLAY` 时用 `xvfb-run -a` 包裹（避免 `Missing X server or $DISPLAY`），截图的 viewport 建议固定（如 1280x800）并注入 CSS 禁用动画以降低抖动。

## 2026-02-14 生成式相册：异步 Job + 文件存储 + 缩略图（外部最佳实践）
- Job 最小状态机建议：`pending -> running -> (completed | failed)`；如未来需要可扩展 `cancelled`/`retrying`。
- Job 表字段建议（最小可落地）：`id(uuid)`、`type`、`status`、`progress(int,0-100)`、`created_at/updated_at/started_at/finished_at`、`celery_task_id`、`input_ref(json)`、`output_image_path`、`thumb_image_path`、`error_code`、`error_message_redacted`。
- 单机内测最小实现路径：HTTP `POST /jobs` 创建 Job 并投递 Celery；HTTP `GET /jobs/{id}` 查询；推送可先用客户端轮询，或加 WS/SSE（服务端轮询 DB 并推送变更）。
- 文件上传/落盘：路径由服务端生成（UUID），不信任用户 filename/content-type；限制大小；只记录必要元信息（长度/类型/哈希），禁止把原始敏感数据写日志。
- 缩略图：优先 Pillow（轻量、离线可预置 wheels）；若严格不新增依赖，则先不生成真实缩略图，前端用 CSS/`<img>` 缩放展示（不省带宽，但实现最小）。

## 2026-02-14 17:39 Task 17 Plan Update
- Verified Task 17 with `uv run pytest` and `npm -C client run e2e`; evidence: `.sisyphus/evidence/task-17-gallery.png`.
- Marked task 17 as complete in `.sisyphus/plans/ai-girlfriend-desktop-pet.md` (checkbox set to `[x]`).

## 2026-02-14 Task 18 Timeline e2e（离线模拟卡片）
- Stub server 约定：在 Playwright spec 内用 `http.createServer` 自建 stub，最少实现：
  - `POST /api/v1/timeline/simulate` 返回 `{ task_id, timeline_event_id? }`
  - `GET /api/v1/timeline?save_id=...&cursor=...&limit=...` 返回 `{ items: [...], next_cursor: "..." }`
- 字段兼容：主进程解析会从 item 上读取 `save_id/saveId`、`event_type/eventType`、`created_at/createdAt`；其中 `created_at` 建议用 ISO string（renderer 用 `new Date(raw)` 格式化显示）。
- 多窗口稳定性：Electron 同时存在桌宠窗口与调试面板窗口时，不能用 `app.firstWindow()`；用 `window.innerWidth` 选最大窗口作为调试面板。
- 鉴权前置：e2e 需要在 `PARA_USER_DATA_DIR` 下写入 `auth.tokens.json`（`secure:false` + access/refresh token），再通过 env 注入 `PARA_SERVER_BASE_URL`/`PARA_USER_DATA_DIR` 启动 Electron。
- 选择器纪律：timeline 的 e2e 只使用 `data-testid`（`timeline-card`/`timeline-simulate`/`timeline-list`/`timeline-item`），截图前等待 `timeline-item` 可见，避免空白证据。

## 2026-02-14 18:07 Task 19 Social rooms：ROOM_EVENT 的“重连 replay”语义
- 当前 WS v1 的事件通道以 `(user_id, save_id)` 为 stream key；typed event 通过 `append_typed_event()` 写入该 key 的 in-memory events log。
- 连接 `/ws/v1?save_id=...&resume_from=N` 时，服务端会先发 `HELLO` 控制帧，然后回放所有 `seq > resume_from` 的历史事件帧；这使得“触发后再连接拿事件”成为稳定的验收方式。
- `ROOM_EVENT` 是业务 typed frame（`type='ROOM_EVENT'`），payload 建议保持稳定结构便于前后端断言与演进：至少包含 `event/room_id/actor_user_id/target_user_id`（可选 `created_at`）。
- 本任务把房间事件追加到“相关用户的所有 saves”，因此同一事件会在同一用户的多个 save stream 中重复出现；客户端需要按 `server_event_id` 或业务字段做去重/归并。
- 现阶段 typed event 日志仍为进程内内存结构：多进程/多实例部署、或独立 Celery worker 场景下不会天然共享；若要真正实时 fan-out，需要引入共享事件存储/推送通道（Redis/DB/SSE/专门 WS broker）。

## 2026-02-14 17:53 Task 18 Plan Update
- Verified Task 18 evidence exists: `.sisyphus/evidence/task-18-timeline.png`.
- Marked task 18 as complete in `.sisyphus/plans/ai-girlfriend-desktop-pet.md` (checkbox set to `[x]`).

## 2026-02-14 18:14 Task 19 Plan Update
- Verified Task 19 with `uv run pytest tests/test_task_19_room_event.py`; evidence: `.sisyphus/evidence/task-19-room-event.txt` (exists).

## 2026-02-14 19:10 Task 19 Client Social UI（最小卡片 + IPC + ROOM_EVENT 可视化）
- Social UI testids（集中在 `client/src/renderer/app/testIds.ts`）：
  - `socialRoomCard`: `social-room-card`
  - `socialRoomId`: `social-room-id`
  - `socialTargetUserId`: `social-target-user-id`
  - `socialCreateRoom`: `social-create-room`
  - `socialInvite`: `social-invite`
  - `socialJoin`: `social-join`
  - `socialEventList`: `social-event-list`
  - `socialEventItem`: `social-event-item`
- IPC channels（renderer 通过 preload 调用，main 负责 authed REST）：
  - `social:createRoom`
  - `social:invite`
  - `social:join`
  - WS 推送到 renderer 的事件通道：`ws:event`（状态：`ws:status`）
- WS `ROOM_EVENT` 去重策略：
  - 仅按 `server_event_id` 去重：若 `server_event_id` 为非空字符串且已存在于 `Set`，则直接丢弃该帧；否则加入 `Set` 后再 append 到 UI 列表。
  - 若 `server_event_id` 缺失/为空字符串，则不参与去重（用 fallback key 仍可展示），避免因无 id 导致误丢事件。

## 2026-02-14 18:31 Task 19 Client Social Room UI（最小闭环）
- 安全边界：renderer 不直接 fetch、不持有 token；REST 统一走 main 的 `fetchAuthedJson`，renderer 仅通过 preload 暴露的 `desktopApi.social.*` 发起 `ipcRenderer.invoke`。
- UI 选择器纪律：社交房间卡片/输入框/按钮/事件列表与条目都要有稳定 `data-testid`，并集中维护在 `client/src/renderer/app/testIds.ts`。
- WS 事件展示：在既有 `ws.onEvent` handler 中新增 `type === 'ROOM_EVENT'` 分支即可；不要影响 `CHAT_TOKEN/CHAT_DONE` 的流式逻辑。
- 重连 replay 语义：`ROOM_EVENT` 很可能来自“先触发，再连接/重连回放”；UI 不应假设事件实时到达，必要时提示用户手动点击“连接”。
- 去重与截断：用 `server_event_id`（若存在）做轻量去重更稳；事件列表建议只保留最近 N 条，避免调试面板长时间运行内存增长。

## 2026-02-14 18:43 Task 20 UGC 工坊：最小上传/审核/审计模式
- Admin 审核口采用共享密钥 header：`X-Admin-Secret: <settings.admin_review_secret>`；对应环境变量为 `ADMIN_REVIEW_SECRET`。
- 安全默认：`settings.admin_review_secret` 在本地/测试阶段可用随机默认值；线上部署必须显式设置为高强度随机值，并视为高风险开关。
- UGC 状态机最小闭环：上传创建 `ugc_assets.status='pending'`；审核改为 `approved` 或 `rejected`；客户端侧列表默认只返回 `approved`。
- 审计日志最小字段：`audit_logs(actor/action/target_id/created_at/metadata_json)`；metadata 至少记录 status 的 `from/to`，便于后续追溯与对账。
- 文件落盘约定：资源文件保存到 `server/.data/ugc/<asset_id>/original`，路径由服务端生成，不能用用户提供的 filename 拼接路径。

## 2026-02-14 Task 20 Client UGC 工坊（只拉取 approved）
- UGC UI testids（集中在 `client/src/renderer/app/testIds.ts`）：
  - `ugcCard`: `ugc-card`
  - `ugcRefresh`: `ugc-refresh`
  - `ugcList`: `ugc-list`
  - `ugcItem`: `ugc-item`
- Endpoint 固定：`GET /api/v1/ugc/assets?status=approved`（renderer 不直接 fetch，避免 token 泄露）。
- IPC 约定：
  - channel：`ugc:listApproved`
  - renderer 调用：`window.desktopApi.ugc.listApproved()`（preload 内部 `ipcRenderer.invoke`）
  - main 行为：复用 `fetchAuthedJson` 发起 authed GET；非 2xx 用 `throwApiErrorForStatus` 转换为稳定错误码；返回最小列表字段 `{ id, asset_type }[]` 供 UI 展示。

## 2026-02-14 18:58 Task 20 Verification
- Verified Task 20 with pytest; evidence exists: `.sisyphus/evidence/task-20-ugc-approve.txt`.

## 2026-02-14 Task 21 Plugins alpha（Server）
- Plugin manifest 最小格式（upload 时校验）：
  - required：`id`、`version`、`name`、`entry`、`permissions`
  - `entry` 必须为 `index.js`
  - `permissions` 必须显式声明（object 或 list）；允许空值（如 `[]` / `{}`）表示默认 deny-all
- Admin guard：复用 `X-Admin-Secret: <settings.admin_review_secret>` 作为“高风险开关”，用于插件 upload 与 approve/reject；不引入新的 RBAC/login。
- Client 安全默认：list/download 只允许 `approved`；未批准（pending/rejected）一律 404，避免泄露包存在性。

## 2026-02-14 Task 21 Client plugins（alpha）
- Feature flag：插件执行默认关闭（fresh start => disabled），状态持久化在 `userData/plugins/state.json`（尊重 `PARA_USER_DATA_DIR`）。
- 安装与运行：主进程负责 authed list/download + sha256 校验 + 落盘；插件代码在独立子进程内用 `vm` 执行（`vm` 非安全边界）。
- Menu 合约：插件通过 `addMenuItem({id,label})` 向主进程上报菜单项；主进程维护“当前插件菜单项列表”，并通过 `desktopApi.plugins.getMenuItems()` 暴露给 renderer/pet；当插件执行关闭时菜单项必须为空。
- Bubble 合约（预留）：`say(text)` / `suggestion(text)` 统一做长度裁剪（<=200 chars），后续再接入桌宠气泡/提示 UI。

## 2026-02-14 Task 21 Plugins runtime/protocol（Client）
- 下载协议对齐：`GET /api/v1/plugins/{id}/{version}` 返回 JSON `{manifest_json, code, sha256}`；客户端必须按 JSON 解析，用 `sha256(code)` 校验，再把 `code` 落盘为 `index.js`。
- 插件输出 push：主进程把插件 `say/suggestion` 通过 `plugins:output` 广播到所有窗口；preload 暴露 `desktopApi.plugins.onOutput(handler)`（返回 unsubscribe），桌宠窗口可直接订阅。
- 菜单点击回路：插件脚本可用 `onMenuClick(id, fn)` 注册回调；renderer 调 `desktopApi.plugins.clickMenuItem({ pluginId, id })` 后，主进程转发 `menu:click(requestId)` 给 plugin host，host 在 vm 内执行回调并回传 `menu:click:result`（含超时/数量限制），主进程对 invoke 侧也有超时兜底。
- 多窗口注意：原 `safeSendToRenderer()` 偏向 mainWindow，push 场景需要广播（或专发 petWindow），否则桌宠窗口收不到。

## 2026-02-14 Task 21 Pet window（桌宠 UI 接入点）
- Pet 环形菜单在 `menuOpen=true` 时调用 `window.desktopApi.plugins.getMenuItems()` 拉取插件菜单项；为避免状态不同步，菜单打开期间以 500ms 轮询刷新一次，关闭菜单时清空本地菜单项缓存。
- 默认安全关闭：当 `window.desktopApi?.plugins` 不存在、或 `getMenuItems()` 返回空数组时，不渲染任何插件菜单按钮（只保留内置 `pet-menu-item-chat`）。
- e2e 稳定选择器：
  - 插件菜单容器：`data-testid="pet-plugin-menu-item"`
  - 单个插件按钮：`data-testid="pet-plugin-menu-item-<sanitizedId>"`，其中 `sanitizedId` 只允许 `[a-zA-Z0-9_-]`（其他字符替换为 `_`，并截断到 80 字符）。
  - 插件输出气泡：`pet-plugin-bubble` / `pet-plugin-bubble-text`
- Bubble 行为：订阅 `window.desktopApi.plugins.onOutput(handler)`；收到 `{type:'say'|'suggestion', text}` 时显示半透明气泡，3-6 秒自动消失（当前 4.2s），CSS 侧 `pointer-events:none` 避免挡住 sprite 点击；文本最多 3 行（`-webkit-line-clamp` 截断）以适配 320x320 桌宠窗口。

## 2026-02-14 Task 21 Plugins e2e（Electron + Playwright + stub server）
- Spec：`client/playwright/electron-plugin.spec.ts`，在 spec 内起 `http.createServer` stub，完全离线驱动“插件闭环”。
- Stub endpoints（最小）：
  - `GET /api/v1/auth/me` -> 200 `{ user_id, email }`（避免 UI 进入 NOT_LOGGED_IN 异常态）。
  - `GET /api/v1/plugins` -> 1 条 approved（字段 `id/version/name/sha256/permissions: []`）。
  - `GET /api/v1/plugins/{id}/{version}` -> `{ manifest_json, code, sha256 }`（三者均非空）。
- sha256 必须真实匹配：用 `crypto.createHash('sha256').update(code,'utf8').digest('hex')` 计算，并同时用于 list 与 download 的校验。
- 多窗口选择：debug panel 取 `window.innerWidth` 最大的窗口；pet 取 `window.innerWidth` 最小的窗口；并通过 `app.evaluate` 选 bounds 面积最小的 `BrowserWindow` 调 `setIgnoreMouseEvents(false)` 解除鼠标穿透。
- 验收覆盖点（UI 选择器全部走 testid）：
  - 默认关闭：打开 pet 环形菜单时 `pet-plugin-menu-item-<sanitizedId>` 不存在。
  - 开启后：在调试面板插件卡片中 `pluginsToggle/pluginsRefresh/pluginsSelect/pluginsInstall` 走一遍安装。
  - 安装后：pet 菜单出现 `pet-plugin-menu-item-<sanitizedId>`；点击后出现 `pet-plugin-bubble` 且文本非空。
- 证据落盘：截图写入 `.sisyphus/evidence/task-21-plugin.png`（cwd=client，路径用 `path.resolve(process.cwd(), '..', '.sisyphus', 'evidence', ...)` 回到 repo root）。

## 2026-02-14 Task 21 Plan Update
- Marked task 21 as complete in `.sisyphus/plans/ai-girlfriend-desktop-pet.md` (checkbox set to `[x]`).
- 验证命令（已验证）：`uv run pytest`（server/）、`npm -C client test`、`npm -C client run e2e -- electron-plugin.spec.ts`。

## 2026-02-14 Task 22 Server：Admin RBAC + Config/Feature Flags + Metrics
- Admin token 语义：`POST /api/v1/admin/auth/login` 返回 bearer `access_token`；token payload 至少包含 `sub=<admin_user_id>`、`typ='admin'`、`role`；服务端校验时以 DB 中 `admin_users` 为准（不信任 token 内 role）。
- RBAC（最小两级）：`admin_users.role` 仅接受 `super_admin` / `operator`；`PUT` 需要 `super_admin`，`GET` 允许 `operator`。
- Config KV：使用 `admin_kv(namespace,key,value_json)` 做持久化；`value_json` 必须用 canonical JSON 存储：`ensure_ascii=True, separators=(",",":"), sort_keys=True`。
- Feature flags shape（最小可用）：全局 flags 存在 `admin_kv(namespace='feature_flags', key='global')`；默认包含 `plugins_enabled: false`；客户端/普通用户拉取接口返回：`{ generated_at, feature_flags: { plugins_enabled, ... } }`。
- Endpoints（本任务新增）：
  - `POST /api/v1/admin/auth/login`
  - `GET/PUT /api/v1/admin/config/models`
  - `GET/PUT /api/v1/admin/config/prompts`
  - `GET/PUT /api/v1/admin/config/feature_flags`
  - `GET /api/v1/admin/metrics/summary`
  - `GET /api/v1/feature_flags`

## 2026-02-14 Task 22 Client：Feature flags -> 插件实时启停（main 轮询）
- “远端 flags + 本地 toggle”要形成单一执行条件：`shouldRun = localEnabled && remotePluginsEnabled`；任一侧关闭都必须 stop host 并让 `getMenuItems()` 返回空数组（pet 环形菜单才能自然消失插件入口）。
- 轮询实现建议：主进程 `setInterval` 800~2000ms + `inFlight` 防重入 + try/catch 吞掉网络错误，且仅在 flags 值变化时触发 reconcile（避免每次轮询重启 host）。
- 默认安全：首次成功拉到 flags 前把远端视为关闭（`plugins_enabled=false`），避免“刚启动尚未拉到配置时”插件先跑一小段的竞态。

## 2026-02-14 Task 22 Admin feature flags e2e（Electron + Playwright + stub server）
- Spec：`client/playwright/electron-admin-flag.spec.ts`（在 spec 内用 `http.createServer` stub，完全离线）。
- Stub endpoints（最小集合）：
  - `GET /api/v1/auth/me` -> 200
  - `GET /api/v1/plugins` -> 1 个 approved
  - `GET /api/v1/plugins/{id}/{version}` -> `{ manifest_json, code, sha256 }`
  - `GET /api/v1/feature_flags` -> `{ feature_flags: { plugins_enabled: <var> } }`
  - `POST /api/v1/admin/auth/login` -> `{ access_token:'stub-admin-token', token_type:'bearer' }`
  - `PUT /api/v1/admin/config/feature_flags` -> 需要 `Authorization: Bearer stub-admin-token`，更新 `<var>`
- 验收闭环要点：远端 `plugins_enabled=false` 时，即使本地已开启执行 + 已安装插件，pet 环形菜单也不渲染 `pet-plugin-menu-item-<sanitizedId>`；admin PUT 切到 true 后，客户端轮询拿到新 flags 并自动启动 host，pet 菜单出现入口，点击后出现 `pet-plugin-bubble`。
- 运行命令：`npm -C client run e2e -- playwright/electron-admin-flag.spec.ts`
- 证据落盘：`.sisyphus/evidence/task-22-admin-flag.png`

## 2026-02-14 Task 22 Plan Update
- 验证命令（已验证）：`uv run pytest`（server/）、`npm -C client test`、`npm -C client run e2e -- electron-admin-flag.spec.ts`
- evidence: `.sisyphus/evidence/task-22-admin-flag.png`

更正：Task 22 e2e 的正确运行命令是 `npm -C client run e2e -- electron-admin-flag.spec.ts`。

## 2026-02-14 Task 23 隐私/安全基线（同意弹窗/脱敏/审计/保留）
- Client：敏感能力（插件执行）从关闭->开启必须先弹出“明确同意”面板；同意后才调用 `desktopApi.plugins.setEnabled(true)`；拒绝保持关闭；开启后可随时撤回。
- TestIds：新增 `plugins-consent-panel / plugins-consent-accept / plugins-consent-decline`（与 vision consent 风格一致，集中在 `client/src/renderer/app/testIds.ts`）。
- Server 审计 action 命名（最小、稳定）：
  - 截图敏感行为：`sensors.screenshot`（target=`save:<save_id>`，metadata 仅 bytes/宽高/隐私模式/emit 标记）
  - Admin flags 变更：`feature_flags.update`（target=`feature_flags:global`，metadata 记录 `changes.plugins_enabled.from/to`）
  - 插件审核沿用：`plugin.approve`/`plugin.reject`（target=`plugin_package:<pkg_id>`）
- 日志兜底脱敏：在 logging formatter 层对最终输出做 regex 替换（Bearer token、image_base64、data URL base64、code/manifest_json、长 base64 串等），用于防止未来误打日志泄露。
- 数据保留最小落地：settings `AUDIT_LOG_RETENTION_DAYS`（默认 90）+ super_admin 清理入口 `POST /api/v1/admin/config/audit_logs:cleanup?days=N`。

## 2026-02-14 Task 23 Server 校正（审计/脱敏/保留）
- 审计 action：截图审计统一为 `vision.screenshot`；`feature_flags.update` 的 metadata 不记录完整 flags，改为 `namespace/key` + `changed_keys` + `prev/next` 的 `sha256/len`（canonical JSON）。
- 日志兜底脱敏：移除对通用字段名 `token` 的匹配，避免误伤 WS 的 `CHAT_TOKEN` 等业务字段；优先按明确模式（`Authorization: Bearer`、`access_token/refresh_token`、`image_base64`、`data:image/*;base64,`）替换，并保留长 base64 串兜底。
- 数据保留 helper：抽出 `purge_old_audit_logs(db, now, retention_days)` 并让 cleanup endpoint 复用，测试可直接调用验证。

## 2026-02-14 Task 24 CI/本地一键验收脚本
- 一键验收：`./scripts/ci.sh`
- 固定证据路径：`.sisyphus/evidence/task-24-ci.txt`（脚本会把完整 stdout/stderr 写入该文件；每次运行会覆盖写入）
- 串联步骤：`./scripts/generate-contracts.sh --check` -> `(cd server && uv run pytest)` -> `npm -C client test`

## 2026-02-14 Task 25 Alpha E2E QA Runner（一键产证据）
- 命令：`./scripts/qa_alpha.sh`
- 产出：`.sisyphus/evidence/task-25-qa-alpha.txt`（完整运行日志，包含“证据清单/计数”）
- 流程：先跑 `./scripts/ci.sh`，再跑一次 `npm -C client run e2e -- ...`（login/chat/feed/knowledge/gallery/timeline specs）。
- 验收：脚本末尾会校验 `.sisyphus/evidence/` 下 json/png/txt 总数 >= 10，并强校验一组关键证据文件名存在；缺失会列出并 exit 1。
