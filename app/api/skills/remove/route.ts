import { NextResponse } from "next/server";
import type { SkillRemoveResponse, SkillRestoreResponse } from "@/lib/api-types";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { removeSkill, restoreSkill, SkillRemovalError } from "@/lib/skill-removal";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";

export const dynamic = "force-dynamic";

// POST /api/skills/remove
//   { action: "remove", cwd, filePath }  → SkillRemoveResponse (undo token held for 60 s)
//   { action: "undo", token }            → SkillRestoreResponse
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  const body = (await req.json().catch(() => null)) as {
    action?: unknown;
    cwd?: unknown;
    filePath?: unknown;
    token?: unknown;
  } | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    if (body.action === "undo") {
      const token = typeof body.token === "string" ? body.token : "";
      if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });
      const restored: SkillRestoreResponse = await restoreSkill(token);
      return NextResponse.json(restored);
    }
    if (body.action !== "remove") {
      return NextResponse.json({ error: "action must be remove or undo" }, { status: 400 });
    }

    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    const filePath = typeof body.filePath === "string" ? body.filePath : "";
    if (!cwd || !filePath) {
      return NextResponse.json({ error: "cwd and filePath required" }, { status: 400 });
    }
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // 只认这个 cwd 实际加载出来的技能，并用服务端自己算的移除方式：
    // 浏览器给的 filePath 只是选中哪一个，不能让它指向任意文件
    const { skills } = await loadSkillsWithInstallInfo(cwd);
    const skill = skills.find((item) => item.filePath === filePath);
    if (!skill) return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    if (!skill.removal) {
      return NextResponse.json(
        { error: "This skill is not in a skills folder, so it cannot be removed here" },
        { status: 409 },
      );
    }

    const { token, expiresAt } = await removeSkill(skill, skill.removal, cwd);
    const removed: SkillRemoveResponse = {
      token,
      name: skill.name,
      expiresInMs: Math.max(0, expiresAt - Date.now()),
    };
    return NextResponse.json(removed);
  } catch (error: unknown) {
    if (error instanceof SkillRemovalError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
