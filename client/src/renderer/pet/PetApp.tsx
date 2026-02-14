import React, { useEffect, useId, useRef, useState } from "react";

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

  useEffect(() => {
    const plugins = window.desktopApi?.plugins;
    if (!plugins?.onOutput) return;

    const unsubscribe = plugins.onOutput((payload: PluginOutputPayload) => {
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
    });

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

    const plugins = window.desktopApi?.plugins;
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
          data-testid="pet-sprite"
          aria-describedby={srId}
          onClick={() => setMenuOpen((v) => !v)}
          style={styles.spriteButton}
        >
          <span id={srId} style={styles.srOnly}>
            Toggle pet menu
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
            Chat
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
                      void window.desktopApi?.plugins?.clickMenuItem({
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
  spriteButton: {
    width: 76,
    height: 76,
    borderRadius: 999,
    border: "1px solid rgba(255, 255, 255, 0.28)",
    background: "rgba(255, 255, 255, 0.10)",
    boxShadow: "0 10px 30px rgba(0, 0, 0, 0.25)",
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
    background: "linear-gradient(135deg, rgba(255, 255, 255, 0.30), rgba(255, 255, 255, 0.06))",
    border: "1px solid rgba(255, 255, 255, 0.22)",
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
    border: "1px solid rgba(255, 255, 255, 0.22)",
    background: "rgba(0, 0, 0, 0.10)",
    boxShadow: "inset 0 0 0 1px rgba(0, 0, 0, 0.10)",
  },
  menuItem: {
    position: "absolute",
    width: 70,
    height: 34,
    borderRadius: 999,
    border: "1px solid rgba(255, 255, 255, 0.22)",
    background: "rgba(255, 255, 255, 0.12)",
    color: "rgba(255, 255, 255, 0.92)",
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
    background: "rgba(255, 255, 255, 0.10)",
    boxShadow: "0 10px 24px rgba(0, 0, 0, 0.18)",
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
    border: "1px solid rgba(255, 255, 255, 0.26)",
    background: "rgba(0, 0, 0, 0.52)",
    color: "rgba(255, 255, 255, 0.94)",
    boxShadow: "0 18px 40px rgba(0, 0, 0, 0.30)",
    pointerEvents: "none",
    zIndex: 3,
  },
  pluginBubbleSuggestion: {
    border: "1px solid rgba(255, 255, 255, 0.32)",
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
