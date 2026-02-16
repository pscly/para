import { JsonEditorCard } from "../components/JsonEditorCard";
import { adminConfigGetPrompts, adminConfigPutPrompts } from "../lib/api";
import { loadAdminSession } from "../lib/auth";

export function PromptsPage() {
  const session = loadAdminSession();
  const canEdit = session?.role === "super_admin";

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h1">Prompts</h1>
        <div className="sub">全局 prompts 配置（operator 只读，super_admin 可保存）</div>
      </div>

      <JsonEditorCard
        title="prompts"
        helpText="后端存储的是任意 JSON object，会被原样透传与保存（不做 schema 约束）。"
        canEdit={canEdit}
        readOnlyHint={
          <>
            当前账号为 <code>operator</code>，仅可读取。保存需要 <code>super_admin</code>（Requires super_admin）。
          </>
        }
        load={adminConfigGetPrompts}
        save={adminConfigPutPrompts}
      />
    </div>
  );
}
