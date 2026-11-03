"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { openStackedDialog } from "@/lib/stacked-dialog";

type NativeFileChoice = { path: string } | "cancelled" | "busy" | "unavailable";

async function chooseFileNatively(prompt: string): Promise<NativeFileChoice> {
  try {
    const res = await fetch("/api/sessions/import/pick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
    if (res.ok) return data.path ? { path: data.path } : "cancelled";
    return data.error === "busy" ? "busy" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export function ImportSessionDialog({
  initialPath,
  cwd,
  onClose,
  onImported,
}: {
  initialPath?: string | null;
  cwd?: string | null;
  onClose: () => void;
  onImported: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const [pathValue, setPathValue] = useState(initialPath ?? "");
  const [selectedFile, setSelectedFile] = useState<{ name: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nativeFileUnavailableRef = useRef(false);

  useEffect(() => {
    setPathValue(initialPath ?? "");
    setSelectedFile(null);
    setError(null);
  }, [initialPath]);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const content = await file.text();
      setSelectedFile({ name: file.name, content });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleChooseFile = async () => {
    setError(null);
    if (!nativeFileUnavailableRef.current) {
      const choice = await chooseFileNatively(t("import.chooseFile"));
      if (choice === "busy" || choice === "cancelled") return;
      if (choice !== "unavailable") {
        setPathValue(choice.path);
        setSelectedFile(null);
        return;
      }
      nativeFileUnavailableRef.current = true;
    }
    fileInputRef.current?.click();
  };

  const handleConfirm = async () => {
    if (busy) return;
    const trimmedPath = pathValue.trim();
    if (!selectedFile && !trimmedPath) return;

    setBusy(true);
    setError(null);
    try {
      const payload = selectedFile
        ? {
            content: selectedFile.content,
            fileName: selectedFile.name,
            ...(cwd ? { cwd } : {}),
          }
        : {
            path: trimmedPath,
            ...(cwd ? { cwd } : {}),
          };

      const response = await fetch("/api/sessions/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json().catch(() => ({}))) as {
        sessionId?: string;
        error?: string;
      };
      if (!response.ok || !data.sessionId) {
        setError(data.error || `HTTP ${response.status}`);
        return;
      }
      onImported(data.sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ImportSessionDialogView
      pathValue={pathValue}
      selectedFileName={selectedFile?.name ?? null}
      busy={busy}
      error={error}
      fileInputRef={fileInputRef}
      onFileInputChange={(event) => void handleFileChange(event)}
      onPathChange={(next) => {
        setPathValue(next);
        if (next.trim()) setSelectedFile(null);
      }}
      onChooseFile={() => void handleChooseFile()}
      onCancel={onClose}
      onConfirm={() => void handleConfirm()}
    />
  );
}

export function ImportSessionDialogView({
  pathValue,
  selectedFileName,
  busy,
  error,
  fileInputRef,
  onFileInputChange,
  onPathChange,
  onChooseFile,
  onCancel,
  onConfirm,
}: {
  pathValue: string;
  selectedFileName: string | null;
  busy: boolean;
  error: string | null;
  fileInputRef?: RefObject<HTMLInputElement | null>;
  onFileInputChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onPathChange: (value: string) => void;
  onChooseFile: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(busy);
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    busyRef.current = busy;
    onCancelRef.current = onCancel;
  }, [busy, onCancel]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    return openStackedDialog(document, dialogRef.current, () => {
      if (!busyRef.current) onCancelRef.current();
    });
  }, []);

  const canSubmit = !busy && (Boolean(selectedFileName) || pathValue.trim().length > 0);

  const content = (
    <div
      role="presentation"
      className="project-trust-backdrop"
      onClick={(event) => {
        if (!busy && event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-session-title"
        aria-describedby="import-session-description"
        tabIndex={-1}
        className="project-trust-dialog"
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".jsonl,.json,text/plain"
          style={{ display: "none" }}
          onChange={onFileInputChange}
        />
        <div className="project-trust-body">
          <div className="project-trust-content">
            <div id="import-session-title" className="project-trust-title">
              {t("import.dialogTitle")}
            </div>
            <div id="import-session-description" className="project-trust-text">
              {t("import.dialogBody")}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="project-trust-button"
                  onClick={onChooseFile}
                  disabled={busy}
                >
                  {t("import.chooseFile")}
                </button>
                {selectedFileName && (
                  <code
                    style={{
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                      color: "var(--text)",
                      padding: "4px 8px",
                      borderRadius: 4,
                      border: "1px solid var(--border)",
                      background: "var(--bg)",
                    }}
                  >
                    {selectedFileName}
                  </code>
                )}
              </div>

              <div>
                <label
                  htmlFor="import-session-path-input"
                  style={{ display: "block", fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}
                >
                  {t("import.serverPathLabel")}
                </label>
                <input
                  id="import-session-path-input"
                  type="text"
                  value={pathValue}
                  disabled={busy}
                  placeholder={t("import.serverPathPlaceholder")}
                  onChange={(event) => onPathChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing && canSubmit) {
                      event.preventDefault();
                      onConfirm();
                    }
                  }}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "7px 10px",
                    borderRadius: 5,
                    border: "1px solid var(--border)",
                    background: "var(--bg)",
                    color: "var(--text)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                  }}
                />
              </div>
            </div>
          </div>
        </div>
        {error && (
          <div role="alert" className="project-trust-error">
            {t("import.importFailed")}
            <code className="project-trust-error-detail">{error}</code>
          </div>
        )}
        <div className="project-trust-footer">
          <button
            type="button"
            className="project-trust-button"
            onClick={onCancel}
            disabled={busy}
          >
            {t("import.cancel")}
          </button>
          <button
            type="button"
            className="project-trust-button is-primary"
            onClick={onConfirm}
            disabled={!canSubmit}
            aria-busy={busy || undefined}
          >
            {busy ? t("import.importing") : t("import.confirm")}
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined" && document.body
    ? createPortal(content, document.body)
    : content;
}
