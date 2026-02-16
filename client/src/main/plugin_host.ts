import fs from 'node:fs/promises';
import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from 'quickjs-emscripten';

type HostCmd =
  | {
      type: 'load';
      pluginId: string;
      version: string;
      entryPath: string;
      permissions: unknown;
    }
  | {
      type: 'menu:click';
      pluginId: string;
      id: string;
      requestId: string;
    }
  | { type: 'shutdown' };

type HostMsg =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'menu:add'; pluginId: string; item: { id: string; label: string } }
  | { type: 'say'; pluginId: string; text: string }
  | { type: 'suggestion'; pluginId: string; text: string }
  | {
      type: 'menu:click:result';
      requestId: string;
      ok: boolean;
      error?: string;
    };

const SAY_MAX_CHARS = 200;
const SUGGESTION_MAX_CHARS = 200;
const MENU_ITEMS_MAX = 10;
const MENU_ID_MAX_CHARS = 80;
const MENU_LABEL_MAX_CHARS = 80;
const SYNC_EVAL_TIMEOUT_MS = 1000;
const MENU_CLICK_TIMEOUT_MS = 400;

const PLUGIN_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const PLUGIN_STACK_LIMIT_BYTES = 512 * 1024;

type HostRuntime = {
  pluginId: string;
  version: string;
  entryPath: string;
  qjs: QuickJSWASMModule;
  runtime: QuickJSRuntime;
  context: QuickJSContext;
  menuClickHandlers: Map<string, QuickJSHandle>;
  menuClickHandlerCount: number;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPermissionsValue(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (isObjectRecord(value)) return true;
  return false;
}

function safeString(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value;
}

function clipText(text: string, maxChars: number): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars);
}

function send(msg: HostMsg): void {
  try {
    process.send?.(msg);
  } catch {
  }
}

let loadedOnce = false;
let hostRuntime: HostRuntime | null = null;

let quickjsSingleton: Promise<QuickJSWASMModule> | null = null;
function getQuickJSSingleton(): Promise<QuickJSWASMModule> {
  if (!quickjsSingleton) quickjsSingleton = getQuickJS();
  return quickjsSingleton;
}

function safeGetStringFromHandle(ctx: QuickJSContext, handle: QuickJSHandle): string {
  try {
    if (ctx.typeof(handle) !== 'string') return '';
    return ctx.getString(handle);
  } catch {
    return '';
  }
}

function runWithTimeout<T>(rt: QuickJSRuntime, timeoutMs: number, fn: () => T): T {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  rt.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  try {
    return fn();
  } finally {
    rt.removeInterruptHandler();
  }
}

function drainPendingJobs(rt: QuickJSRuntime): void {
  const maxTotalJobs = 64;
  let remaining = maxTotalJobs;
  while (remaining > 0) {
    const res = rt.executePendingJobs(1);
    try {
      if (res.error) {
        return;
      }
      const ran = typeof res.value === 'number' ? res.value : 0;
      if (ran <= 0) return;
      remaining -= 1;
    } finally {
      try {
        res.dispose();
      } catch {
      }
    }
  }
}

function handleMenuClick(cmd: Extract<HostCmd, { type: 'menu:click' }>): void {
  const requestId = clipText(safeString(cmd.requestId), 80);
  if (!requestId) return;

  const rt = hostRuntime;
  if (!rt) {
    send({ type: 'menu:click:result', requestId, ok: false, error: 'NOT_LOADED' });
    return;
  }
  if (safeString(cmd.pluginId).trim() !== rt.pluginId) {
    send({ type: 'menu:click:result', requestId, ok: false, error: 'PLUGIN_MISMATCH' });
    return;
  }

  const id = clipText(safeString(cmd.id), MENU_ID_MAX_CHARS);
  if (!id) {
    send({ type: 'menu:click:result', requestId, ok: false, error: 'INVALID_MENU_ID' });
    return;
  }

  const handler = rt.menuClickHandlers.get(id);
  if (!handler) {
    send({ type: 'menu:click:result', requestId, ok: false, error: 'NO_HANDLER' });
    return;
  }

  try {
    runWithTimeout(rt.runtime, MENU_CLICK_TIMEOUT_MS, () => {
      const result = rt.context.callFunction(handler, rt.context.undefined);
      try {
        if (result.error) {
          throw new Error('MENU_CLICK_THROW');
        }
      } finally {
        try {
          result.dispose();
        } catch {
        }
      }

      drainPendingJobs(rt.runtime);
    });

    send({ type: 'menu:click:result', requestId, ok: true });
  } catch {
    send({ type: 'menu:click:result', requestId, ok: false, error: 'MENU_CLICK_FAILED' });
  }
}

async function handleLoad(cmd: Extract<HostCmd, { type: 'load' }>): Promise<void> {
  if (loadedOnce) return;
  loadedOnce = true;

  const pluginId = safeString(cmd.pluginId).trim();
  const version = safeString(cmd.version).trim();
  const entryPath = safeString(cmd.entryPath).trim();
  if (!pluginId || !version || !entryPath) {
    send({ type: 'error', message: 'INVALID_LOAD_CMD' });
    return;
  }
  if (!isPermissionsValue(cmd.permissions)) {
    send({ type: 'error', message: 'PERMISSIONS_REQUIRED' });
    return;
  }

  let codeText = '';
  try {
    codeText = await fs.readFile(entryPath, { encoding: 'utf8' });
  } catch {
    send({ type: 'error', message: 'ENTRY_READ_FAILED' });
    return;
  }

  let menuCount = 0;
  const menuClickHandlers = new Map<string, QuickJSHandle>();
  let menuClickHandlerCount = 0;

  let qjs: QuickJSWASMModule;
  try {
    qjs = await getQuickJSSingleton();
  } catch {
    send({ type: 'error', message: 'QJS_INIT_FAILED' });
    return;
  }

  const qjsRuntime = qjs.newRuntime();
  qjsRuntime.setMemoryLimit(PLUGIN_MEMORY_LIMIT_BYTES);
  qjsRuntime.setMaxStackSize(PLUGIN_STACK_LIMIT_BYTES);
  const qjsContext = qjsRuntime.newContext();

  qjsContext
    .newFunction('say', (textHandle) => {
      const text = safeGetStringFromHandle(qjsContext, textHandle);
      const clipped = clipText(text, SAY_MAX_CHARS);
      if (clipped) send({ type: 'say', pluginId, text: clipped });
      return qjsContext.undefined;
    })
    .consume((fn) => qjsContext.setProp(qjsContext.global, 'say', fn));

  qjsContext
    .newFunction('suggestion', (textHandle) => {
      const text = safeGetStringFromHandle(qjsContext, textHandle);
      const clipped = clipText(text, SUGGESTION_MAX_CHARS);
      if (clipped) send({ type: 'suggestion', pluginId, text: clipped });
      return qjsContext.undefined;
    })
    .consume((fn) => qjsContext.setProp(qjsContext.global, 'suggestion', fn));

  qjsContext
    .newFunction('addMenuItem', (payloadHandle) => {
      if (menuCount >= MENU_ITEMS_MAX) return qjsContext.undefined;
      let dumped: unknown;
      try {
        dumped = qjsContext.dump(payloadHandle);
      } catch {
        return qjsContext.undefined;
      }
      if (!isObjectRecord(dumped)) return qjsContext.undefined;
      const id = clipText(safeString((dumped as Record<string, unknown>).id), MENU_ID_MAX_CHARS);
      const label = clipText(safeString((dumped as Record<string, unknown>).label), MENU_LABEL_MAX_CHARS);
      if (!id || !label) return qjsContext.undefined;

      menuCount += 1;
      send({ type: 'menu:add', pluginId, item: { id, label } });
      return qjsContext.undefined;
    })
    .consume((fn) => qjsContext.setProp(qjsContext.global, 'addMenuItem', fn));

  qjsContext
    .newFunction('onMenuClick', (idHandle, handlerHandle) => {
      const id = clipText(safeGetStringFromHandle(qjsContext, idHandle), MENU_ID_MAX_CHARS);
      if (!id) return qjsContext.undefined;
      if (qjsContext.typeof(handlerHandle) !== 'function') return qjsContext.undefined;

      const hasExisting = menuClickHandlers.has(id);
      if (!hasExisting && menuClickHandlerCount >= MENU_ITEMS_MAX) return qjsContext.undefined;

      const existing = menuClickHandlers.get(id);
      if (existing) {
        try {
          existing.dispose();
        } catch {
        }
      }

      menuClickHandlers.set(id, handlerHandle.dup());
      if (!hasExisting) menuClickHandlerCount += 1;
      return qjsContext.undefined;
    })
    .consume((fn) => qjsContext.setProp(qjsContext.global, 'onMenuClick', fn));

  const consoleObj = qjsContext.newObject();
  qjsContext
    .newFunction('log', () => qjsContext.undefined)
    .consume((fn) => qjsContext.setProp(consoleObj, 'log', fn));
  qjsContext
    .newFunction('info', () => qjsContext.undefined)
    .consume((fn) => qjsContext.setProp(consoleObj, 'info', fn));
  qjsContext
    .newFunction('warn', () => qjsContext.undefined)
    .consume((fn) => qjsContext.setProp(consoleObj, 'warn', fn));
  qjsContext
    .newFunction('error', () => qjsContext.undefined)
    .consume((fn) => qjsContext.setProp(consoleObj, 'error', fn));
  qjsContext.setProp(qjsContext.global, 'console', consoleObj);
  consoleObj.dispose();

  const exportsObj = qjsContext.newObject();
  const moduleObj = qjsContext.newObject();
  qjsContext.setProp(moduleObj, 'exports', exportsObj);
  qjsContext.setProp(qjsContext.global, 'exports', exportsObj);
  qjsContext.setProp(qjsContext.global, 'module', moduleObj);
  exportsObj.dispose();
  moduleObj.dispose();

  hostRuntime = {
    pluginId,
    version,
    entryPath,
    qjs,
    runtime: qjsRuntime,
    context: qjsContext,
    menuClickHandlers,
    menuClickHandlerCount,
  };

  try {
    runWithTimeout(qjsRuntime, SYNC_EVAL_TIMEOUT_MS, () => {
      const result = qjsContext.evalCode(codeText, entryPath, { type: 'global' });
      try {
        if (result.error) {
          throw new Error('PLUGIN_EXEC_ERROR');
        }
      } finally {
        try {
          result.dispose();
        } catch {
        }
      }

      drainPendingJobs(qjsRuntime);
    });
  } catch {
    send({ type: 'error', message: 'VM_EXEC_FAILED' });
  }
}

function disposeHostRuntime(): void {
  const rt = hostRuntime;
  hostRuntime = null;
  if (!rt) return;

  for (const handle of rt.menuClickHandlers.values()) {
    try {
      handle.dispose();
    } catch {
    }
  }
  rt.menuClickHandlers.clear();

  try {
    rt.context.dispose();
  } catch {
  }
  try {
    rt.runtime.dispose();
  } catch {
  }
}

process.on('message', (raw: unknown) => {
  if (!isObjectRecord(raw)) return;
  const type = raw.type;
  if (type === 'shutdown') {
    disposeHostRuntime();
    process.exit(0);
  }
  if (type === 'load') {
    void handleLoad(raw as Extract<HostCmd, { type: 'load' }>);
  }
  if (type === 'menu:click') {
    handleMenuClick(raw as Extract<HostCmd, { type: 'menu:click' }>);
  }
});

send({ type: 'ready' });
