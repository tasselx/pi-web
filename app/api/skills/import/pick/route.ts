import { NextResponse } from "next/server";
import { fileDialogCommand, folderDialogCommand, pickFileNatively, pickFolderNatively } from "@/lib/native-folder-dialog";
import { isLoopbackHost } from "@/lib/open-in-file-manager";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let dialogOpen = false;

// POST /api/skills/import/pick body: { mode?: "file" | "folder"; prompt?: string }
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  if (!isLoopbackHost(request.headers.get("host"))) {
    return NextResponse.json({ error: "remote" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { mode?: unknown; prompt?: unknown };
  const mode = body.mode === "folder" ? "folder" : "file";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 200) : "";

  const hasCommand = mode === "folder"
    ? Boolean(folderDialogCommand(process.platform, ""))
    : Boolean(fileDialogCommand(process.platform, ""));

  if (!hasCommand) {
    return NextResponse.json({ error: "unsupported-platform" }, { status: 403 });
  }
  if (dialogOpen) {
    return NextResponse.json({ error: "busy" }, { status: 409 });
  }

  dialogOpen = true;
  try {
    if (mode === "folder") {
      return NextResponse.json(await pickFolderNatively(prompt, request.signal));
    }
    return NextResponse.json(await pickFileNatively(prompt, request.signal));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  } finally {
    dialogOpen = false;
  }
}
