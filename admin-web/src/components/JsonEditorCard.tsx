import { type ReactNode, useEffect, useMemo, useState } from "react";

import { ApiError } from "../lib/api";

type JsonObject = Record<string, unknown>;

type ParsedJson =
  | {
      ok: true;
      obj: JsonObject;
    }
  | {
      ok: false;
      error: string;
    };

function prettyJson(obj: JsonObject): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function isPlainJsonObject(v: unknown): v is JsonObject {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

export type JsonEditorCardProps = {
  title: string;
  helpText?: string;
  canEdit: boolean;
  readOnlyHint?: ReactNode;
  load: () => Promise<JsonObject>;
  save: (payloadObj: JsonObject) => Promise<JsonObject>;
};

export function JsonEditorCard(props: JsonEditorCardProps) {
  const { title, helpText, canEdit, readOnlyHint, load, save } = props;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const [remoteText, setRemoteText] = useState<string>("");
  const [text, setText] = useState<string>("");

  const dirty = useMemo(() => {
    if (loading) return false;
    if (!remoteText) return false;
    return text !== remoteText;
  }, [loading, remoteText, text]);

  const parsed: ParsedJson = useMemo(() => {
    const raw = text;
    if (!raw.trim()) {
      return { ok: false, error: "JSON 语法错误" };
    }
    try {
      const val = JSON.parse(raw) as unknown;
      if (!isPlainJsonObject(val)) {
        return { ok: false, error: "必须是 JSON 对象" };
      }
      return { ok: true, obj: val };
    } catch {
      return { ok: false, error: "JSON 语法错误" };
    }
  }, [text]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoading(true);
      setError(null);
      setSavedMsg(null);
      try {
        const obj = await load();
        if (cancelled) return;
        const pretty = prettyJson(obj ?? {});
        setRemoteText(pretty);
        setText(pretty);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError("拉取失败，请稍后重试");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const saveDisabled =
    loading || saving || !canEdit || !remoteText || !dirty || (parsed.ok ? false : true);
  const resetDisabled = loading || saving || !remoteText || !dirty;

  return (
    <section className="card">
      <div className="card-title">{title}</div>
      {helpText ? <div className="p">{helpText}</div> : null}

      {!canEdit ? (
        <div className="alert alert--warn" style={{ marginTop: 12 }}>
          {readOnlyHint ?? (
            <>
              当前账号仅可读取。保存需要 <code>super_admin</code>（Requires super_admin）。
            </>
          )}
        </div>
      ) : null}

      {error ? (
        <div className="alert alert--danger" style={{ marginTop: 12 }}>
          {error}
        </div>
      ) : null}

      {savedMsg ? (
        <div className="alert alert--success" style={{ marginTop: 12 }}>
          {savedMsg}
        </div>
      ) : null}

      {!loading && remoteText ? (
        <div className="json-editor-status" style={{ marginTop: 12 }}>
          <span className={parsed.ok ? "muted" : "json-editor-err"}>
            {parsed.ok ? (dirty ? "存在未保存更改" : "与后端一致") : parsed.error}
          </span>
        </div>
      ) : null}

      <div className="divider" style={{ marginTop: 12, marginBottom: 12 }} />

      <textarea
        className={
          "json-editor" +
          (parsed.ok ? "" : " json-editor--invalid") +
          (!canEdit ? " json-editor--readonly" : "")
        }
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSavedMsg(null);
          setError(null);
        }}
        readOnly={!canEdit}
        disabled={loading || saving || !remoteText}
        aria-invalid={!parsed.ok}
        autoCapitalize="off"
        autoCorrect="off"
      />

      {dirty ? (
        <details className="json-diff" style={{ marginTop: 12 }}>
          <summary className="json-summary">查看差异（远端 / 本地）</summary>
          <div className="json-diff-grid">
            <div>
              <div className="muted">远端（last loaded）</div>
              <pre className="json-pre json-pre--diff">{remoteText}</pre>
            </div>
            <div>
              <div className="muted">本地（current）</div>
              <pre className="json-pre json-pre--diff">{text}</pre>
            </div>
          </div>
        </details>
      ) : null}

      <div className="actions">
        <div className="actions-left">{loading ? <span className="muted">加载中...</span> : null}</div>
        <div className="actions-right">
          <button
            className="btn btn--ghost"
            type="button"
            disabled={loading || saving || !remoteText || !canEdit || !parsed.ok}
            onClick={() => {
              if (!remoteText) return;
              if (!parsed.ok) return;
              setText(prettyJson(parsed.obj));
              setSavedMsg(null);
              setError(null);
            }}
          >
            格式化
          </button>
          <button
            className="btn btn--ghost"
            type="button"
            disabled={resetDisabled || !canEdit}
            onClick={() => {
              setText(remoteText);
              setSavedMsg(null);
              setError(null);
            }}
          >
            重置
          </button>
          <button
            className="btn btn--primary"
            type="button"
            disabled={saveDisabled}
            onClick={async () => {
              if (!parsed.ok) return;
              setSaving(true);
              setError(null);
              setSavedMsg(null);
              try {
                const next = await save(parsed.obj);
                const pretty = prettyJson(next ?? {});
                setRemoteText(pretty);
                setText(pretty);
                setSavedMsg("已保存");
              } catch (err) {
                if (err instanceof ApiError) {
                  setError(err.message);
                } else {
                  setError("保存失败，请稍后重试");
                }
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </section>
  );
}
