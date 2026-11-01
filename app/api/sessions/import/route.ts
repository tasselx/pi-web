import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { importSessionJsonl, SessionImportError } from "@/lib/session-import";
import type { SessionInfo } from "@/lib/types";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

interface SessionImportResponse {
  sessionId: string;
  session: SessionInfo;
}

function refusal(status: number, code: string, error: string) {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal(403, "request-denied", "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "request-denied", "Content-Type must be application/json");

  let body: { path?: unknown; content?: unknown; fileName?: unknown; cwd?: unknown };
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object") {
      return refusal(400, "invalid-body", "Request body must be a JSON object");
    }
    body = parsed as typeof body;
  } catch {
    return refusal(400, "invalid-body", "Invalid JSON body");
  }

  const fallbackCwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : undefined;
  const sourcePath = typeof body.path === "string" && body.path.trim() ? body.path.trim() : undefined;
  const content = typeof body.content === "string" ? body.content : undefined;
  const fileName = typeof body.fileName === "string" && body.fileName.trim() ? body.fileName.trim() : undefined;

  if (!sourcePath && (!content || !content.trim())) {
    return refusal(400, "missing_input", "Either path or content is required");
  }

  try {
    const result = sourcePath
      ? await importSessionJsonl({ sourcePath, fallbackCwd })
      : await importSessionJsonl({ content: content!, fileName, fallbackCwd });

    return NextResponse.json(
      { sessionId: result.sessionId, session: result.session } satisfies SessionImportResponse,
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof SessionImportError) {
      const status =
        error.code === "not_found"
          ? 404
          : error.code === "too_large"
            ? 413
            : 400;
      return refusal(status, error.code, error.message);
    }
    return refusal(500, "failed", error instanceof Error ? error.message : String(error));
  }
}
