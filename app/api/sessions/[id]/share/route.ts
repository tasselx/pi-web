import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  invalidateSessionListCache,
  invalidateSessionPathCache,
  readLatestSessionEntryId,
  resolveSessionPath,
} from "@/lib/session-reader";
import { SessionShareError, shareSessionBranch, type ShareSessionResult } from "@/lib/session-share";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function refusal(status: number, code: string, error: string) {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) return refusal(403, "request-denied", "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "request-denied", "Content-Type must be application/json");
  const { id } = await params;

  let body: { leafId?: unknown } = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object") body = parsed as { leafId?: unknown };
  } catch {
    return refusal(400, "invalid-body", "Invalid JSON body");
  }

  try {
    const opened = getRpcSession(id);
    const sourcePath = (opened?.isAlive() ? opened.sessionFile : "") || await resolveSessionPath(id);
    if (!sourcePath) {
      invalidateSessionListCache();
      return refusal(404, "not_found", "Session not found");
    }

    let liveLeafId = opened?.isAlive() ? opened.inner.sessionManager.getLeafId() : undefined;
    if (opened && liveLeafId !== undefined && !opened.isRunning()) {
      const diskLatest = readLatestSessionEntryId(opened.sessionFile);
      if (diskLatest && !opened.inner.sessionManager.getEntry(diskLatest)) liveLeafId = undefined;
    }
    const requestedLeafId = typeof body.leafId === "string" ? body.leafId : liveLeafId;
    const systemPrompt = opened?.isAlive()
      ? (opened.inner.agent?.state?.systemPrompt || opened.inner.systemPrompt)
      : undefined;
    const tools = opened?.isAlive() ? opened.inner.agent?.state?.tools : undefined;

    const result: ShareSessionResult = await shareSessionBranch({
      sessionPath: sourcePath,
      leafId: requestedLeafId,
      systemPrompt,
      tools,
    });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof SessionShareError) {
      if (error.code === "not_found") {
        invalidateSessionPathCache(id);
        invalidateSessionListCache();
        return refusal(404, error.code, error.message);
      }
      const status =
        error.code === "empty"
        || error.code === "radius_unconfigured"
        || error.code === "gh_missing"
        || error.code === "gh_unauthenticated"
          ? 409
          : 502;
      return refusal(status, error.code, error.message);
    }
    return refusal(500, "failed", error instanceof Error ? error.message : String(error));
  }
}
