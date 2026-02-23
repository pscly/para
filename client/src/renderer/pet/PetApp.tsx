import React, { useEffect, useId, useRef, useState } from "react";

import { getDesktopApi, getUnsubscribe } from "../services/desktopApi";

type PetAppProps = {
  className?: string;
};

interface ElectronCSS extends React.CSSProperties {
  WebkitAppRegion?: "drag" | "no-drag";
}

type PluginMenuItem = {
  pluginId: string;
  id: string;
  label: string;
};

type PluginOutputPayload = {
  type: "say" | "suggestion";
  text: string;
  pluginId: string;
};

type PetBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function sanitizeTestId(raw: string): string {
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return sanitized.length > 0 ? sanitized : "item";
}

function computeRadialAngles(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [180];

  const startDeg = 55;
  const endDeg = 305;
  const span = (endDeg - startDeg + 360) % 360;
  return Array.from({ length: count }, (_, i) => startDeg + (span * i) / (count - 1));
}

export default function PetApp(props: PetAppProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pluginMenuItems, setPluginMenuItems] = useState<PluginMenuItem[]>([]);
  const [pluginBubble, setPluginBubble] = useState<{
    visible: boolean;
    type: "say" | "suggestion";
    text: string;
    key: number;
  } | null>(null);

  const bubbleTimerRef = useRef<number | null>(null);
  const srId = useId();

  const dragCleanupRef = useRef<(() => void) | null>(null);
  const dragStateRef = useRef<{
    dragging: boolean;
    pointerId: number | null;
    startScreenX: number;
    startScreenY: number;
    lastScreenX: number;
    lastScreenY: number;
    startBounds: PetBounds | null;
    rafId: number | null;
    rafPending: boolean;
  }>({
    dragging: false,
    pointerId: null,
    startScreenX: 0,
    startScreenY: 0,
    lastScreenX: 0,
    lastScreenY: 0,
    startBounds: null,
    rafId: null,
    rafPending: false,
  });

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    };
  }, []);

  useEffect(() => {
    const plugins = getDesktopApi()?.plugins;
    if (!plugins?.onOutput) return;

    const unsubscribe = getUnsubscribe(
      plugins.onOutput((payload: PluginOutputPayload) => {
        if (payload?.type !== "say" && payload?.type !== "suggestion") return;
        const text = typeof payload.text === "string" ? payload.text : "";
        if (!text.trim()) return;

        setPluginBubble({
          visible: true,
          type: payload.type,
          text,
          key: Date.now(),
        });

        if (bubbleTimerRef.current != null) {
          window.clearTimeout(bubbleTimerRef.current);
        }
        bubbleTimerRef.current = window.setTimeout(() => {
          setPluginBubble(null);
          bubbleTimerRef.current = null;
        }, 4200);
      }),
    );

    return () => {
      if (bubbleTimerRef.current != null) {
        window.clearTimeout(bubbleTimerRef.current);
        bubbleTimerRef.current = null;
      }
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) {
      setPluginMenuItems([]);
      return;
    }

    const plugins = getDesktopApi()?.plugins;
    if (!plugins?.getMenuItems) return;

    let cancelled = false;

    const refresh = async () => {
      try {
        const items = await plugins.getMenuItems();
        if (!cancelled) setPluginMenuItems(Array.isArray(items) ? items : []);
      } catch {
        if (!cancelled) setPluginMenuItems([]);
      }
    };

    void refresh();
    const pollId = window.setInterval(refresh, 500);

    return () => {
      cancelled = true;
      window.clearInterval(pollId);
    };
  }, [menuOpen]);

  const pluginAngles = computeRadialAngles(pluginMenuItems.length);

  return (
    <div
      className={props.className}
      style={styles.root}
    >
      <div style={styles.stage}>
        {pluginBubble ? (
          <div
            key={pluginBubble.key}
            data-testid="pet-plugin-bubble"
            aria-live="polite"
            style={{
              ...styles.pluginBubble,
              ...(pluginBubble.type === "suggestion" ? styles.pluginBubbleSuggestion : null),
            }}
          >
            <div data-testid="pet-plugin-bubble-text" style={styles.pluginBubbleText}>
              {pluginBubble.text}
            </div>
          </div>
        ) : null}

        <button
          type="button"
          data-testid="pet-drag-handle"
          aria-label="拖拽移动桌宠"
          style={styles.dragHandle}
          onPointerDown={(e) => {
            if (e.button !== 0) return;

            const pet = getDesktopApi()?.pet;
            if (!pet?.getBounds || !pet?.setBounds) return;

            e.preventDefault();
            e.stopPropagation();

            dragCleanupRef.current?.();

            const state = dragStateRef.current;
            state.dragging = true;
            state.pointerId = e.pointerId;
            state.startScreenX = e.screenX;
            state.startScreenY = e.screenY;
            state.lastScreenX = e.screenX;
            state.lastScreenY = e.screenY;
            state.startBounds = null;
            state.rafPending = false;

            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
            }

            const schedule = () => {
              if (!state.dragging || !state.startBounds) return;
              if (state.rafPending) return;
              state.rafPending = true;

              if (state.rafId != null) {
                window.cancelAnimationFrame(state.rafId);
              }

              state.rafId = window.requestAnimationFrame(() => {
                state.rafPending = false;
                if (!state.dragging || !state.startBounds) return;

                const dx = state.lastScreenX - state.startScreenX;
                const dy = state.lastScreenY - state.startScreenY;
                const next: PetBounds = {
                  x: state.startBounds.x + dx,
                  y: state.startBounds.y + dy,
                  width: state.startBounds.width,
                  height: state.startBounds.height,
                };

                void pet.setBounds(next).catch(() => {});
              });
            };

            const onMove = (ev: PointerEvent) => {
              if (!state.dragging) return;
              if (state.pointerId !== null && ev.pointerId !== state.pointerId) return;
              state.lastScreenX = ev.screenX;
              state.lastScreenY = ev.screenY;
              schedule();
            };

            const end = () => {
              if (!state.dragging) return;
              state.dragging = false;
              state.pointerId = null;
              state.startBounds = null;
              state.rafPending = false;
              if (state.rafId != null) {
                window.cancelAnimationFrame(state.rafId);
                state.rafId = null;
              }

              window.removeEventListener("pointermove", onMove);
              window.removeEventListener("pointerup", end);
              window.removeEventListener("pointercancel", end);
              dragCleanupRef.current = null;
            };

            dragCleanupRef.current = end;
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", end);
            window.addEventListener("pointercancel", end);

            void pet
              .getBounds()
              .then((b) => {
                if (!state.dragging) return;
                if (!b || typeof b.x !== "number" || typeof b.y !== "number") return;
                state.startBounds = b as PetBounds;
                schedule();
              })
              .catch(() => {
                end();
              });
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <span aria-hidden="true" style={styles.dragHandleGrip} />
        </button>

        <button
          type="button"
          data-testid="pet-sprite"
          aria-describedby={srId}
          onClick={() => setMenuOpen((v) => !v)}
          style={styles.spriteButton}
        >
          <span id={srId} style={styles.srOnly}>
            打开/关闭桌宠菜单
          </span>
          <span style={styles.spriteInner} />
        </button>

        <div
          data-testid="pet-radial-menu"
          aria-hidden={!menuOpen}
          style={{
            ...styles.menu,
            display: menuOpen ? "grid" : "none",
          }}
        >
          <div style={styles.menuRing} />

          <button
            type="button"
            data-testid="pet-menu-item-chat"
            style={{
              ...styles.menuItem,
              ...styles.menuItemTop,
            }}
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            聊天
          </button>

          {pluginMenuItems.length > 0 ? (
            <div data-testid="pet-plugin-menu-item" style={styles.pluginMenuItems}>
              {pluginMenuItems.map((item, idx) => {
                const angleDeg = pluginAngles[idx] ?? 180;
                const theta = (angleDeg * Math.PI) / 180;
                const radius = 76;
                const x = Math.sin(theta) * radius;
                const y = -Math.cos(theta) * radius;
                const testId = sanitizeTestId(`${item.pluginId}-${item.id}`);

                return (
                  <button
                    key={`${item.pluginId}:${item.id}`}
                    type="button"
                    data-testid={`pet-plugin-menu-item-${testId}`}
                    title={item.label}
                    style={{
                      ...styles.menuItem,
                      ...styles.pluginMenuItem,
                      left: "50%",
                      top: "50%",
                      transform: `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`,
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpen(false);
                      void getDesktopApi()?.plugins?.clickMenuItem({
                        pluginId: item.pluginId,
                        id: item.id,
                      });
                    }}
                  >
                    <span style={styles.pluginMenuItemLabel}>{item.label}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, ElectronCSS> = {
  root: {
    width: "100vw",
    height: "100vh",
    background: "transparent",
    display: "grid",
    placeItems: "center",
    userSelect: "none",
  },
  stage: {
    position: "relative",
    width: 220,
    height: 220,
    background: "transparent",
    display: "grid",
    placeItems: "center",
  },
  dragHandle: {
    position: "absolute",
    left: "50%",
    bottom: 10,
    transform: "translateX(-50%)",
    width: 92,
    height: 18,
    borderRadius: 999,
    border: "1px solid var(--line)",
    background: "rgba(0, 0, 0, 0.24)",
    boxShadow: "0 10px 24px rgba(0, 0, 0, 0.22)",
    cursor: "grab",
    padding: 0,
    display: "grid",
    placeItems: "center",
    zIndex: 4,
    WebkitAppRegion: "no-drag",
  },
  dragHandleGrip: {
    width: 34,
    height: 4,
    borderRadius: 999,
    background: "rgba(255, 255, 255, 0.45)",
  },
  spriteButton: {
    width: 76,
    height: 76,
    borderRadius: 999,
    border: "1px solid var(--line)",
    background: "var(--card2)",
    boxShadow: "var(--shadow-card)",
    cursor: "pointer",
    padding: 0,
    display: "grid",
    placeItems: "center",
    zIndex: 2,
    WebkitAppRegion: "no-drag",
  },
  spriteInner: {
    width: 56,
    height: 56,
    borderRadius: 999,
    background: "linear-gradient(135deg, var(--card2), var(--card))",
    border: "1px solid var(--line)",
  },
  menu: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    zIndex: 1,
  },
  menuRing: {
    width: 170,
    height: 170,
    borderRadius: 999,
    border: "1px solid var(--line)",
    background: "var(--card)",
    boxShadow: "inset 0 0 0 1px var(--line)",
  },
  menuItem: {
    position: "absolute",
    width: 70,
    height: 34,
    borderRadius: 999,
    border: "1px solid var(--line)",
    background: "var(--card2)",
    color: "var(--text)",
    fontSize: 12,
    letterSpacing: 0.2,
    cursor: "pointer",
    display: "grid",
    placeItems: "center",
    WebkitAppRegion: "no-drag",
  },
  menuItemTop: {
    top: 18,
    left: "50%",
    transform: "translateX(-50%)",
  },
  pluginMenuItems: {
    position: "absolute",
    inset: 0,
  },
  pluginMenuItem: {
    width: 76,
    height: 34,
    padding: "0 10px",
    background: "var(--card)",
    boxShadow: "var(--shadow-card)",
  },
  pluginMenuItemLabel: {
    width: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    display: "block",
  },
  pluginBubble: {
    position: "absolute",
    left: "50%",
    top: -10,
    transform: "translate(-50%, -100%)",
    maxWidth: 280,
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid var(--line)",
    background: "rgba(0, 0, 0, 0.52)",
    color: "var(--text)",
    boxShadow: "0 18px 40px rgba(0, 0, 0, 0.30)",
    pointerEvents: "none",
    zIndex: 3,
  },
  pluginBubbleSuggestion: {
    border: "1px solid var(--line)",
    background: "rgba(0, 0, 0, 0.48)",
  },
  pluginBubbleText: {
    fontSize: 12,
    lineHeight: 1.35,
    letterSpacing: 0.1,
    overflow: "hidden",
    display: "-webkit-box",
    WebkitLineClamp: 3,
    WebkitBoxOrient: "vertical",
    textShadow: "0 1px 0 rgba(0, 0, 0, 0.30)",
  },
  srOnly: {
    position: "absolute",
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    border: 0,
  },
};
