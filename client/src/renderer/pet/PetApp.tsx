import React, { useId, useState } from "react";

type PetAppProps = {
  className?: string;
};

interface ElectronCSS extends React.CSSProperties {
  WebkitAppRegion?: "drag" | "no-drag";
}

export default function PetApp(props: PetAppProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const srId = useId();

  return (
    <div
      className={props.className}
      style={styles.root}
    >
      <div style={styles.stage}>
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
