"use client";

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { openStackedDialog } from "@/lib/stacked-dialog";
import { parseFrontmatter } from "@/lib/frontmatter";

type NativeChoice = { path: string } | "cancelled" | "busy" | "unavailable";

async function chooseNativePath(mode: "file" | "folder", prompt: string): Promise<NativeChoice> {
  try {
    const res = await fetch("/api/skills/import/pick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, prompt }),
    });
    const data = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
    if (res.ok) return data.path ? { path: data.path } : "cancelled";
    return data.error === "busy" ? "busy" : "unavailable";
  } catch {
    return "unavailable";
  }
}

// 项目里没有现成的对话框输入框样式，这里与 ImportSessionDialog 的输入框保持同一外观。
const INPUT_STYLE: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "7px 10px",
  borderRadius: 5,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
};

const LABEL_STYLE: CSSProperties = {
  display: "block",
  fontSize: 11,
  color: "var(--text-muted)",
  marginBottom: 4,
};

export function ImportSkillDialog({
  cwd,
  scope,
  targetRoot,
  onClose,
  onImported,
}: {
  cwd: string;
  /** 导入到全局还是项目，由添加页的「全局 | 项目」决定，对话框里不再重复选择。 */
  scope: "global" | "project";
  /** 该范围的技能目录（以 / 结尾），只用于显示安装目标。 */
  targetRoot: string;
  onClose: () => void;
  onImported: (result: { name: string; filePath: string; scope: string }) => void;
}) {
  const { t } = useI18n();
  const [pathValue, setPathValue] = useState("");
  const [selectedFile, setSelectedFile] = useState<{ name: string; content: string } | null>(null);
  const [skillName, setSkillName] = useState("");
  const [skillDescription, setSkillDescription] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nativeUnavailableRef = useRef(false);

  const extractNameAndDesc = (text: string, fallbackName: string) => {
    try {
      const fm = parseFrontmatter(text);
      const name = (fm.data?.name as string)?.trim() || fallbackName;
      const desc = (fm.data?.description as string)?.trim() || null;
      setSkillName(name);
      setSkillDescription(desc);
    } catch {
      setSkillName(fallbackName);
      setSkillDescription(null);
    }
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const content = await file.text();
      const rawName = file.name.replace(/\.[^/.]+$/, "");
      setSelectedFile({ name: file.name, content });
      setPathValue("");
      extractNameAndDesc(content, rawName);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleChoose = async (mode: "file" | "folder") => {
    setError(null);
    if (!nativeUnavailableRef.current) {
      const choice = await chooseNativePath(
        mode,
        mode === "folder" ? t("skills.import.chooseFolder") : t("skills.import.chooseFile"),
      );
      if (choice === "busy" || choice === "cancelled") return;
      if (choice !== "unavailable") {
        setPathValue(choice.path);
        setSelectedFile(null);
        // Deduce skill name from folder or file
        const segments = choice.path.replace(/[\\/]+$/, "").split(/[\\/]/);
        const leaf = segments[segments.length - 1] || "imported-skill";
        const base = leaf.replace(/\.[^/.]+$/, "");
        setSkillName(base === "SKILL" || base === "skill" ? segments[segments.length - 2] || base : base);
        return;
      }
      nativeUnavailableRef.current = true;
    }
    // Fallback to browser file input
    fileInputRef.current?.click();
  };

  const handleConfirm = async () => {
    if (busy) return;
    const trimmedPath = pathValue.trim();
    if (!selectedFile && !trimmedPath) {
      setError(t("skills.import.sourceRequired"));
      return;
    }
    const finalName = skillName.trim();
    if (!finalName) {
      setError(t("skills.import.nameRequired"));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const payload = selectedFile
        ? {
            scope,
            cwd,
            name: finalName,
            content: selectedFile.content,
          }
        : {
            scope,
            cwd,
            name: finalName,
            sourcePath: trimmedPath,
          };

      const response = await fetch("/api/skills/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        name?: string;
        filePath?: string;
        scope?: string;
        error?: string;
      };
      if (!response.ok || !data.success || !data.filePath) {
        setError(data.error || `HTTP ${response.status}`);
        return;
      }
      onImported({
        name: data.name ?? finalName,
        filePath: data.filePath,
        scope: data.scope ?? scope,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ImportSkillDialogView
      targetRoot={targetRoot}
      pathValue={pathValue}
      selectedFileName={selectedFile?.name ?? null}
      skillName={skillName}
      skillDescription={skillDescription}
      busy={busy}
      error={error}
      fileInputRef={fileInputRef}
      onFileInputChange={(e) => void handleFileChange(e)}
      onPathChange={(next) => {
        setPathValue(next);
        if (next.trim()) setSelectedFile(null);
      }}
      onSkillNameChange={setSkillName}
      onChooseFile={() => void handleChoose("file")}
      onChooseFolder={() => void handleChoose("folder")}
      onCancel={onClose}
      onConfirm={() => void handleConfirm()}
    />
  );
}

export function ImportSkillDialogView({
  targetRoot,
  pathValue,
  selectedFileName,
  skillName,
  skillDescription,
  busy,
  error,
  fileInputRef,
  onFileInputChange,
  onPathChange,
  onSkillNameChange,
  onChooseFile,
  onChooseFolder,
  onCancel,
  onConfirm,
}: {
  targetRoot: string;
  pathValue: string;
  selectedFileName: string | null;
  skillName: string;
  skillDescription: string | null;
  busy: boolean;
  error: string | null;
  fileInputRef?: RefObject<HTMLInputElement | null>;
  onFileInputChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onPathChange: (value: string) => void;
  onSkillNameChange: (name: string) => void;
  onChooseFile: () => void;
  onChooseFolder: () => void;
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

  // 结构与 ImportSessionDialog 一致：.project-trust-body 是横向 flex，
  // 错误提示和 footer 必须与它同级，放进去会被挤到内容右侧。
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
        aria-labelledby="import-skill-title"
        aria-describedby="import-skill-description"
        tabIndex={-1}
        className="project-trust-dialog"
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,text/markdown,text/plain"
          style={{ display: "none" }}
          onChange={onFileInputChange}
        />
        <div className="project-trust-body">
          <div className="project-trust-content">
            <div id="import-skill-title" className="project-trust-title">
              {t("skills.import.title")}
            </div>
            <div id="import-skill-description" className="project-trust-text">
              {t("skills.import.description")}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="project-trust-button"
                  onClick={onChooseFile}
                  disabled={busy}
                >
                  {t("skills.import.chooseFile")}
                </button>
                <button
                  type="button"
                  className="project-trust-button"
                  onClick={onChooseFolder}
                  disabled={busy}
                >
                  {t("skills.import.chooseFolder")}
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
                <label htmlFor="import-skill-path-input" style={LABEL_STYLE}>
                  {t("skills.import.pathLabel")}
                </label>
                <input
                  id="import-skill-path-input"
                  type="text"
                  value={pathValue}
                  disabled={busy}
                  placeholder="/path/to/my-skill or /path/to/SKILL.md"
                  onChange={(e) => onPathChange(e.target.value)}
                  style={INPUT_STYLE}
                />
              </div>

              <div>
                <label htmlFor="import-skill-name-input" style={LABEL_STYLE}>
                  {t("skills.import.nameLabel")}
                </label>
                <input
                  id="import-skill-name-input"
                  type="text"
                  value={skillName}
                  disabled={busy}
                  placeholder="my-skill"
                  onChange={(e) => onSkillNameChange(e.target.value)}
                  style={INPUT_STYLE}
                />
                <span
                  style={{ display: "block", marginTop: 4, fontSize: 11, color: "var(--text-dim)", overflowWrap: "anywhere" }}
                >
                  {t("skills.import.targetLocation")}: <code>{targetRoot}{skillName || "..."}/SKILL.md</code>
                </span>
              </div>

              {skillDescription && (
                <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                  {skillDescription}
                </div>
              )}
            </div>
          </div>
        </div>
        {error && (
          <div role="alert" className="project-trust-error" style={{ overflowWrap: "anywhere" }}>
            {error}
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
          >
            {busy ? t("import.importing") : t("import.confirm")}
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(content, document.body) : null;
}
