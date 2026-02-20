export const DESKTOP_API_UNAVAILABLE = 'DESKTOP_API_UNAVAILABLE' as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function getDesktopApi(): Window['desktopApi'] | null {
  if (typeof window === 'undefined') return null;
  return window.desktopApi ?? null;
}

export function requireDesktopApi(): NonNullable<Window['desktopApi']> {
  const api = getDesktopApi();
  if (!api) throw new Error(DESKTOP_API_UNAVAILABLE);
  return api;
}

export function getUnsubscribe(ret: unknown): (() => void) | null {
  if (typeof ret === 'function') return ret as () => void;
  if (isRecord(ret) && typeof ret.unsubscribe === 'function') return ret.unsubscribe as () => void;
  return null;
}
