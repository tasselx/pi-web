import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { NextResponse } from "next/server";
import { pickSaveFileNatively, saveFileDialogCommand } from "@/lib/native-folder-dialog";
import { isLoopbackHost } from "@/lib/open-in-file-manager";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { exportSessionContent, normalizeExportFormat } from "@/lib/session-export";
import { resolveSessionPath } from "@/lib/session-reader";

export const runtime = "nodejs";

let saveDialogOpen = false;

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function getContentDisposition(fileName: string, inline: boolean): string {
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "session.html";
  const disposition = inline ? "inline" : "attachment";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const searchParams = new URL(req.url).searchParams;
  const inline = searchParams.get("inline") === "1";
  const format = normalizeExportFormat(searchParams.get("format"));
  const leafId = searchParams.get("leafId")?.trim() || null;

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const { content, contentType, fileName } = await exportSessionContent(filePath, format, leafId);
    return new Response(content, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": getContentDisposition(fileName, inline && format === "html"),
        "Cache-Control": "no-cache",
        "Content-Security-Policy": "frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  if (!isLoopbackHost(req.headers.get("host"))) {
    return NextResponse.json({ error: "remote" }, { status: 403 });
  }
  if (typeof saveFileDialogCommand !== "function" || !saveFileDialogCommand(process.platform, "", "")) {
    return NextResponse.json({ error: "unsupported-platform" }, { status: 403 });
  }
  if (saveDialogOpen) {
    return NextResponse.json({ error: "busy" }, { status: 409 });
  }

  const { id } = await params;
  const filePath = await resolveSessionPath(id);
  if (!filePath) {
    return NextResponse.json({ error: "Session not found", stage: "export" }, { status: 404 });
  }

  saveDialogOpen = true;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      format?: string;
      leafId?: string | null;
      prompt?: string;
    };
    const format = normalizeExportFormat(body.format);
    const leafId = typeof body.leafId === "string" && body.leafId.trim() ? body.leafId.trim() : null;
    const prompt = typeof body.prompt === "string" && body.prompt.trim()
      ? body.prompt.trim().slice(0, 200)
      : "Export session";

    let exported: Awaited<ReturnType<typeof exportSessionContent>>;
    try {
      exported = await exportSessionContent(filePath, format, leafId);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : String(error), stage: "export" },
        { status: 500 },
      );
    }

    let choice: Awaited<ReturnType<typeof pickSaveFileNatively>>;
    try {
      choice = await pickSaveFileNatively(prompt, exported.fileName, req.signal);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : String(error), stage: "dialog" },
        { status: 503 },
      );
    }

    if ("cancelled" in choice) {
      return NextResponse.json({ cancelled: true });
    }
    mkdirSync(dirname(choice.path), { recursive: true });
    writeFileSync(choice.path, exported.content, "utf-8");
    return NextResponse.json({ savedPath: choice.path });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), stage: "export" },
      { status: 500 },
    );
  } finally {
    saveDialogOpen = false;
  }
}
