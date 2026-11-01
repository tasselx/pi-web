"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { openStackedDialog } from "@/lib/stacked-dialog";

export interface ShareSessionSuccess {
  destination: "radius" | "gist";
  shareUrl: string;
  gistUrl?: string;
}

export function ShareSessionDialog({
  sessionId,
  leafId,
  onClose,
}: {
  sessionId: string;
  leafId?: string | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ShareSessionSuccess | null>(null);
  const [copied, setCopied] = useState(false);

  const handleConfirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leafId: leafId ?? undefined }),
      });
      const data = (await response.json().catch(() => ({}))) as Partial<
        ShareSessionSuccess & { error?: string }
      >;
      if (!response.ok || !data.shareUrl || !data.destination) {
        setError(data.error || `HTTP ${response.status}`);
        return;
      }
      const shared: ShareSessionSuccess = {
        destination: data.destination,
        shareUrl: data.shareUrl,
        ...(data.gistUrl ? { gistUrl: data.gistUrl } : {}),
      };
      setResult(shared);
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(shared.shareUrl).then(
          () => setCopied(true),
          () => undefined,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = () => {
    if (!result?.shareUrl) return;
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(result.shareUrl).then(
        () => setCopied(true),
        () => undefined,
      );
    }
  };

  return (
    <ShareSessionDialogView
      busy={busy}
      error={error}
      result={result}
      copied={copied}
      onCancel={onClose}
      onConfirm={() => void handleConfirm()}
      onCopy={handleCopy}
    />
  );
}

export function ShareSessionDialogView({
  busy,
  error,
  result,
  copied = false,
  onCancel,
  onConfirm,
  onCopy,
}: {
  busy: boolean;
  error: string | null;
  result: ShareSessionSuccess | null;
  copied?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onCopy?: () => void;
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
        aria-labelledby="share-session-title"
        aria-describedby="share-session-description"
        tabIndex={-1}
        className="project-trust-dialog"
      >
        <div className="project-trust-body">
          <div className="project-trust-content">
            <div id="share-session-title" className="project-trust-title">
              {t("share.dialogTitle")}
            </div>
            <div id="share-session-description" className="project-trust-text">
              {result ? t("share.sharedBody") : t("share.confirmBody")}
            </div>
            {result && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                <div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                    {t("share.shareUrlLabel")}
                  </div>
                  <a
                    href={result.shareUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="project-trust-path"
                    style={{ marginTop: 0, color: "var(--accent)", textDecoration: "underline" }}
                  >
                    {result.shareUrl}
                  </a>
                </div>
                {result.gistUrl && (
                  <div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                      {t("share.gistUrlLabel")}
                    </div>
                    <a
                      href={result.gistUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="project-trust-path"
                      style={{ marginTop: 0, color: "var(--accent)", textDecoration: "underline" }}
                    >
                      {result.gistUrl}
                    </a>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        {error && (
          <div role="alert" className="project-trust-error">
            {t("share.shareFailed")}
            <code className="project-trust-error-detail">{error}</code>
          </div>
        )}
        <div className="project-trust-footer">
          {result ? (
            <>
              <button
                type="button"
                className="project-trust-button"
                onClick={onCopy}
              >
                {copied ? t("share.copied") : t("share.copyLink")}
              </button>
              <button
                type="button"
                className="project-trust-button is-primary"
                onClick={onCancel}
              >
                {t("share.close")}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="project-trust-button"
                onClick={onCancel}
                disabled={busy}
              >
                {t("share.cancel")}
              </button>
              <button
                type="button"
                className="project-trust-button is-primary"
                onClick={onConfirm}
                disabled={busy}
                aria-busy={busy || undefined}
              >
                {busy ? t("share.sharing") : t("share.confirm")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined" && document.body
    ? createPortal(content, document.body)
    : content;
}
