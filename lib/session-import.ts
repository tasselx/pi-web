import { randomUUID } from "node:crypto";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readRegularFileText } from "./regular-file";
import {
  cacheSessionPath,
  invalidateSessionListCache,
  readSessionInfo,
  resolveSessionPath,
} from "./session-reader";
import type { SessionInfo } from "./types";

/** 64 MB cap on imported `.jsonl` session files. */
export const MAX_SESSION_IMPORT_BYTES = 64 * 1024 * 1024;

const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export type SessionImportRefusal =
  | "not_found"
  | "invalid_session"
  | "cwd_missing"
  | "too_large";

export class SessionImportError extends Error {
  constructor(readonly code: SessionImportRefusal, message: string) {
    super(message);
    this.name = "SessionImportError";
  }
}

export interface SessionImportResult {
  sessionId: string;
  path: string;
  session: SessionInfo;
}

export type SessionImportInput =
  | {
      sourcePath: string;
      fallbackCwd?: string;
      sessionDir?: string;
    }
  | {
      content: string;
      fileName?: string;
      fallbackCwd?: string;
      sessionDir?: string;
    };

function expandHomePath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function isExistingDirectory(dirPath: string | undefined): dirPath is string {
  if (!dirPath || !dirPath.trim()) return false;
  try {
    return statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

interface ParsedSessionJsonl {
  header: Record<string, unknown> & {
    type: "session";
    id: string;
    timestamp?: string;
    cwd?: string;
  };
  headerLineIndex: number;
  lines: string[];
}

export function parseSessionJsonlText(rawText: string): ParsedSessionJsonl {
  const normalized = rawText.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      parsed
      && typeof parsed === "object"
      && (parsed as { type?: unknown }).type === "session"
      && typeof (parsed as { id?: unknown }).id === "string"
      && ((parsed as { id: string }).id.trim().length > 0)
    ) {
      return {
        header: parsed as ParsedSessionJsonl["header"],
        headerLineIndex: i,
        lines,
      };
    }
    break;
  }

  throw new SessionImportError("invalid_session", "File is not a valid pi session (.jsonl)");
}

export async function importSessionJsonl(input: SessionImportInput): Promise<SessionImportResult> {
  let rawText: string;
  let resolvedSourcePath: string | undefined;
  let sourceFileName: string | undefined;

  if ("sourcePath" in input) {
    resolvedSourcePath = resolve(expandHomePath(input.sourcePath));
    let text: string | undefined;
    try {
      text = readRegularFileText(resolvedSourcePath, MAX_SESSION_IMPORT_BYTES);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/exceeds|limit|large/i.test(msg)) {
        throw new SessionImportError("too_large", msg);
      }
      throw new SessionImportError("invalid_session", msg);
    }
    if (text === undefined) {
      throw new SessionImportError("not_found", `File not found: ${resolvedSourcePath}`);
    }
    rawText = text;
    sourceFileName = basename(resolvedSourcePath);
  } else {
    if (Buffer.byteLength(input.content, "utf8") > MAX_SESSION_IMPORT_BYTES) {
      throw new SessionImportError("too_large", "Session file exceeds 64 MB limit");
    }
    rawText = input.content;
    sourceFileName = input.fileName ? basename(input.fileName) : undefined;
  }

  const parsed = parseSessionJsonlText(rawText);
  const rawHeaderCwd =
    typeof parsed.header.cwd === "string" && parsed.header.cwd.trim()
      ? resolve(expandHomePath(parsed.header.cwd))
      : undefined;
  const fallbackCwd =
    typeof input.fallbackCwd === "string" && input.fallbackCwd.trim()
      ? resolve(expandHomePath(input.fallbackCwd))
      : undefined;

  const effectiveCwd = isExistingDirectory(rawHeaderCwd)
    ? rawHeaderCwd
    : isExistingDirectory(fallbackCwd)
      ? fallbackCwd
      : undefined;

  if (!effectiveCwd) {
    throw new SessionImportError(
      "cwd_missing",
      `Stored session working directory does not exist: ${rawHeaderCwd || fallbackCwd || "(none)"}`,
    );
  }

  const sessionDir = input.sessionDir
    ? resolve(input.sessionDir)
    : SessionManager.create(effectiveCwd).getSessionDir();

  // If the file is already stored in its target session directory with a valid cwd, open it in place.
  if (
    resolvedSourcePath
    && effectiveCwd === rawHeaderCwd
    && resolve(join(sessionDir, basename(resolvedSourcePath))) === resolvedSourcePath
  ) {
    const sm = SessionManager.open(resolvedSourcePath, sessionDir);
    const sessionId = sm.getSessionId();
    cacheSessionPath(sessionId, resolvedSourcePath);
    invalidateSessionListCache();
    const session = await readSessionInfo(resolvedSourcePath);
    if (!session) {
      throw new SessionImportError("invalid_session", "Imported session could not be read");
    }
    return { sessionId, path: resolvedSourcePath, session };
  }

  const candidateId = parsed.header.id.trim();
  const existingPath = SESSION_ID_PATTERN.test(candidateId)
    ? await resolveSessionPath(candidateId)
    : null;
  const sessionId =
    SESSION_ID_PATTERN.test(candidateId) && !existingPath
      ? candidateId
      : randomUUID();

  const updatedHeader = {
    ...parsed.header,
    id: sessionId,
    cwd: effectiveCwd,
  };
  const outputLines = [...parsed.lines];
  outputLines[parsed.headerLineIndex] = JSON.stringify(updatedHeader);
  const outputText = `${outputLines.join("\n")}\n`;

  const rawTimestamp =
    typeof parsed.header.timestamp === "string" && parsed.header.timestamp.trim()
      ? parsed.header.timestamp.trim()
      : new Date().toISOString();
  const safeTimestamp = rawTimestamp.replace(/[^0-9A-Za-z._-]/g, "-");

  const expectedSuffix = `_${sessionId}.jsonl`;
  let destinationPath =
    sourceFileName && sourceFileName.endsWith(expectedSuffix)
      ? join(sessionDir, sourceFileName)
      : join(sessionDir, `${safeTimestamp}_${sessionId}.jsonl`);

  let suffix = 1;
  while (existsSync(destinationPath)) {
    destinationPath = join(sessionDir, `${safeTimestamp}-${suffix++}_${sessionId}.jsonl`);
  }

  writeFileSync(destinationPath, outputText, "utf8");
  // Let SessionManager migrate older session versions if needed.
  SessionManager.open(destinationPath, sessionDir);
  cacheSessionPath(sessionId, destinationPath);
  invalidateSessionListCache();

  const session = await readSessionInfo(destinationPath);
  if (!session) {
    throw new SessionImportError("invalid_session", "Imported session could not be read");
  }
  return { sessionId, path: destinationPath, session };
}
