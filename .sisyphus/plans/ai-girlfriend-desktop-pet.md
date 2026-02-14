# AI女友桌宠 1.0（内测 Alpha）桌面端 + 后端 同步开发总计划

## TL;DR

> **目标**：在 Windows 优先的前提下，交付一个“可登录、多设备同步、可流式对话、可长记忆、可投喂知识、可多模态感知、可生成内容、可离线时间轴、可社交/UGC/插件扩展、并带最小管理后台”的桌面 AI 桌宠内测版本。
>
> **方法**：契约先行（OpenAPI + SDK 生成 + WS 协议版本化）+ 事件/游标化同步 + 全链路 Feature Flags（默认关闭高风险能力）+ 前后端 TDD + Agent 自动化验收。

**交付物（可运行）**：
- `client/`：Electron 桌宠（透明置顶/托盘/唤醒/气泡聊天/环形菜单/仪表盘）
- `server/`：FastAPI（REST + WebSocket）、Celery Worker、PostgreSQL(pgvector)、Redis
- `server/admin/`（或等价形态）：最小管理后台（模型/Key/Prompt/开关/用量与延迟/UGC 审核）
- `contracts/`：OpenAPI 产物 + WebSocket 消息 Schema（自动生成/校验）
- 自动化测试与验收脚本：后端 pytest、前端 vitest、Electron Playwright（Agent 可执行，无需人工）

**预计工作量**：XL（范围极大，但按“核心平台 + 可选能力”拆分并强制 Feature Flag 控制）

**并行执行**：YES（建议按波次并行推进 client/server/contract/admin）

**关键路径**：契约与脚手架 → 鉴权/设备会话 → WS 基座（版本/ack/resume/interrupt）→ 流式聊天落库 → 存档/角色隔离 → 长记忆 → 知识投喂 → 多模态与系统助手 → 生成内容/离线生活/社交UGC插件 → 管理后台闭环

---

## Context

### 原始需求
- 参考现有头脑风暴：`plan.md`
- 需要把“接口规范/协议/数据模型”放在开发前先设计出来
- 桌面端与服务端同步并行开发（避免两端接口漂移）

### 已确认决策（锁定）
- 平台优先级：Windows 优先
- 账号体系：邮箱 + 密码
- 契约机制：REST 用 OpenAPI 契约 + 生成 SDK；WS 另行定义消息协议（同样要版本化与可生成类型）
- 测试策略：TDD（前后端都建立最小测试基建）
- 上线形态：内测 Alpha（不做支付；但隐私/安全“最小可用”必须显式定义与可验证）
- 1.0 必做模块：桌宠 UI、WS 流式聊天、存档/角色、长记忆、知识投喂、多模态截图理解、系统助手、生成式相册、平行生活、社交/UGC/插件、最小管理后台

### 默认值（本计划先按以下默认实现；如需改动可在执行前调整）
- Node 包管理器：`pnpm`（若环境限制可换 `npm`，但必须全仓库统一）
- Python 环境：`uv` 管理（`server/pyproject.toml`）
- 本地依赖：Docker Compose 启动 Postgres + Redis（Postgres 启用 pgvector）
- 文件/图片存储：默认本地磁盘（例如 `server/.data/`），由后端以受控方式提供下载
- 屏幕截图：默认不落盘；仅内存处理后丢弃（仅保留衍生文本/标签与计数）。如需留存，必须单独 Feature Flag + 审计
- 邮箱验证：Alpha 默认不做（但预留找回密码/验证扩展点）
- Token：Access JWT 短时（例如 15min），Refresh 长时（例如 30d）且服务端只存 hash，支持轮换
- 高风险能力默认关闭：截图上传、插件执行、UGC 公共分发、社交串门（通过 Admin 或按用户/设备开关启用）

### Metis 评审结论（已采纳为硬性护栏）
- 所有高风险能力（屏幕/文件原件/插件/UGC/社交）必须 Feature Flag 且默认关闭；启用必须显式授权 + 可撤回
- WS 协议必须从 v1 就包含：`protocol_version`、`client_request_id`、`server_event_id/seq`、`cursor`、`ack`、`resume_from`、`interrupt`
- 多设备同步必须引入幂等与序号：`op_id` / `client_request_id`、`device_id`、`seq`、`cursor`、`deleted_at`（墓碑）
- 插件系统禁止 Alpha 期“任意代码执行”形态：必须 manifest + 权限声明 + 限制 API + 进程隔离/沙箱
- 日志与 Admin 可见性默认不暴露敏感内容；仅指标/错误/采样（采样也要开关）

---

## Work Objectives

### 核心目标
在不牺牲“架构完整性”的前提下，用可控的工程拆分与默认关闭的能力开关，交付一个可实际跑通的内测 Alpha。

### Definition of Done（最终完成标准）
- [ ] 一键启动本地开发环境（Postgres+Redis+Server+Client）后，Agent 可自动完成：注册/登录 → 建立 WS → 流式聊天 → 写入与检索长记忆 → 投喂 PDF/MD 并可检索问答 → 可选启用截图理解并触发主动气泡 → 生成相册任务并在 UI 看到结果 → 离线生活时间轴可拉取 → 社交房间可创建与转发 → UGC/插件进入审核并可下发 → Admin 可配置模型/Prompt/开关并查看用量与延迟。

### 必须包含（Must Have）
- 契约先行：OpenAPI 产物可生成 SDK，并在 CI/测试中校验“契约不漂移”
- WS 协议版本化与可恢复：断线重连不重复落库、支持 resume/ack、支持 interrupt
- 高风险能力默认关闭：截图上传、插件执行、UGC 公共分发、社交串门等默认 off
- 可审计：关键开关、UGC 审核、插件发布必须写审计日志（内部 Alpha 也要）

### 必须禁止（Must NOT Have / Guardrails）
- 不做支付/订阅计费（Alpha 期明确 out）
- 不允许“默认采集/默认上传”屏幕/麦克风/文件原件
- 不允许无隔离的第三方插件执行（RCE 红线）
- Admin 默认不展示用户对话全文与屏幕内容（需要单独开关并记录审计）

---

## Proposed Architecture（建议架构）

### 总览

```mermaid
graph TD
  subgraph Desktop[Electron Desktop Client]
    Main[Main Process
window/tray/shortcuts/sensors]
    UI[Renderer
Pet UI + Bubble Chat + Dashboard]
    PluginRT[Plugin Runtime
Sandbox/Isolated]
    Main --> UI
    Main --> PluginRT
  end

  subgraph Backend[FastAPI Backend]
    API[REST API /api/v1]
    WS[WebSocket Gateway /ws/v1]
    Orchestrator[Chat Orchestrator
LLM + Tools + Streaming]
    AdminAPI[Admin API /api/v1/admin]
    API --> Orchestrator
    WS --> Orchestrator
    AdminAPI --> Orchestrator
  end

  subgraph Async[Async Workers]
    Celery[Celery Worker/Beat]
    Jobs[Ingest / Embed / Gallery / Timeline]
    Celery --> Jobs
  end

  subgraph Data[Data Stores]
    PG[(PostgreSQL + pgvector)]
    Redis[(Redis
broker/cache/presence)]
    FS[(Local FS or MinIO)
uploads/images]
  end

  UI -->|OpenAPI SDK| API
  Main -->|WS protocol v1| WS
  Orchestrator --> PG
  API --> PG
  WS --> Redis
  Celery --> Redis
  Jobs --> PG
  Jobs --> FS
```

### 代码与目录布局（建议最终形态；执行阶段创建）

```text
.
├─ client/
│  ├─ package.json
│  ├─ src/
│  │  ├─ main/                 # Electron main
│  │  ├─ preload/
│  │  └─ renderer/
│  │     ├─ app/
│  │     ├─ features/
│  │     └─ gen/               # OpenAPI/Schema 生成的 TS 类型
│  ├─ tests/
│  └─ playwright/
├─ server/
│  ├─ pyproject.toml           # uv 管理
│  ├─ app/
│  │  ├─ main.py
│  │  ├─ api/                  # routers
│  │  ├─ ws/                   # WS gateway
│  │  ├─ core/                 # config, security, rbac
│  │  ├─ db/                   # models, migrations, pgvector
│  │  ├─ services/             # orchestrator, memory, ingest, gallery
│  │  └─ workers/              # celery tasks
│  ├─ tests/
│  └─ admin_web/               # (可选) React admin
├─ contracts/
│  ├─ openapi.json             # 由 FastAPI 导出
│  └─ ws.schema.json           # 由 Pydantic schema 导出或手写并校验
└─ docker-compose.yml          # Postgres + Redis (+ MinIO 可选)
```

---

## Contract-First 规范（本计划的“接口真相来源”）

> 说明：执行阶段会把这些规范落实到 `contracts/` 文件（OpenAPI 导出 + WS Schema 导出），并建立“生成 + 校验”流水线。

### API 版本与约定
- REST Base：`/api/v1`
- WS Endpoint：`/ws/v1`
- 所有请求/响应带 `X-Request-Id`（服务端若无则生成）
- 分页默认 Cursor-Based：`cursor` + `limit`，响应包含 `next_cursor`

### 通用错误响应（REST）

```json
{
  "error": {
    "code": "AUTH_INVALID_CREDENTIALS",
    "message": "Invalid credentials",
    "details": {"field": "password"},
    "request_id": "req_..."
  }
}
```

### 鉴权模型（默认方案，可调整但需保持一致）
- Access Token：JWT（短时）
- Refresh Token：随机串（服务端仅存 hash，支持轮换与吊销）
- WS 鉴权：连接时携带 `Authorization: Bearer <access_token>`（或 query，优先 header）

### Auth & Device（REST）
- `POST /api/v1/auth/register`：邮箱注册（内部 Alpha：默认不做邮箱验证）
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`
- `GET /api/v1/devices` / `DELETE /api/v1/devices/{device_id}`

### Save Slot / Persona（REST）
- `GET /api/v1/saves` / `POST /api/v1/saves` / `PATCH /api/v1/saves/{save_id}`
- `POST /api/v1/saves/{save_id}/activate`（可选：每设备独立 active）
- `GET /api/v1/personas` / `GET /api/v1/personas/{persona_id}`
- `POST /api/v1/saves/{save_id}/persona`（绑定 persona/version）

### Conversation / Message（REST + WS）
- `GET /api/v1/conversations` / `POST /api/v1/conversations`
- `GET /api/v1/conversations/{conversation_id}/messages?cursor=&limit=`
- 发送消息与流式回复：通过 WS（见 WS 协议）

### Memory（REST）
- `POST /api/v1/memory/ingest`：写入可检索记忆（带 source 信息，便于溯源与删除）
- `GET /api/v1/memory/search?q=&cursor=&limit=`：返回带引用片段与 score
- `DELETE /api/v1/memory/{memory_id}`：遗忘（软删/墓碑）

### Knowledge Base Feeding（REST + WS 通知）
- `POST /api/v1/knowledge/materials`：multipart 上传（限制类型：md/txt/pdf；禁止 zip；可配置大小上限）
- `GET /api/v1/knowledge/materials` / `GET /api/v1/knowledge/materials/{id}`：状态（pending/indexed/failed）
- `POST /api/v1/knowledge/query`：知识库问答（必须返回引用 chunk）

### Multimodal Screenshot（REST 或 WS）
- `POST /api/v1/sensors/screenshot`：上传截图/缩略图（仅在用户启用且本地同意时）
- 服务端处理结果通过 WS 推送 `SUGGESTION`/`CHAT_PROACTIVE`

### Gallery（REST + WS）
- `POST /api/v1/gallery/generate`：创建生成任务（异步 job）
- `GET /api/v1/gallery/items`：列表
- WS 推送 `JOB_STATUS`

### Timeline / Offline Life（REST + WS）
- `GET /api/v1/timeline?cursor=&limit=`：时间轴事件
- WS 推送 `TIMELINE_EVENT`

### Social / Rooms（REST + WS）
- `POST /api/v1/social/rooms` / `POST /api/v1/social/rooms/{room_id}/invite`
- WS 推送/转发 `ROOM_EVENT`（房间消息、成员变更、AI-to-AI 事件）

### UGC / Plugin（REST + Admin 审核）
- `POST /api/v1/ugc/assets`：上传资源（pending）
- `POST /api/v1/plugins`：上传插件包（manifest + 资源）（pending）
- `GET /api/v1/plugins`：客户端拉取可用插件（仅 approved）

### Admin（REST + Web）
- `POST /api/v1/admin/auth/login`（或复用用户体系 + RBAC）
- `GET/PUT /api/v1/admin/config/models`：供应商/模型配置
- `GET/PUT /api/v1/admin/config/prompts`：Prompt 模板 + 版本
- `GET/PUT /api/v1/admin/config/feature_flags`：全局/分用户开关
- `GET /api/v1/admin/metrics/*`：用量/延迟/错误率
- `POST /api/v1/admin/review/ugc/{id}:approve|reject`

---

## WebSocket 协议 v1（核心）

### Envelope（所有消息统一外壳）

```json
{
  "protocol_version": 1,
  "type": "CHAT_SEND",
  "client_request_id": "uuid",
  "device_id": "uuid",
  "save_id": "uuid",
  "ts": "2026-02-13T12:00:00Z",
  "resume_from": 123,
  "payload": {}
}
```

**服务端事件追加字段**：

```json
{
  "server_event_id": "uuid",
  "seq": 124,
  "cursor": "opaque-cursor",
  "ack_required": false
}
```

### 语义约束（必须实现，避免多端同步/断线重连出错）
- **seq**：按 `save_id` 维度单调递增（服务端分配），用于事件顺序与断点续传
- **cursor**：可直接编码 `seq`（例如 base64），或用不透明游标；但必须可稳定恢复
- **client_request_id 幂等**：
  - `CHAT_SEND` 必须幂等：同一 `conversation_id + client_request_id` 重发不重复落库
  - 服务端建议在 `messages` 表建立唯一约束，或维护幂等表
- **resume/ack**：
  - Client 维护 `last_ack_seq`；断线重连在 HELLO 或首包携带 `resume_from=last_ack_seq`
  - Server 在能力允许下重放 `seq > resume_from` 的关键事件（至少重放 chat 的 done/error 与 job status）
- **流式 token 去重**：断线重连可能导致 token 重放；Client 必须按 `(message_id, token_index)` 去重
- **interrupt**：`INTERRUPT` 后 server 必须停止继续推送 `CHAT_TOKEN`，并发出 `CHAT_DONE`（带 `interrupted=true`）

### 最小消息类型
- `HELLO`（S→C）：返回服务端能力、心跳间隔、最大 payload 等
- `ACK`（C→S）：确认已处理到 `seq`
- `PING`/`PONG`
- `CHAT_SEND`（C→S）：发送用户消息（必须幂等：同一 `client_request_id` 重发不重复落库）
- `CHAT_TOKEN`（S→C）：流式 token 片段（包含 `message_id` 与 token 序号）
- `CHAT_DONE`（S→C）：结束（包含 usage）
- `CHAT_ERROR`（S→C）：错误（带 code）
- `INTERRUPT`（C→S）：中断当前生成（按 conversation_id + request_id）
- `SENSOR_EVENT`（C→S）：剪贴板/闲置/前台应用/截图等事件（必须受 Feature Flag + 同意控制）
- `SUGGESTION`（S→C）：建议气泡
- `JOB_STATUS`（S→C）：任务进度（索引/生图/离线模拟）
- `TIMELINE_EVENT`（S→C）：时间轴新增
- `ROOM_EVENT`（S→C）：社交房间事件

---

## Data Model（数据库最小集合，后续增量扩展）

> 内测 Alpha 仍需“可演进”：表结构需要支持墓碑、审计、幂等、游标。

### Core
- `users`：`id(uuid)`, `email(unique)`, `password_hash`, `created_at`
- `devices`：`id`, `user_id`, `name`, `last_seen_at`, `revoked_at`
- `refresh_tokens`：`id`, `user_id`, `device_id`, `token_hash`, `expires_at`, `revoked_at`, `created_at`
- `saves`：`id`, `user_id`, `name`, `created_at`, `deleted_at`
- `device_settings`：`device_id`, `active_save_id`, `feature_flags_json`

### Chat
- `conversations`：`id`, `save_id`, `title`, `created_at`, `last_message_at`
- `messages`：`id`, `conversation_id`, `sender(user|ai|system)`, `content`, `client_request_id(unique per conversation)`, `seq`, `created_at`, `meta_json`

### Memory / Knowledge
- `memory_items`：`id`, `save_id`, `source_type`, `source_id`, `text`, `weight`, `created_at`, `deleted_at`
- `memory_embeddings`：`memory_id`, `embedding(vector)`, `created_at`（vector index）
- `knowledge_materials`：`id`, `save_id`, `filename`, `file_type`, `status`, `storage_path`, `created_at`, `processed_at`
- `knowledge_chunks`：`id`, `material_id`, `chunk_index`, `content`, `embedding(vector)`（vector index）

### Gallery / Timeline
- `gallery_items`：`id`, `save_id`, `status`, `prompt`, `storage_path`, `created_at`, `meta_json`
- `timeline_events`：`id`, `save_id`, `event_type`, `payload_json`, `created_at`, `seq`

### Social / UGC / Plugin
- `rooms`：`id`, `room_type`, `created_by_user_id`, `created_at`
- `room_members`：`room_id`, `user_id`, `role`, `joined_at`
- `ugc_assets`：`id`, `owner_user_id`, `asset_type`, `status(pending|approved|rejected)`, `manifest_json`, `storage_path`, `created_at`, `reviewed_at`
- `plugins`：`id`, `owner_user_id`, `name`, `version`, `permissions_json`, `status`, `storage_path`, `created_at`, `reviewed_at`

### Admin / Audit
- `admin_users` / `roles` / `role_bindings`
- `audit_logs`：`id`, `actor_type`, `actor_id`, `action`, `target_type`, `target_id`, `metadata_json`, `created_at`

---

## Verification Strategy（强制）

### 测试基建
- Server：`pytest` + `httpx` +（推荐）docker 依赖服务；数据库用 Postgres（pgvector）
- Client：`vitest` + `@testing-library/react`
- Electron E2E：Playwright（Electron runner），至少覆盖“启动→登录→WS→发消息→收首 token”

### Agent-Executed QA 场景（全任务必须）
- 任何“请用户手动点一下/目测一下”的验收都不允许
- UI 证据：Playwright 截图到 `.sisyphus/evidence/`
- API 证据：curl 响应保存到 `.sisyphus/evidence/`

### UI 自动化约定（必须）
- Renderer 中所有关键可交互控件必须提供稳定的 `data-testid`（避免样式变更导致测试脆弱）
- 建议最小集合：
  - 登录：`login-email`、`login-password`、`login-submit`、`login-error`
  - 气泡聊天：`chat-input`、`chat-send`、`chat-stop`、`chat-last-ai-message`
  - 开关：`toggle-vision`、`toggle-assistant`、`toggle-plugins`
  - 投喂：`feed-dropzone`、`feed-progress`、`feed-done`

---

## Execution Strategy（并行波次建议）

Wave 1（地基 / 契约 / 脚手架）：任务 1-4

Wave 2（鉴权 / 设备会话 / client 登录）：任务 5-7

Wave 3（WS 基座 / 流式聊天闭环）：任务 8-10

Wave 4（存档 Persona + 长记忆 + 知识投喂）：任务 11-14

Wave 5（多模态 + 系统助手 + 生成相册 + 离线生活）：任务 15-18

Wave 6（社交/UGC/插件 + Admin 完整闭环 + 验收脚本）：任务 19-25

---

## TODOs

> 说明：每个任务都包含“自动化验收”。执行 Agent 必须在本机跑通并产出证据文件。

- [x] 1. 基础脚手架：本地依赖与一键启动

  **要做什么**：
  - 建立 `docker-compose.yml`：Postgres(含 pgvector) + Redis（MinIO 可选）
  - 建立根目录 `Makefile` 或脚本：`dev-up` / `dev-down` / `dev-reset`
  - 明确环境变量约定（不落库密钥；不把 key 写进 repo）

  **必须禁止**：
  - 不把任何真实凭据写入 git（`.env` 仅示例 `.env.example`）

  **推荐 Agent Profile**：
  - Category：`quick`
  - Skills：无

  **并行**：可与任务 2/3/4 并行

  **验收（Agent 执行）**：
  - `docker compose up -d` 成功
  - `psql` 可连通并确认已启用 pgvector（用 SQL 查询扩展存在）
  - 证据：`.sisyphus/evidence/task-1-docker-compose.txt`

- [x] 2. Server 脚手架：FastAPI + uv + DB + Alembic + /health

  **要做什么**：
  - 用 `uv` 初始化 `server/`，建立 `pyproject.toml`
  - FastAPI 应用骨架（`/api/v1/health`）
  - SQLAlchemy 2.0 + psycopg3，连接 Postgres；接入 Alembic
  - 统一配置与日志（request_id 贯穿）

  **推荐 Agent Profile**：
  - Category：`unspecified-high`
  - Skills：无

  **并行**：可与任务 3/4 并行

  **验收（TDD）**：
  - `uv run pytest` → PASS（至少覆盖 health 与 DB 连接）
  - `curl -s http://localhost:8000/api/v1/health` → JSON 包含 `{"status":"ok"}`
  - 证据：`.sisyphus/evidence/task-2-health.json`

- [x] 3. Client 脚手架：Electron + React + TS + 最小 UI

  **要做什么**：
  - 初始化 `client/`（Electron 主进程 + preload + renderer）
  - 具备 dev 启动脚本与打包脚本（Windows 优先）
  - Renderer 页面最小骨架：空白桌宠窗口 + 调试面板入口
  - 从第一天就落实 `data-testid` 约定（后续所有 Playwright 用例只依赖 testid）

  **推荐 Agent Profile**：
  - Category：`visual-engineering`
  - Skills：`frontend-ui-ux`

  **并行**：可与任务 2 并行

  **验收（TDD + E2E）**：
  - `pnpm -C client test`（或等价）→ PASS（至少 1 个 smoke test）
  - Playwright 启动 Electron，断言窗口出现（截图）
  - 证据：`.sisyphus/evidence/task-3-electron-smoke.png`

- [x] 4. 契约流水线：OpenAPI 导出 + TS SDK 生成 + 漂移校验

  **要做什么**：
  - Server 启动时可导出 OpenAPI 到 `contracts/openapi.json`
  - Client 通过脚本生成 TS 类型/SDK 到 `client/src/gen/`
  - 加入“契约漂移”校验：生成后 git diff 必须为空（或 CI 里校验）

  **推荐 Agent Profile**：
  - Category：`unspecified-high`
  - Skills：无

  **并行**：依赖任务 2（至少有 FastAPI app）

  **验收（Agent 执行）**：
  - 运行 `generate-contracts` 脚本成功
  - 生成物包含 `POST /api/v1/auth/login` 等关键端点
  - 证据：`.sisyphus/evidence/task-4-openapi-snippet.txt`

- [x] 5. Server：账号体系（注册/登录/刷新/登出）+ 设备会话

  **要做什么**：
  - 邮箱注册/登录（密码 hash：argon2/bcrypt 其一，明确）
  - refresh token 存 hash + 轮换 + 吊销
  - 设备列表与吊销（影响 WS 连接授权）

  **必须禁止**：
  - 不允许明文存 refresh token

  **推荐 Agent Profile**：
  - Category：`unspecified-high`

  **验收（TDD + curl）**：
  - pytest：覆盖正确密码/错误密码、refresh 轮换、吊销设备
  - curl：注册→登录→refresh→logout→refresh 失败
  - 证据：`.sisyphus/evidence/task-5-auth-flow.txt`

- [x] 6. Client：登录 UI + Token 安全存储 + REST 调用

  **要做什么**：
  - 登录窗口/表单（邮箱+密码）
  - token 存储：Windows 优先（最小可用：加密存储或系统凭据库；若做不到，至少做本地加密 + 明确风险）
  - 调用 `/auth/me` 验证会话

  **验收（Playwright Electron）**：
  - 场景：填充 `[data-testid="login-email"]` 与 `[data-testid="login-password"]` → 点击 `[data-testid="login-submit"]` → 显示用户邮箱
  - 失败场景：错误密码 → 出现 `[data-testid="login-error"]` 且不进入主界面
  - 截图：`.sisyphus/evidence/task-6-login-success.png`、`.sisyphus/evidence/task-6-login-fail.png`

- [x] 7. WS 协议 v1：HELLO/ACK/PING + 断线重连骨架

  **要做什么**：
  - Server `/ws/v1`：握手、HELLO、心跳、seq/cursor、ACK
  - Client：自动重连；支持 `resume_from`；同一 `client_request_id` 重发不重复落库

  **验收**：
  - 后端测试：模拟断线重连，断言 seq 连续且不会重复生成 server_event
  - 证据：`.sisyphus/evidence/task-7-ws-resume.txt`

- [x] 8. 流式聊天：CHAT_SEND → CHAT_TOKEN/CHAT_DONE + interrupt

  **要做什么**：
  - Server：接 OpenAI Responses 流式，落库 messages；支持 interrupt
  - Client：气泡聊天 UI 显示 token 流式追加；支持“停止生成”
  - 记账：保存 token usage 与延迟（供 admin）

  **验收（自动化）**：
  - API/WS 测试：发送消息 → 收到 token → done；中途 interrupt → token 停止
  - Electron E2E：填充 `[data-testid="chat-input"]` → 点击 `[data-testid="chat-send"]` → 3 秒内 `[data-testid="chat-last-ai-message"]` 出现首 token
  - 证据：`.sisyphus/evidence/task-8-chat-stream.png`

- [x] 9. 存档/角色系统：多存档切换 + Persona 绑定 + 状态隔离

  **要做什么**：
  - Server：`saves` CRUD、persona 列表/绑定；每个 save 隔离 conversation/memory/knowledge
  - Client：创建存档、切换存档、选择 persona

  **验收**：
  - 创建 2 个存档，各自聊天后历史不串
  - 证据：`.sisyphus/evidence/task-9-save-isolation.txt`

- [x] 10. 桌宠 UI：透明置顶/鼠标穿透/托盘/唤醒/环形菜单

  **要做什么**：
  - Windows：透明/置顶窗口；默认鼠标穿透；按快捷键进入可交互态
  - 托盘菜单：显示/隐藏、退出、打开 Dashboard
  - 气泡与环形菜单（最小可用即可，动画可后续增强）
  - 角色渲染层：先用占位 Sprite 跑通渲染与动画状态机；为后续接入 Pixi.js + Live2D 预留接口

  **验收（Playwright Electron）**：
  - 断言：窗口透明 + 置顶标志；触发唤醒后可点击并弹出环形菜单
  - 截图：`.sisyphus/evidence/task-10-pet-ui.png`

- [x] 11. 长记忆：生活记忆写入/检索 + 遗忘（pgvector）

  **要做什么**：
  - 记忆写入：对话总结/显式写入均可；写入时记录来源
  - 检索：返回引用片段与 score；支持删除（墓碑）
  - 安全：摄取内容标记 trusted/untrusted（为防注入留口）

  **验收（pytest + curl）**：
  - 写入“我喜欢蓝色” → 搜索“喜欢的颜色”能命中
  - 删除后再次搜索不可命中
  - 证据：`.sisyphus/evidence/task-11-memory-search.json`

- [x] 12. 日记/梦境/总结任务（异步）：Celery + 定时

  **要做什么**：
  - Celery worker/beat 建立
  - 每日任务：从记忆/对话生成日记/梦境（内部 Alpha 可先用较轻量实现）
  - 产物入库，并通过 WS 推送 `JOB_STATUS` 或 `TIMELINE_EVENT`

  **验收**：
  - 触发一次手动任务 → DB 有记录 → 客户端收到推送
  - 证据：`.sisyphus/evidence/task-12-dream-event.txt`

- [x] 13. 学习投喂：上传 → 解析 → 切片 → 向量化 → 检索问答（含引用）

  **要做什么**：
  - 上传 md/txt/pdf（pdf 提取文本；OCR 先不做默认实现）
  - 入队异步索引；保存 chunk 与 embedding
  - query 返回答案 + 引用 chunk 列表

  **验收**：
  - 上传一个包含关键句的 md → 状态从 pending→indexed
  - 提问命中并返回引用
  - 证据：`.sisyphus/evidence/task-13-knowledge-query.json`

- [x] 14. Client：拖拽投喂 UI + 索引进度气泡

  **要做什么**：
  - 拖拽文件到桌宠触发上传
  - 显示进度（pending/indexing/indexed），以及“索引完成后的一句评论”

  **验收（Playwright Electron）**：
  - 拖拽 md 文件到 `[data-testid="feed-dropzone"]` → 看到 `[data-testid="feed-progress"]` → 最终出现 `[data-testid="feed-done"]`
  - 截图：`.sisyphus/evidence/task-14-feed-progress.png`

- [x] 15. 多模态截图理解（强隐私开关 + 最小可用）

  **要做什么**：
  - Client：截图能力默认关闭；启用时显示明确授权 UI（可撤回）
  - 上传策略：低频 + 可配置 + 只上传缩略图/裁剪区域（默认）
  - Server：对截图做理解并生成“建议气泡/主动一句话”

  **验收**：
  - 默认关闭：不会上传（通过后端计数/测试断言）
  - 开启后：打开 `[data-testid="toggle-vision"]` → 上传 1 张测试截图 → 返回建议并在客户端显示
  - 证据：`.sisyphus/evidence/task-15-vision-suggestion.png`

- [x] 16. 系统助手：剪贴板/闲置/前台应用事件 → 建议气泡

  **要做什么**：
  - Client：监听 clipboard、idle、active window（Windows 优先）
  - Server：意图识别（要不要打扰）+ 生成建议
  - 全部必须可配置开关，默认关闭“打扰型”

  **验收**：
  - 复制一段英文 → 触发“要不要翻译”建议
  - 闲置 5 分钟 → 触发关怀建议（可关闭）
  - 证据：`.sisyphus/evidence/task-16-assistant-suggest.png`

- [ ] 17. 生成式相册：生图任务 + 存储 + 展示

  **要做什么**：
  - Server：gallery job（异步），存储到本地 FS/对象存储，产出缩略图
  - Client：相册瀑布流展示 + 记忆胶囊标签

  **验收**：
  - 触发生成任务 → job 完成 → UI 出现新图片
  - 证据：`.sisyphus/evidence/task-17-gallery.png`

- [ ] 18. 平行生活离线模拟：时间轴事件生成 + 回放

  **要做什么**：
  - Server：定时生成离线事件（可先简单随机+状态权重）
  - Client：Dashboard 时间轴展示；上线后拉取新事件并播放一条气泡

  **验收**：
  - 手动触发模拟任务 → 客户端拉取到事件并显示
  - 证据：`.sisyphus/evidence/task-18-timeline.png`

- [ ] 19. 社交房间：串门/房间消息转发 + 最小 UI

  **要做什么**：
  - Server：房间创建/邀请/加入；WS 转发 ROOM_EVENT
  - Client：输入好友 ID 加入房间；显示房间事件（先文本即可）

  **验收**：
  - 后端 pytest：建立 2 个 WS 客户端连接（同一进程）→ 创建房间 → 邀请/加入 → 双方收到 ROOM_EVENT（避免依赖两台真实桌面环境）
  - 证据：`.sisyphus/evidence/task-19-room-event.txt`

- [ ] 20. UGC 工坊骨架：上传 → pending → admin 审核 → approved 下发

  **要做什么**：
  - Server：UGC 资源上传（manifest + 文件）进入 pending
  - Admin：审核通过/拒绝；写审计日志
  - Client：仅拉取 approved 资源列表

  **验收**：
  - 上传资源 → admin approve → client 可拉取
  - 证据：`.sisyphus/evidence/task-20-ugc-approve.txt`

- [ ] 21. 插件系统（Alpha 安全版）：manifest + 权限 + 沙箱运行（默认关闭）

  **要做什么**：
  - 插件必须 manifest 声明权限（网络/文件/屏幕/剪贴板等默认全禁）
  - Client：沙箱/隔离进程执行（最小 API：say(), suggestion(), addMenuItem()）
  - Server：插件包上传、审核、下发
  - Feature Flag：插件执行默认关闭

  **验收**：
  - 默认关闭：插件不运行
  - 开启后：安装一个示例插件 → 在环形菜单出现入口 → 点击触发气泡输出
  - 证据：`.sisyphus/evidence/task-21-plugin.png`

- [ ] 22. 管理后台最小可用：模型/Prompt/开关/用量延迟/审核

  **要做什么**：
  - RBAC：至少区分 super admin 与 operator
  - 可配置：模型供应商、key、model 名称、prompt 模板版本
  - feature flags：全局与按用户/设备
  - 指标：token 用量、延迟 P95、错误率
  - 审核：UGC/插件 approve/reject

  **验收（Agent 执行）**：
  - `curl` 或 Playwright：登录 admin → 修改一个开关 → 客户端实时生效
  - 证据：`.sisyphus/evidence/task-22-admin-flag.png`

- [ ] 23. 隐私/安全基线：同意弹窗、数据保留、日志脱敏、审计

  **要做什么**：
  - Client：敏感能力启用必须弹窗确认（可撤回）
  - Server：日志默认不记录对话全文与截图；仅记录计数/哈希/元信息
  - 审计：关键操作（启用截图、approve 插件、查看敏感内容）必须记录

  **验收**：
  - `rg` 扫描日志（或测试断言）确认无敏感字段
  - 审计表有记录
  - 证据：`.sisyphus/evidence/task-23-audit.txt`

- [ ] 24. CI/本地一键验收脚本：契约漂移 + 测试全绿

  **要做什么**：
  - 增加 `scripts/ci.sh`（或等价）串联：
    - 生成 `contracts/openapi.json`
    - 生成 `client/src/gen/`（OpenAPI SDK/类型）
    - 运行 server pytest
    - 运行 client 单测
  - 约束：脚本成功退出码为 0；失败时输出明确哪一步失败

  **验收**：
  - Agent 执行 `./scripts/ci.sh` → exit 0
  - 证据：`.sisyphus/evidence/task-24-ci.txt`

- [ ] 25. Alpha E2E QA Runner：覆盖 DoD 的端到端证据产出

  **要做什么**：
  - 增加 `scripts/qa_alpha.sh`（或等价）自动化跑通：
    - 注册/登录（REST）
    - 建立 WS 并发送一条 CHAT_SEND，等待 CHAT_DONE
    - 写入/检索一条 memory
    - 上传并索引一个 md，执行一次 knowledge query
    - 触发一条 gallery job 并等待完成
    - 触发一次 timeline 事件并拉取
  - 产出所有响应体与关键截图到 `.sisyphus/evidence/`

  **验收**：
  - Agent 执行 `./scripts/qa_alpha.sh` → exit 0
  - `.sisyphus/evidence/` 下存在至少 10 份证据文件（json/png/txt）

---

## Commit Strategy（建议）

- 每完成一个 Wave 合并一次：
  - Wave 1：`chore: bootstrap client/server/contracts`
  - Wave 2：`feat(auth): email login and device sessions`
  - Wave 3：`feat(chat): ws streaming with interrupt/resume`
  - Wave 4：`feat(memory): saves/personas/memory/knowledge`
  - Wave 5：`feat(ai): vision/assistant/gallery/timeline`
  - Wave 6：`feat(platform): social/ugc/plugins/admin/release`

---

## Success Criteria（最终验收命令示例）

```bash
# 1) 启动依赖
docker compose up -d

# 2) 启动 server
# uv run uvicorn app.main:app --reload --port 8000

# 3) 启动 client
# pnpm -C client dev

# 4) 运行测试
# uv run pytest
# pnpm -C client test

# 5) 运行一键验收
# ./scripts/ci.sh
# ./scripts/qa_alpha.sh
```
