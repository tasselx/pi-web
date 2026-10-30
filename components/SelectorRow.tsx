"use client";

import { useState, type ReactNode } from "react";

/**
 * A selector menu row styled like a session-list row: the whole row selects
 * and highlights on hover.
 */
export function SelectorRow({
  active,
  onSelect,
  children,
}: {
  active: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: active ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        transition: "background 0.1s",
      }}
    >
      <button
        type="button"
        role="option"
        aria-selected={active}
        onClick={onSelect}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          width: "100%", minWidth: 0, padding: "7px 12px",
          border: "none", background: "none",
          color: active ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer", fontSize: 12, fontWeight: active ? 600 : 400,
          textAlign: "left", whiteSpace: "nowrap",
        }}
      >
        {active
          ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true"><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
          : <span style={{ width: 10, flexShrink: 0 }} />}
        {children}
      </button>
    </div>
  );
}
