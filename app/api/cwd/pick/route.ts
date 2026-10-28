import { NextResponse } from "next/server";
import { folderDialogCommand, pickFolderNatively } from "@/lib/native-folder-dialog";
import { isLoopbackHost } from "@/lib/open-in-file-manager";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 同一时刻只开一个对话框：再点一次不会叠出第二个窗口。 */
let dialogOpen = false;

// POST /api/cwd/pick  body: { prompt?: string }
// 在运行服务的这台机器上弹出系统的「选择文件夹」对话框，用户选完或取消后才回。
// 回 { path } 或 { cancelled: true }（选出的路径还要过 /api/cwd/validate，这里不授权任何东西）。
// 403 remote / unsupported-platform：这里没有系统对话框，浏览器改用应用内选择器；
// 409 busy：已经有一个开着。
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  // 对话框开在服务端的屏幕上：只有浏览器和服务在同一台机器时才对得上（同「在访达中打开」）。
  if (!isLoopbackHost(request.headers.get("host"))) {
    return NextResponse.json({ error: "remote" }, { status: 403 });
  }
  if (!folderDialogCommand(process.platform, "")) {
    return NextResponse.json({ error: "unsupported-platform" }, { status: 403 });
  }
  if (dialogOpen) {
    return NextResponse.json({ error: "busy" }, { status: 409 });
  }

  dialogOpen = true;
  try {
    const body = await request.json().catch(() => ({})) as { prompt?: unknown };
    const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 200) : "";
    return NextResponse.json(await pickFolderNatively(prompt, request.signal));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  } finally {
    dialogOpen = false;
  }
}
