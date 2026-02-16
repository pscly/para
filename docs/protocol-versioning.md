# 协议版本策略冻结（HTTP / WS）

本文件用于冻结三套“互相独立但需要协同”的版本维度，并明确：WS v1 作为现行协议必须保持稳定；WS v2 只允许作为未来计划存在，禁止混入 v1 的冻结范围。

## 三套版本维度（必须避免混淆）

### 1) 应用版本（Repo release semver）

- 定义：仓库发布版本（SemVer：`Major.Minor.Patch`）。
- 用途：面向用户/发布渠道（桌面端/服务端打包与发布）。
- 注意：应用版本不等于 HTTP/WS 的协议版本；可以在不改协议的情况下发布应用补丁版本。

### 2) HTTP API 版本（/api/v1 + OpenAPI）

- 定义：HTTP 路由以 `/api/v1` 为前缀；合同工件为 `contracts/openapi.json`。
- 真相来源：`contracts/openapi.json`（其中 `openapi=3.1.0`，`info.version=0.1.0`）。
- 生成/漂移检查：
  - 生成脚本：`scripts/generate-contracts.sh`
    - 导出 OpenAPI：`(cd server && uv run python -m app.scripts.export_openapi --output ../contracts/openapi.json)`
    - 生成 TS：`npm -C client run gen:api`（输出到 `client/src/gen/*`）
  - drift check：`./scripts/generate-contracts.sh --check`
    - 脚本会在生成前后比较 `git status --porcelain -- contracts/openapi.json client/src/gen`，若发生变化则失败。
  - CI/本地一键验收入口：`scripts/ci.sh`（第一步即执行合同漂移检查）。

#### HTTP v1 的冻结规则

- `/api/v1` 内禁止 breaking changes：
  - 删除/重命名 endpoint
  - 删除/重命名响应字段
  - 收紧校验导致既有合法请求变非法（例如把可空改为必填）
- v1 内允许的兼容演进（推荐）：
  - 新增 endpoint
  - 在响应里新增可忽略字段
  - 新增可选 query/body 字段（提供默认值且不改变既有语义）
- 如必须做 breaking change：创建 `/api/v2`（不在本次 0.1 Beta 交付范围）。

### 3) WS 协议版本（/ws/v1 + PROTOCOL_VERSION=1）

- 定义：WebSocket endpoint 固定为 `/ws/v1`；服务端协议常量为 `server/app/ws/v1.py` 中的 `PROTOCOL_VERSION = 1`。
- 真相来源：
  - 服务端：`server/app/ws/v1.py`
  - 客户端：`client/src/main/index.ts`
  - 协议证据（pytest）：`server/tests/test_ws_v1_resume.py`、`server/tests/test_ws_v1_chat_stream.py`

## WS v1：冻结字段与语义（现行协议）

### 连接与鉴权

- endpoint：`/ws/v1`
- query：
  - `save_id`: string（必须）
  - `resume_from`: int（必须，且 `>= 0`）
- header：
  - `Authorization: Bearer <access_token>`（必须）

服务端行为（见 `server/app/ws/v1.py`）：

- 缺少参数/参数非法/未授权时：关闭连接（例如使用 close code `1008`）。
- 客户端发送非法 JSON 或结构不符合预期时：关闭连接（例如 close code `1003`）。

### 帧结构（WSFrame）

服务端发送的每一帧固定包含以下字段（见 `server/app/ws/v1.py` 的 `WSFrame`）：

```json
{
  "protocol_version": 1,
  "type": "<string>",
  "seq": 0,
  "cursor": 0,
  "server_event_id": null,
  "ack_required": false,
  "payload": null
}
```

字段含义（v1 冻结）：

- `protocol_version`：必须为整数 `1`。
- `type`：帧类型字符串。
- `seq`：序号。
  - 控制帧固定为 `0`
  - 可回放事件帧必须为 `>= 1`
- `cursor`：v1 中为整数，当前服务端实现中事件帧的 `cursor == seq`。
- `server_event_id`：事件唯一标识。
  - 控制帧为 `null`
  - 事件帧为非空字符串（当前格式：`"{user_id}:{save_id}:{seq}"`）
- `ack_required`：是否要求客户端 ACK。
  - 控制帧固定为 `false`
  - 事件帧可能为 `true`
- `payload`：JSON 值（可以是 object / array / string / number / boolean / null）。

### 控制帧与事件帧

- 控制帧：`seq=0` 且 `server_event_id=null`（例如 `HELLO`、`PONG`）。
- 事件帧：`seq>=1` 且 `server_event_id` 为非空字符串（例如 `EVENT`、`CHAT_TOKEN`、`CHAT_DONE`）。

### HELLO（服务端 -> 客户端）

连接建立后，服务端首先发送 `HELLO` 控制帧（见 `server/app/ws/v1.py`）：

- `type="HELLO"`
- `cursor=<last_acked_seq>`
- `payload={"user_id": "...", "save_id": "..."}`

### resume_from（重连回放）

重连时，服务端会回放 `seq > resume_from` 的历史事件帧（顺序单调递增）。

可执行证据：`server/tests/test_ws_v1_resume.py`

- 断言：两次连接收到的 `seq` 严格连续（从 1 开始），且第二次从 `resume_from + 1` 开始。
- 断言：两次连接收到的 `server_event_id` 集合不相交。
- 证据落盘：`.sisyphus/evidence/task-7-ws-resume.txt`

### ACK（客户端 -> 服务端）

客户端可以发送：

```json
{ "type": "ACK", "cursor": 123 }
```

服务端行为（见 `server/app/ws/v1.py`）：

- 若 `cursor` 不是 int，则尝试读取 `seq` 字段。
- 对合法 int cursor：更新 `last_acked_seq`（单调递增，且会被“当前已存在最大 seq”做上界约束）。

客户端 ACK 规则真相来源：`client/src/main/index.ts`

- 仅当收到帧满足：`server_event_id!=null` 且 `seq>=1` 且 `ack_required===true` 时，才自动发送 ACK。
- ACK 内容：`{"type":"ACK","cursor":<lastReceivedSeq>}`，其中 `lastReceivedSeq` 来自客户端对收到帧 `seq` 的追踪。

### PING/PONG（保活）

- 客户端发送：`{"type":"PING","payload":<any json>}`
- 服务端回复：`type="PONG"`，并携带当前 `cursor=<last_acked_seq>`，且 `payload` 回显客户端 payload（见 `server/app/ws/v1.py`）。

### CHAT_SEND / CHAT_TOKEN / CHAT_DONE / INTERRUPT（最小流式聊天）

客户端请求（见 `server/app/ws/v1.py` 与 `client/src/main/index.ts`）：

```json
{
  "type": "CHAT_SEND",
  "payload": { "text": "hello" },
  "client_request_id": "<optional string>"
}
```

服务端输出（事件帧，均可回放，且 `ack_required=true`）：

- `type="CHAT_TOKEN"`，`payload={"token": "...", "client_request_id": "..."}`
- `type="CHAT_DONE"`，`payload={"interrupted": false|true, "client_request_id": "..."}`

中断：客户端发送 `{"type":"INTERRUPT"}`，服务端最终应发送 `CHAT_DONE.payload.interrupted=true`。

可执行证据：`server/tests/test_ws_v1_chat_stream.py`

- 用例 1：至少收到 1 条 `CHAT_TOKEN`，最终收到 `CHAT_DONE` 且 `interrupted=false`
- 用例 2：收到首条 `CHAT_TOKEN` 后发送 `INTERRUPT`，最终 `CHAT_DONE.interrupted=true`

## WS v1 的兼容性规则（冻结要求）

v1 一旦冻结，后续变更必须遵守：

- 禁止变更/删除 v1 的必选字段与语义：`protocol_version/type/seq/cursor/server_event_id/ack_required/payload`。
- 禁止改变 `ACK`、`resume_from` 的含义（否则客户端重连与证据测试会失效）。
- 允许的兼容演进（谨慎）：
  - 在 `payload` 内新增字段（客户端应忽略未知字段）。
  - 新增全新 `type`（但不得复用旧 type 的语义）。

如需做不兼容变更：新增 `/ws/v2` + `PROTOCOL_VERSION=2`，并保留 `/ws/v1`。

## WS v2（Future，仅计划，不混入 v1 冻结）

以下仅为计划方向，明确不在 v1 中“渐进混入”：

### 1) device cursor（按设备 ACK 与重放语义）

- 目标：解决多设备/多连接并发下 cursor/ACK 语义不清的问题。
- 方向：
  - 在握手（例如 `HELLO`/`AUTH`）中引入 `device_id` 概念。
  - ACK 状态按 `(user_id, save_id, device_id)` 维护，避免设备间相互推进。
  - 引入 lease/TTL，避免僵尸设备阻塞裁剪。

### 2) opaque cursor（不可推断的游标）

- 目标：cursor 不再暴露内部递增序号，支持更灵活的存储/分片/裁剪策略。
- 方向：
  - `cursor` 从 `int` 演进为 `string`（opaque token）。
  - `resume_from` 的类型与语义相应演进（例如 `resume_from=<opaque>` 或改为 header/帧字段）。

### 迁移策略

- `/ws/v2` 新 endpoint 新语义；`/ws/v1` 保持冻结不动。
- 客户端按版本显式选择连接，不做“自动猜测”。
