import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { exportSessionHtmlToFile } from "./session-html-export";

export type SessionExportFormat = "jsonl" | "html" | "md";

export function normalizeExportFormat(raw: string | null | undefined): SessionExportFormat {
  if (raw === "jsonl" || raw === "md" || raw === "html") return raw;
  return "html";
}

export function exportSessionToJsonl(filePath: string, leafId?: string | null): string {
  if (!leafId) {
    const raw = readFileSync(filePath, "utf-8");
    return raw.endsWith("\n") ? raw : `${raw}\n`;
  }
  const sm = SessionManager.open(filePath, undefined);
  const header = sm.getHeader() ?? {
    type: "session",
    version: 3,
    id: sm.getSessionId(),
    timestamp: new Date().toISOString(),
    cwd: sm.getCwd(),
  };
  const branch = sm.getBranch(leafId);
  return [...[header, ...branch].map((entry) => JSON.stringify(entry)), ""].join("\n");
}

function formatContentBlocksMarkdown(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      parts.push(b.text.trim());
    } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
      parts.push(
        `<details>\n<summary>Thinking</summary>\n\n${b.thinking.trim()}\n\n</details>`,
      );
    } else if (b.type === "toolCall") {
      const toolName = typeof b.toolName === "string" ? b.toolName : (typeof b.name === "string" ? b.name : "tool");
      const args = b.input ?? b.arguments ?? {};
      let serialized = "";
      try {
        serialized = JSON.stringify(args, null, 2);
      } catch {
        serialized = String(args);
      }
      parts.push(`**Tool Call: \`${toolName}\`**\n\`\`\`json\n${serialized}\n\`\`\``);
    } else if (b.type === "image") {
      parts.push("*(Image attachment)*");
    }
  }
  return parts.join("\n\n");
}

export function exportSessionToMarkdown(filePath: string, leafId?: string | null): string {
  const sm = SessionManager.open(filePath, undefined);
  const header = sm.getHeader();
  const sessionName = sm.getSessionName();
  const branch = leafId ? sm.getBranch(leafId) : sm.getBranch();

  const lines: string[] = [];
  lines.push(`# ${sessionName || `Session ${sm.getSessionId()}`}`);
  lines.push("");
  lines.push(`- **Session ID**: \`${sm.getSessionId()}\``);
  if (sm.getCwd()) lines.push(`- **Workspace**: \`${sm.getCwd()}\``);
  if (header?.timestamp) lines.push(`- **Created**: ${header.timestamp}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const entry of branch) {
    const rec = entry as unknown as Record<string, unknown>;
    if (rec.type === "compaction" && typeof rec.summary === "string") {
      lines.push("## Compaction Summary");
      lines.push("");
      lines.push(rec.summary.trim());
      lines.push("");
      continue;
    }
    if (rec.type !== "message" || !rec.message || typeof rec.message !== "object") {
      continue;
    }
    const msg = rec.message as Record<string, unknown>;
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    if (role === "system") continue;

    if (role === "user") {
      lines.push("## User");
      lines.push("");
      const body = formatContentBlocksMarkdown(msg.content);
      if (body) lines.push(body);
      lines.push("");
    } else if (role === "assistant") {
      const modelLabel =
        typeof msg.provider === "string" && typeof msg.model === "string"
          ? `Assistant (${msg.provider}/${msg.model})`
          : "Assistant";
      lines.push(`## ${modelLabel}`);
      lines.push("");
      const body = formatContentBlocksMarkdown(msg.content);
      if (body) lines.push(body);
      lines.push("");
    } else if (role === "toolResult") {
      const toolName = typeof msg.toolName === "string" ? msg.toolName : "tool";
      const body = formatContentBlocksMarkdown(msg.content);
      lines.push(`### Tool Result: \`${toolName}\`${msg.isError ? " (error)" : ""}`);
      lines.push("");
      if (body) {
        lines.push("```");
        lines.push(body);
        lines.push("```");
        lines.push("");
      }
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export async function exportSessionContent(
  filePath: string,
  format: SessionExportFormat,
  leafId?: string | null,
): Promise<{ content: string; contentType: string; fileName: string }> {
  const sessionBase = basename(filePath, ".jsonl");
  if (format === "jsonl") {
    return {
      content: exportSessionToJsonl(filePath, leafId),
      contentType: "application/jsonl; charset=utf-8",
      fileName: `pi-session-${sessionBase}.jsonl`,
    };
  }
  if (format === "md") {
    return {
      content: exportSessionToMarkdown(filePath, leafId),
      contentType: "text/markdown; charset=utf-8",
      fileName: `pi-session-${sessionBase}.md`,
    };
  }

  const tempDir = join(tmpdir(), "pi-web-export");
  mkdirSync(tempDir, { recursive: true });
  const outputPath = join(tempDir, `${randomUUID()}.html`);
  try {
    const patchedHtml = await exportSessionHtmlToFile(filePath, outputPath);
    return {
      content: patchedHtml,
      contentType: "text/html; charset=utf-8",
      fileName: `pi-session-${sessionBase}.html`,
    };
  } finally {
    rmSync(outputPath, { force: true });
  }
}
