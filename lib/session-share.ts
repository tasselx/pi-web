import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getModelRuntimeWithExtensions } from "./model-runtime";
import { exportSessionHtmlToFile } from "./session-html-export";

const execFileAsync = promisify(execFile);

const DEFAULT_RADIUS_GATEWAY = "https://radius.pi.dev";
const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";
const CURRENT_SESSION_VERSION = 3;

export type SessionShareDestination = "radius" | "gist";

export type SessionShareRefusal =
  | "not_found"
  | "empty"
  | "radius_unconfigured"
  | "radius_failed"
  | "gh_missing"
  | "gh_unauthenticated"
  | "gist_failed";

export class SessionShareError extends Error {
  constructor(readonly code: SessionShareRefusal, message: string) {
    super(message);
    this.name = "SessionShareError";
  }
}

export interface ShareToolInfo {
  readonly name: string;
  readonly description: string;
  readonly parameters?: unknown;
}

export interface ShareSessionOptions {
  sessionPath: string;
  leafId?: string | null;
  systemPrompt?: string;
  tools?: readonly ShareToolInfo[];
}

export interface ShareSessionResult {
  destination: SessionShareDestination;
  shareUrl: string;
  gistUrl?: string;
}

export interface ShareSessionDeps {
  getDestination?: (cwd: string) => "radius" | "gist" | undefined;
  getRadiusToken?: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  checkGhAuth?: () => Promise<"ok" | "missing" | "unauthenticated">;
  exportHtml?: (jsonlPath: string, htmlPath: string) => Promise<unknown>;
  createGist?: (htmlPath: string) => Promise<string>;
}

/** Extract a bearer token from `modelRuntime.getAuth("radius")`, matching pi's `getAuthCredential`. */
export function extractRadiusToken(
  auth: { auth?: { apiKey?: string; headers?: Record<string, string> } } | null | undefined,
): string | undefined {
  if (auth?.auth?.apiKey) return auth.auth.apiKey;
  const authorization = Object.entries(auth?.auth?.headers ?? {}).find(
    ([name]) => name.toLowerCase() === "authorization",
  )?.[1];
  return typeof authorization === "string"
    ? /^Bearer\s+(.+)$/iu.exec(authorization)?.[1]
    : undefined;
}

/** Preview viewer URL for a GitHub gist ID, matching pi's `getShareViewerUrl`. */
export function getShareViewerUrl(gistId: string): string {
  const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
  return `${baseUrl}#${gistId}`;
}

/**
 * Serialize the active branch and trailing `pi.share` entry as JSONL, matching
 * pi's `exportSessionForShare` (`modes/interactive/session-share.js`).
 */
export function serializeSessionBranchForShare(
  sessionManager: SessionManager,
  options: {
    leafId?: string | null;
    systemPrompt?: string;
    tools?: readonly ShareToolInfo[];
    timestamp?: string;
    shareEntryId?: string;
  } = {},
): string {
  const timestamp = options.timestamp ?? new Date().toISOString();
  const resolvedLeafId =
    options.leafId !== undefined && options.leafId !== null && sessionManager.getEntry(options.leafId)
      ? options.leafId
      : sessionManager.getLeafId();
  const branch = resolvedLeafId ? sessionManager.getBranch(resolvedLeafId) : [];

  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionManager.getSessionId(),
    timestamp,
    cwd: sessionManager.getCwd(),
  };

  const entries: Record<string, unknown>[] = [header];
  let parentId: string | null = null;
  for (const entry of branch) {
    entries.push({ ...entry, parentId });
    parentId = entry.id;
  }

  entries.push({
    type: "custom",
    customType: "pi.share",
    id: options.shareEntryId ?? randomUUID().slice(0, 8),
    parentId,
    timestamp,
    data: {
      systemPrompt: options.systemPrompt ?? "",
      tools: (options.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
      })),
    },
  });

  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function defaultGetRadiusToken(): Promise<string | undefined> {
  const runtime = await getModelRuntimeWithExtensions();
  const runtimeWithRadius = runtime as unknown as {
    getProvider?: (id: string) => unknown;
    getAuth?: (
      id: string,
      options?: { minOAuthValidityMs?: number },
    ) => Promise<{ auth?: { apiKey?: string; headers?: Record<string, string> } } | undefined>;
  };
  if (typeof runtimeWithRadius.getProvider !== "function" || typeof runtimeWithRadius.getAuth !== "function") {
    return undefined;
  }
  if (!runtimeWithRadius.getProvider("radius")) return undefined;
  const auth = await runtimeWithRadius.getAuth("radius", { minOAuthValidityMs: 5 * 60_000 });
  return extractRadiusToken(auth);
}

async function defaultCheckGhAuth(): Promise<"ok" | "missing" | "unauthenticated"> {
  try {
    await execFileAsync("gh", ["auth", "status"], { timeout: 15_000 });
    return "ok";
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { code?: string | number };
    if (err?.code === "ENOENT") return "missing";
    return "unauthenticated";
  }
}

async function defaultCreateGist(htmlPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", ["gist", "create", "--public=false", htmlPath], {
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    const detail = err?.stderr?.trim() || err?.message || "Unknown error";
    throw new SessionShareError("gist_failed", `Failed to create gist: ${detail}`);
  }
}

export async function shareSessionBranch(
  options: ShareSessionOptions,
  deps: ShareSessionDeps = {},
): Promise<ShareSessionResult> {
  if (!options.sessionPath || !existsSync(options.sessionPath)) {
    throw new SessionShareError("not_found", "Session not found");
  }

  const sm = SessionManager.open(options.sessionPath);
  const resolvedLeafId =
    options.leafId !== undefined && options.leafId !== null && sm.getEntry(options.leafId)
      ? options.leafId
      : sm.getLeafId();
  const branch = resolvedLeafId ? sm.getBranch(resolvedLeafId) : [];
  if (branch.length === 0) {
    throw new SessionShareError("empty", "Nothing to share yet - start a conversation first");
  }

  const jsonlBody = serializeSessionBranchForShare(sm, {
    leafId: resolvedLeafId,
    systemPrompt: options.systemPrompt,
    tools: options.tools,
  });

  const getDestination =
    deps.getDestination
    ?? ((cwd: string) => SettingsManager.create(cwd, getAgentDir()).getSessionShareDestination());
  const destination = getDestination(sm.getCwd());

  if (destination !== "gist") {
    const getRadiusToken = deps.getRadiusToken ?? defaultGetRadiusToken;
    const token = await getRadiusToken();
    if (token) {
      const fetchFn = deps.fetchImpl ?? fetch;
      const bodyBytes = Buffer.from(jsonlBody, "utf8");
      const url = new URL("/v1/artifacts", DEFAULT_RADIUS_GATEWAY);
      url.searchParams.set("visibility", "organization");
      url.searchParams.set("title", "Pi session");
      let response: Response;
      try {
        response = await fetchFn(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/x-ndjson",
            "Content-Length": String(bodyBytes.byteLength),
          },
          body: bodyBytes,
        });
      } catch (error) {
        throw new SessionShareError(
          "radius_failed",
          `Failed to upload Radius artifact: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }

      const json = (await response.json().catch(() => null)) as {
        artifact?: { canonical_url?: string };
        error?: string;
      } | null;
      if (!response.ok || !json?.artifact?.canonical_url) {
        throw new SessionShareError(
          "radius_failed",
          `Failed to upload Radius artifact: ${json?.error || response.statusText || response.status}`,
        );
      }
      return {
        destination: "radius",
        shareUrl: json.artifact.canonical_url,
      };
    }

    if (destination === "radius") {
      throw new SessionShareError(
        "radius_unconfigured",
        "Radius authentication is not configured. Run '/login radius' first.",
      );
    }
  }

  const checkGhAuth = deps.checkGhAuth ?? defaultCheckGhAuth;
  const ghStatus = await checkGhAuth();
  if (ghStatus === "missing") {
    throw new SessionShareError(
      "gh_missing",
      "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/",
    );
  }
  if (ghStatus === "unauthenticated") {
    throw new SessionShareError(
      "gh_unauthenticated",
      "GitHub CLI is not logged in. Run 'gh auth login' first.",
    );
  }

  const tempDir = mkdtempSync(join(tmpdir(), "pi-share-"));
  const jsonlFile = join(tempDir, "session.jsonl");
  const htmlFile = join(tempDir, "session.html");
  try {
    writeFileSync(jsonlFile, jsonlBody, "utf8");
    const exportHtml = deps.exportHtml ?? exportSessionHtmlToFile;
    await exportHtml(jsonlFile, htmlFile);

    const createGist = deps.createGist ?? defaultCreateGist;
    const gistUrl = await createGist(htmlFile);
    const gistId = gistUrl.split("/").filter(Boolean).pop();
    if (!gistId) {
      throw new SessionShareError("gist_failed", "Failed to parse gist ID from gh output");
    }
    return {
      destination: "gist",
      shareUrl: getShareViewerUrl(gistId),
      gistUrl,
    };
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
