# 0.1 Beta 目标清单与范围冻结（HTTP/WS）

本文件用于冻结 0.1 Beta 阶段的“必须交付范围 / 明确不做范围 / 里程碑 / 风险 / 验收与证据约定”。

核心原则：以“当前真实实现”为真相来源，不写空泛口号。

## 真相来源（Source of Truth）

- HTTP API：`contracts/openapi.json`
  - OpenAPI 版本：`openapi=3.1.0`
  - 当前文档版本：`info.version=0.1.0`
  - 所有 HTTP 路由必须以 OpenAPI 为准（路径、字段、状态码、校验约束）。
- 合同生成与漂移检查（drift check）：
  - `scripts/generate-contracts.sh`：生成 `contracts/openapi.json` 与 `client/src/gen/*`；支持 `--check` 检查漂移。
  - `scripts/ci.sh`：在 CI/本地验收脚本中显式执行 `./scripts/generate-contracts.sh --check`。
- WS 协议 v1：
  - 服务端实现：`server/app/ws/v1.py`
  - 客户端实现（主进程 WS 连接 + ACK/resume 规则）：`client/src/main/index.ts`
  - 可执行协议证据（pytest）：`server/tests/test_ws_v1_resume.py`、`server/tests/test_ws_v1_chat_stream.py`
- Beta QA Runner（验收入口骨架）：`scripts/qa_beta.sh`
  - `./scripts/qa_beta.sh --dry-run` 必须仅打印“将要执行的命令清单”。

## Must Have（0.1 Beta 必须具备）

### 1) 版本维度清晰且不混淆

必须明确区分并在变更评审时分别讨论：

- 应用版本（Repo release semver）：例如 `0.1.0` / `0.1.x`。
- HTTP API 版本：以路径前缀 `/api/v1` + `contracts/openapi.json` 为准。
- WS 协议版本：以 endpoint `/ws/v1` + `server/app/ws/v1.py` 内 `PROTOCOL_VERSION=1` 为准。

### 2) HTTP 合同冻结：/api/v1 + OpenAPI 工件受控

- “HTTP 真相”只能是 `contracts/openapi.json`。
- 必须能用 `./scripts/generate-contracts.sh --check` 发现并阻止 OpenAPI/TS 生成物漂移（见 `scripts/generate-contracts.sh`、`scripts/ci.sh`）。
- 0.1 Beta 期间禁止在 `/api/v1` 下做破坏性变更（breaking changes）；如必须破坏，必须引入 `/api/v2`（不在本 Beta 范围）。

### 3) WS v1 协议冻结：可重连回放 + ACK + 流式聊天

以 `server/app/ws/v1.py` 为准：

- endpoint：`/ws/v1`
- 连接参数：必须携带 `save_id` 与 `resume_from`（query），且 `resume_from` 必须为 `>=0` 的整数。
- 鉴权：必须使用 header `Authorization: Bearer <access_token>`（服务端当前不支持 query token）。
- 帧结构（服务端 `WSFrame`）：固定字段 `protocol_version`/`type`/`seq`/`cursor`/`server_event_id`/`ack_required`/`payload`。
- 协议能力：
  - `HELLO` 控制帧（`seq=0`，用于宣告当前 `cursor`）
  - `ACK`：客户端对 `ack_required=true` 且 `seq>=1` 的帧进行确认
  - `PING`/`PONG`：保活与诊断
  - `resume_from`：断线重连后回放 `seq > resume_from` 的历史帧
  - `CHAT_SEND` -> `CHAT_TOKEN`/`CHAT_DONE`：最小流式聊天输出
  - `INTERRUPT`：中断当前聊天流（最终 `CHAT_DONE.payload.interrupted=true`）

以 `client/src/main/index.ts` 为准：

- 客户端连接时将 `resume_from` 设置为本地 `lastReceivedSeq`。
- 客户端仅在收到“可回放事件帧”（`server_event_id!=null` 且 `ack_required=true`）时自动发送 `{"type":"ACK","cursor":<lastReceivedSeq>}`。

### 4) 验收入口存在：qa_beta dry-run 行为稳定

- `scripts/qa_beta.sh` 必须支持 `--dry-run`，并且只打印“将要执行的命令清单”（脚本行为详见 `scripts/qa_beta.sh`）。
- 文档层面的验收口径：`./scripts/qa_beta.sh --dry-run` 的输出即为“Beta 验收将执行什么”的唯一入口，不允许另起一套口径。

## Non-goals（0.1 Beta 明确不做）

为避免 scope creep，本 Beta 明确排除：

- HTTP：新增 `/api/v2`（除非发生不可避免的 breaking，但这将触发重新评审）。
- WS：任何会破坏 v1 冻结字段/语义的改动；尤其是把 cursor 语义改成 per-device / opaque。
- Durable WS：事件落库、可裁剪 EventStore、跨进程/多实例一致性（v1 当前为进程内内存结构）。
- 多设备协议：device cursor、设备租约（lease）、按设备 ACK 表等（属于 WS v2 计划）。
- 安全增强大项：应用层加密 envelope、反调试/反编译、端到端审计闭环（这些可在后续 Wave 分阶段交付）。

## 里程碑（Milestones）

本文件只冻结“做什么/不做什么”，不承诺具体日期。

- M0（Wave0）：冻结文档与真相来源
  - 产物：`docs/beta-scope.md`、`docs/protocol-versioning.md`
  - 证据：notepad 决策记录见 `.sisyphus/notepads/ai-girlfriend-desktop-pet-beta-hardening/decisions.md`
- M1（Wave0/1）：协议证据固化
  - WS 证据：`server/tests/test_ws_v1_resume.py`、`server/tests/test_ws_v1_chat_stream.py`
  - 合同证据：`./scripts/generate-contracts.sh --check`（见 `scripts/ci.sh` 的契约漂移步骤）
- M2（Wave0.2 已存在）：验收入口（dry-run）
  - `./scripts/qa_beta.sh --dry-run` 输出稳定、可读、无副作用

## 风险与已知差距（不做过度承诺）

### WS v1 的结构性风险

- 事件与 ACK 状态是进程内内存（见 `server/app/ws/v1.py` 的 `_streams`）：
  - 服务重启会丢失 events log 与 `last_acked_seq`。
  - 不支持多实例/横向扩展的“全局一致重放”。
- ACK 是按 `(user_id, save_id)` 的“单流”维度维护，不区分设备：多设备并发可能互相推进 cursor，语义不清晰。
- `cursor` 当前等同于 `seq`（整数、可推断）：不具备“不可推断/不可伪造”的 opaque 特性。

### 合同与生成物风险

- OpenAPI/TS 生成物如果未按 `scripts/generate-contracts.sh` 同步更新，会产生 drift；必须依赖 `--check` 阻断。

### 环境/DDL 风险（提醒）

- 仓库中存在 `CREATE EXTENSION IF NOT EXISTS vector` 这类 DDL（例如测试文件 `server/tests/test_ws_v1_resume.py`、`server/tests/test_ws_v1_chat_stream.py`）。生产化时通常应迁移到一次性初始化（迁移/启动检查），避免在运行时或高频路径执行。

### qa_beta Runner 风险

- `scripts/qa_beta.sh` 当前为 Wave0.2 骨架：`verify_*` 仍是占位实现。Beta 的“真实端到端验收”需要后续波次逐步落地，但必须保证 dry-run 与真实执行保持一致。

## 验收与证据约定（Acceptance & Evidence）

0.1 Beta 的验收应以“可执行证据 + 固定路径”作为准入门槛。

- HTTP 合同漂移：
  - 命令口径：`./scripts/generate-contracts.sh --check`
  - CI 口径：`scripts/ci.sh` 中的 “契约漂移检查（OpenAPI + TS 生成物）” 步骤
  - 工件路径：`contracts/openapi.json`、`client/src/gen/*`
- WS v1 协议证据（pytest）：
  - 重连回放连续性 + server_event_id 唯一性：`server/tests/test_ws_v1_resume.py`
    - 证据文件：`.sisyphus/evidence/task-7-ws-resume.txt`
  - 流式聊天 token/done + interrupt：`server/tests/test_ws_v1_chat_stream.py`
- Beta QA Runner（只要求 dry-run 行为）：
  - 命令口径：`./scripts/qa_beta.sh --dry-run`
  - 预期：打印 step 清单（见脚本内 `STEP_NAMES/STEP_CMDS`），不启动服务、不修改任何服务状态。
