# Decisions

## 2026-02-13 Locked
- Windows 优先
- 邮箱 + 密码登录
- Contract-first：OpenAPI + 生成 SDK；WS 单独协议与 Schema
- 测试：TDD
- 内测 Alpha：不做支付；但隐私/安全基线必须显式落地

## 2026-02-14 Task 16 Assistant（Client）
- 助手能力默认关闭；闲置关怀（打扰型）子开关也默认关闭。
- 剪贴板文本不写日志；如需调试只允许记录长度（本任务实现中不输出任何剪贴板日志）。
- 事件调用走 main 进程 `fetchAuthedJson`（renderer 不直接接触 token），并用 IPC 主动推送 suggestion 到 renderer。
