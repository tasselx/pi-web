"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useEnterSendMode } from "@/hooks/useEnterSendMode";
import { useI18n } from "@/hooks/useI18n";
import { buildHotkeySections, type BuildHotkeySectionsOptions } from "@/lib/hotkeys";
import { openStackedDialog } from "@/lib/stacked-dialog";

export function HotkeysSectionsList({
  enterSendMode,
  idPrefix = "hotkeys-section",
}: BuildHotkeySectionsOptions & {
  idPrefix?: string;
}) {
  const { t } = useI18n();
  const storedEnterSendMode = useEnterSendMode();
  const effectiveEnterSendMode = enterSendMode ?? storedEnterSendMode;
  const sections = buildHotkeySections({ enterSendMode: effectiveEnterSendMode });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {sections.map((section) => (
        <div key={section.id} role="group" aria-labelledby={`${idPrefix}-${section.id}`}>
          <div
            id={`${idPrefix}-${section.id}`}
            style={{
              color: "var(--text-muted)",
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              marginBottom: 6,
            }}
          >
            {t(section.titleKey)}
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg)",
              overflow: "hidden",
            }}
          >
            {section.items.map((item, index) => (
              <div
                key={item.descriptionKey}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "7px 10px",
                  fontSize: 12,
                  borderTop: index > 0 ? "1px solid var(--border)" : undefined,
                }}
              >
                <span style={{ color: "var(--text)", minWidth: 0 }}>
                  {t(item.descriptionKey)}
                </span>
                <code
                  style={{
                    flexShrink: 0,
                    padding: "2px 6px",
                    borderRadius: 4,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text-muted)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                  }}
                >
                  {item.keys}
                </code>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function HotkeysDialog({
  enterSendMode,
  onClose,
}: BuildHotkeySectionsOptions & {
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    return openStackedDialog(document, dialogRef.current, () => {
      onCloseRef.current();
    });
  }, []);

  const content = (
    <div
      role="presentation"
      className="project-trust-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hotkeys-dialog-title"
        tabIndex={-1}
        className="project-trust-dialog"
        style={{ width: 520 }}
      >
        <div className="project-trust-body">
          <div className="project-trust-content">
            <div id="hotkeys-dialog-title" className="project-trust-title">
              {t("hotkeys.dialogTitle")}
            </div>
            <div style={{ marginTop: 12 }}>
              <HotkeysSectionsList enterSendMode={enterSendMode} idPrefix="hotkeys-dialog-section" />
            </div>
          </div>
        </div>
        <div className="project-trust-footer">
          <button
            type="button"
            className="project-trust-button is-primary"
            onClick={onClose}
          >
            {t("hotkeys.close")}
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined" && document.body
    ? createPortal(content, document.body)
    : content;
}
