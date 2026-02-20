export type ThemePreference = 'system' | 'light' | 'dark';

const THEME_PREFERENCE_STORAGE_KEY = 'para.themePreference' as const;

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function getThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';

  try {
    const raw = window.localStorage.getItem(THEME_PREFERENCE_STORAGE_KEY);
    if (isThemePreference(raw)) return raw;
  } catch {
  }

  return 'system';
}

export function setThemePreference(pref: ThemePreference): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, pref);
  } catch {
  }
}

export function applyThemePreference(pref: ThemePreference): void {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  if (!root) return;

  if (pref === 'system') {
    root.removeAttribute('data-theme');
    return;
  }

  root.setAttribute('data-theme', pref);
}

let systemMql: MediaQueryList | null = null;
let systemUnsub: (() => void) | null = null;

function cleanupSystemListener() {
  if (!systemMql || !systemUnsub) return;
  try {
    systemUnsub();
  } catch {
  }
  systemMql = null;
  systemUnsub = null;
}

function setupSystemListener() {
  if (typeof window === 'undefined') return;
  if (typeof window.matchMedia !== 'function') return;

  const mql = window.matchMedia('(prefers-color-scheme: light)');
  const handler = () => {
    if (getThemePreference() !== 'system') return;
    applyThemePreference('system');
  };

  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', handler);
    systemMql = mql;
    systemUnsub = () => mql.removeEventListener('change', handler);
    return;
  }

  const legacy = mql as unknown as {
    addListener?: (cb: () => void) => void;
    removeListener?: (cb: () => void) => void;
  };
  if (typeof legacy.addListener === 'function' && typeof legacy.removeListener === 'function') {
    legacy.addListener(handler);
    systemMql = mql;
    systemUnsub = () => legacy.removeListener?.(handler);
  }
}

export function initTheme(): void {
  cleanupSystemListener();
  const pref = getThemePreference();
  applyThemePreference(pref);
  if (pref === 'system') setupSystemListener();
}
