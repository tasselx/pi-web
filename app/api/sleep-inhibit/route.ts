import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getSleepInhibitor } from "@/lib/sleep-inhibitor";
import { writePreventSleep } from "@/lib/sleep-inhibit-settings";

export const dynamic = "force-dynamic";

// Settings › General 的「运行时防止系统休眠」：开关存在全局 settings.json（piWebPreventSleep），
// 由服务端所在的这台机器执行，所以远程访问时作用在真正跑 agent 的主机上，与浏览器无关。
// GET 回开关和这台机器上的实际状态；PUT { enabled } 保存并立即生效，回复里是拿到或放掉锁之后的真实状态。

function errorResponse(error: unknown) {
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

export async function GET() {
  const inhibitor = getSleepInhibitor();
  await inhibitor.ready();
  return NextResponse.json(inhibitor.status());
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }

  const inhibitor = getSleepInhibitor();
  await inhibitor.ready();
  const current = inhibitor.status();
  // 不能防休眠的机器上不接受「开」：否则开关亮着却什么都没做。「关」照常接受，用来清掉别处同步来的旧值。
  if (enabled && !current.supported) {
    return NextResponse.json({ ...current, error: current.unsupportedReason ?? "Preventing system sleep is not supported here." }, { status: 409 });
  }
  try {
    await writePreventSleep(enabled);
    return NextResponse.json(await inhibitor.setEnabled(enabled));
  } catch (error) {
    return errorResponse(error);
  }
}
