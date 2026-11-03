"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import type { SessionExportFormat } from "@/lib/session-export";
import { openStackedDialog } from "@/lib/stacked-dialog";

const EXPORT_FORMATS: SessionExportFormat[] = ["jsonl", "html", "md"];

export function ExportSessionDialog({
  sessionId,
  leafId,
  onExported,
  onClose,
}: {
  sessionId: string;
  leafId?: string | null;
  onExported?: (savedPath: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [format, setFormat] = useState<SessionExportFormat>("jsonl");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    busyRef.current = busy;
    onCloseRef.current = onClose;
  }, [busy, onClose]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    return openStackedDialog(document, dialogRef.current, () => {
      if (!busyRef.current) onCloseRef.current();
    });
  }, []);

  const buildDownloadUrl = (targetFormat: SessionExportFormat, inline = false): string => {
    const params = new URLSearchParams();
    params.set("format", targetFormat);
    if (leafId) params.set("leafId", leafId);
    if (inline) params.set("inline", "1");
    return `/api/sessions/${encodeURIComponent(sessionId)}/export?${params.toString()}`;
  };

  const triggerBrowserDownload = (targetFormat: SessionExportFormat) => {
    const link = document.createElement("a");
    link.href = buildDownloadUrl(targetFormat, false);
    link.download = `pi-session-${sessionId}.${targetFormat}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const handleExport = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format,
          ...(leafId ? { leafId } : {}),
          prompt: t("export.dialogTitle"),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        savedPath?: string;
        cancelled?: boolean;
        error?: string;
        stage?: string;
      };

      if (response.ok) {
        if (data.savedPath) {
          onExported?.(data.savedPath);
          onClose();
        }
        return;
      }

      if (response.status === 409 && data.error === "busy") {
        return;
      }

      if (
        response.status === 403 ||
        response.status === 405 ||
        response.status === 503 ||
        data.stage === "dialog" ||
        !data.stage
      ) {
        triggerBrowserDownload(format);
        onClose();
        return;
      }

      setError(data.error || `HTTP ${response.status}`);
    } catch {
      triggerBrowserDownload(format);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const content = (
    <div
      role="presentation"
      className="project-trust-backdrop"
      onClick={(event) => {
        if (!busy && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-session-title"
        aria-describedby="export-session-description"
        tabIndex={-1}
        className="project-trust-dialog"
      >
        <div className="project-trust-body">
          <div className="project-trust-content">
            <div id="export-session-title" className="project-trust-title">
              {t("export.dialogTitle")}
            </div>
            <div id="export-session-description" className="project-trust-text">
              {t("export.dialogBody")}
            </div>

            <div
              role="radiogroup"
              aria-label={t("export.dialogTitle")}
              style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}
            >
              {EXPORT_FORMATS.map((item) => {
                const selected = format === item;
                return (
                  <label
                    key={item}
                    onClick={() => {
                      if (!busy) {
                        setFormat(item);
                      }
                    }}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "8px 10px",
                      borderRadius: 6,
                      border: selected
                        ? "1px solid var(--accent)"
                        : "1px solid var(--border)",
                      background: selected
                        ? "color-mix(in srgb, var(--accent) 8%, var(--bg))"
                        : "var(--bg)",
                      cursor: busy ? "default" : "pointer",
                    }}
                  >
                    <input
                      type="radio"
                      name="export-session-format"
                      checked={selected}
                      disabled={busy}
                      onChange={() => {
                        setFormat(item);
                      }}
                      style={{ marginTop: 2 }}
                    />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                        {t(`export.format.${item}.title`)}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                        {t(`export.format.${item}.desc`)}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        {error && (
          <div role="alert" className="project-trust-error">
            {t("export.failed")}
            <code className="project-trust-error-detail">{error}</code>
          </div>
        )}

        <div className="project-trust-footer">
          <button
            type="button"
            className="project-trust-button"
            onClick={onClose}
            disabled={busy}
          >
            {t("export.close")}
          </button>
          {format === "html" && (
            <a
              href={buildDownloadUrl("html", true)}
              target="_blank"
              rel="noopener noreferrer"
              className="project-trust-button"
              style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}
            >
              {t("export.previewHtml")}
            </a>
          )}
          <button
            type="button"
            className="project-trust-button is-primary"
            onClick={() => void handleExport()}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {busy ? t("export.exporting") : t("export.confirm")}
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined" && document.body
    ? createPortal(content, document.body)
    : content;
}
