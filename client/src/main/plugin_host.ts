import fs from 'node:fs/promises';
import vm from 'node:vm';

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

type HostRuntime = {
  pluginId: string;
  version: string;
  entryPath: string;
  context: vm.Context;
  menuClickHandlers: Record<string, unknown>;
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
let runtime: HostRuntime | null = null;

function makeMenuClickScriptSource(id: string): string {
  const idLiteral = JSON.stringify(id);
  return `(() => {
  const fn = __menuClickHandlers[${idLiteral}];
  if (typeof fn !== 'function') return false;
  fn();
  return true;
})()`;
}

function handleMenuClick(cmd: Extract<HostCmd, { type: 'menu:click' }>): void {
  const requestId = clipText(safeString(cmd.requestId), 80);
  if (!requestId) return;

  if (!runtime) {
    send({ type: 'menu:click:result', requestId, ok: false, error: 'NOT_LOADED' });
    return;
  }
  if (safeString(cmd.pluginId).trim() !== runtime.pluginId) {
    send({ type: 'menu:click:result', requestId, ok: false, error: 'PLUGIN_MISMATCH' });
    return;
  }

  const id = clipText(safeString(cmd.id), MENU_ID_MAX_CHARS);
  if (!id) {
    send({ type: 'menu:click:result', requestId, ok: false, error: 'INVALID_MENU_ID' });
    return;
  }

  try {
    const script = new vm.Script(makeMenuClickScriptSource(id), { filename: '<plugin_menu_click>' });
    const ret = script.runInContext(runtime.context, { timeout: MENU_CLICK_TIMEOUT_MS });
    if (ret === true) {
      send({ type: 'menu:click:result', requestId, ok: true });
    } else {
      send({ type: 'menu:click:result', requestId, ok: false, error: 'NO_HANDLER' });
    }
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
  const menuClickHandlers: Record<string, unknown> = Object.create(null);
  let menuClickHandlerCount = 0;

  const api = {
    say: (text: unknown) => {
      const clipped = clipText(safeString(text), SAY_MAX_CHARS);
      if (!clipped) return;
      send({ type: 'say', pluginId, text: clipped });
    },
    suggestion: (text: unknown) => {
      const clipped = clipText(safeString(text), SUGGESTION_MAX_CHARS);
      if (!clipped) return;
      send({ type: 'suggestion', pluginId, text: clipped });
    },
    addMenuItem: (payload: unknown) => {
      if (menuCount >= MENU_ITEMS_MAX) return;
      if (!isObjectRecord(payload)) return;
      const id = clipText(safeString(payload.id), MENU_ID_MAX_CHARS);
      const label = clipText(safeString(payload.label), MENU_LABEL_MAX_CHARS);
      if (!id || !label) return;

      menuCount += 1;
      send({ type: 'menu:add', pluginId, item: { id, label } });
    },
    onMenuClick: (idRaw: unknown, handler: unknown) => {
      if (menuClickHandlerCount >= MENU_ITEMS_MAX) return;
      const id = clipText(safeString(idRaw), MENU_ID_MAX_CHARS);
      if (!id) return;
      if (typeof handler !== 'function') return;
      if (!Object.prototype.hasOwnProperty.call(menuClickHandlers, id)) {
        menuClickHandlerCount += 1;
      }
      menuClickHandlers[id] = handler;
    }
  };

  const sandbox: Record<string, unknown> = {
    say: api.say,
    suggestion: api.suggestion,
    addMenuItem: api.addMenuItem,
    onMenuClick: api.onMenuClick,
    __menuClickHandlers: menuClickHandlers,
    console: {
      log: () => {},
      info: () => {},
      warn: () => {},
      error: () => {}
    },
    exports: {},
    module: { exports: {} }
  };

  let context: vm.Context;
  try {
    context = vm.createContext(sandbox, {
      name: `plugin:${pluginId}@${version}`,
      codeGeneration: { strings: false, wasm: false }
    });
  } catch {
    context = vm.createContext(sandbox);
  }

  runtime = {
    pluginId,
    version,
    entryPath,
    context,
    menuClickHandlers
  };

  try {
    const script = new vm.Script(codeText, { filename: entryPath });
    script.runInContext(context, { timeout: SYNC_EVAL_TIMEOUT_MS });
  } catch {
    send({ type: 'error', message: 'VM_EXEC_FAILED' });
  }
}

process.on('message', (raw: unknown) => {
  if (!isObjectRecord(raw)) return;
  const type = raw.type;
  if (type === 'shutdown') {
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
