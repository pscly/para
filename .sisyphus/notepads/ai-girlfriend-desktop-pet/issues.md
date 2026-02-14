# Issues

## 2026-02-13 Tooling
- `rg` 不存在：后续搜索改用 `functions.grep` 工具或安装 ripgrep。
- `pnpm` 不存在：前端包管理先用 npm（或后续统一安装 pnpm）。
- `ast-grep` CLI 不存在：使用内置 `ast_grep_search`/`ast_grep_replace` 工具。

## 2026-02-14 LSP
- `lsp_diagnostics` for `.yml` requires `yaml-language-server` (installed globally via npm in this environment).

## 2026-02-14 Compose UX
- If `COMPOSE_PROJECT_NAME` is set via `--env-file`, remember to include the same `--env-file` for `docker compose ps/logs/exec` when verifying.

## 2026-02-14 Unexpected plan.md diff
- `plan.md` 当前有大量非预期文案变更（UI/UX 设计段落等）。在用户确认前，不要把该文件纳入任何提交。

## 2026-02-14 Pytest import path
- `uv run pytest` may fail with `ModuleNotFoundError: app` because `sys.path[0]` points to `.venv/bin`.
- Workaround: add `server/tests/conftest.py` to insert the project root into `sys.path` before importing test modules.

## 2026-02-14 Electron binary download
- 直接 `npm install electron` 可能在下载 Electron release 时出现 `socket hang up`/`server aborted pending request`。
- 解决：安装命令前追加 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，让 `electron/install.js` 走镜像源。

## 2026-02-14 npm audit
- `npm -C client install` reports moderate vulnerabilities. Not addressed in this task (would require dependency upgrades).

## 2026-02-14 Electron main WebSocket (Task 8 e2e)
- Playwright 的 `electronApplication.evaluate()` 运行在主进程 global 作用域，不一定能拿到 CommonJS 的 `require`/`process.mainModule`；测试里的 require-based WS polyfill 可能直接失败（`REQUIRE_UNAVAILABLE`）。
- 解决：在 `client/src/main/index.ts` 启动时主动把可用 WebSocket 实现挂到 `globalThis.WebSocket`（本次用 `ws` 包），并保证支持 `{ headers }`，从而继续走 `Authorization` header（不把 token 放进 query）。

## 2026-02-14 Task 9 Auth 依赖复用
- `server/app/api/v1/saves.py` 与 `server/app/api/v1/personas.py` 目前各自复制了一份 Bearer JWT 解码逻辑（与 `auth.py` 类似），后续可以抽成公共依赖（例如 `server/app/api/v1/deps.py`）以减少重复。

## 2026-02-14 Electron 多窗口定位
- `BrowserWindow` 的 title 可能被页面 `document.title` 覆盖，因此在 Playwright 的 `app.evaluate` 中用 `getTitle()==='桌宠'` 定位桌宠窗口不可靠；更稳妥是用 `getBounds()` 面积/宽高选择。

## 2026-02-14 Task 11 pgvector
- 当前实现为了“最小可用 + 可测”，在每个 memory API 请求里都会尝试执行一次 `CREATE EXTENSION IF NOT EXISTS vector` 并 `commit()`；功能没问题，但属于偏重的运行时操作，后续更合理做法是迁移/启动时确保一次性启用。

## 2026-02-14 Task 12 Celery + WS
- 当前 WS 事件日志是 API 进程内内存数据结构；Celery worker 若作为独立进程运行，写入同一份 events log 不成立。本轮以 eager 测试模式验证闭环，后续需要引入 Redis/DB 事件存储或 push 通道。

## 2026-02-14 Task 11 pgvector 距离表达式类型推断
- `embedding <-> query_vector` 在 SQLAlchemy 里如果不显式 cast，返回列可能会被套用向量列的 result processor，导致把 float 距离当 vector 解析而报错；解决：对距离表达式 `.cast(Float)`。

## 2026-02-14 FastAPI multipart 依赖
- 新增 `UploadFile`/`Form` 的 endpoint 后，如果缺少 `python-multipart`，FastAPI 会在 import/路由注册阶段抛 `RuntimeError: Form data requires "python-multipart"`，导致整个测试收集失败。

## 2026-02-14 Client 拖拽区可访问性
- `div` 上绑定 drag/drop 事件容易触发可访问性/静态交互 lint（例如提示 role=button 时应直接用 `<button>`）；在不影响测试选择器的前提下，优先使用 `<button type="button">` 作为 dropzone 容器。
