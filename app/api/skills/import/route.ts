import { NextResponse } from "next/server";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import path from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { parseFrontmatter } from "@/lib/frontmatter";

export const dynamic = "force-dynamic";

const VALID_NAME_RE = /^[a-zA-Z0-9_\-.]{1,100}$/;
// 全由点组成的名字（".", "..", "..."）不能当技能目录名：path.join 会落回 skills 目录本身或其上一级
// （agent 目录 / 项目的 .pi），目录导入的 cpSync 还会把源文件夹内容覆盖进去；Windows 也会吃掉末尾的点
const DOTS_ONLY_RE = /^\.+$/;

function sanitizeSkillName(rawName: string): string {
  const trimmed = rawName.trim();
  if (VALID_NAME_RE.test(trimmed) && !DOTS_ONLY_RE.test(trimmed)) {
    return trimmed;
  }
  // Sanitize non-standard characters
  const sanitized = trimmed
    .replace(/[^a-zA-Z0-9_\-.]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  // 清洗只替换非法字符，".." 全是合法字符会原样留下；之前只在上面那道门挡了 ".."，掉进这里就被放行，
  // 所以对清洗结果再查一次，只剩点的名字一律改用兜底名
  if (!sanitized || DOTS_ONLY_RE.test(sanitized)) return `skill-${Date.now().toString(36)}`;
  return sanitized;
}

interface ImportSkillPayload {
  scope?: "global" | "project";
  cwd?: string;
  name?: string;
  content?: string;
  sourcePath?: string;
}

// POST /api/skills/import
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = (await req.json()) as ImportSkillPayload;
    const { scope = "global", cwd, sourcePath, content } = body;

    const isGlobal = scope !== "project";
    if (!isGlobal) {
      if (!cwd) {
        return NextResponse.json({ error: "cwd required for project skill import" }, { status: 400 });
      }
      const allowedRoots = await getAllowedFileRoots();
      if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
      if (!getProjectTrustStatus(cwd, getAgentDir()).trusted) {
        return NextResponse.json(
          { error: "Project resources must be trusted before importing project skills" },
          { status: 403 },
        );
      }
    }

    if (!sourcePath?.trim() && !content?.trim()) {
      return NextResponse.json({ error: "sourcePath or content required" }, { status: 400 });
    }

    const agentDir = getAgentDir();
    const skillsRoot = isGlobal
      ? path.join(agentDir, "skills")
      : path.join(cwd!, ".pi", "skills");

    let finalName = body.name?.trim();
    let skillContent = content?.trim() ?? "";

    if (sourcePath?.trim()) {
      const resolvedSource = path.resolve(sourcePath.trim());
      if (!existsSync(resolvedSource)) {
        return NextResponse.json({ error: "Source path does not exist" }, { status: 404 });
      }

      const st = statSync(resolvedSource);
      if (st.isDirectory()) {
        // Look for SKILL.md or any .md
        const entries = readdirSync(resolvedSource);
        const skillMd = entries.find((e) => e.toLowerCase() === "skill.md") ?? entries.find((e) => e.endsWith(".md"));
        if (!skillMd) {
          return NextResponse.json(
            { error: "No SKILL.md or markdown file found in the source directory" },
            { status: 400 },
          );
        }

        const skillMdPath = path.join(resolvedSource, skillMd);
        skillContent = readFileSync(skillMdPath, "utf8");

        if (!finalName) {
          const fm = parseFrontmatter(skillContent);
          finalName = (fm.data?.name as string) || path.basename(resolvedSource);
        }
        finalName = sanitizeSkillName(finalName);

        const targetDir = path.join(skillsRoot, finalName);
        mkdirSync(targetDir, { recursive: true });

        // Copy directory contents
        cpSync(resolvedSource, targetDir, { recursive: true });

        // Ensure canonical SKILL.md exists
        const canonicalTargetFile = path.join(targetDir, "SKILL.md");
        if (!existsSync(canonicalTargetFile)) {
          writeFileSync(canonicalTargetFile, skillContent, "utf8");
        }

        return NextResponse.json({
          success: true,
          name: finalName,
          filePath: canonicalTargetFile,
          scope,
        });
      } else {
        // Single file
        if (!resolvedSource.toLowerCase().endsWith(".md")) {
          return NextResponse.json({ error: "Skill file must be a markdown (.md) file" }, { status: 400 });
        }
        skillContent = readFileSync(resolvedSource, "utf8");
        if (!finalName) {
          const fm = parseFrontmatter(skillContent);
          finalName = (fm.data?.name as string) || path.basename(resolvedSource, path.extname(resolvedSource));
        }
      }
    }

    if (!finalName) {
      const fm = parseFrontmatter(skillContent);
      finalName = (fm.data?.name as string) || "imported-skill";
    }
    finalName = sanitizeSkillName(finalName);

    const targetDir = path.join(skillsRoot, finalName);
    mkdirSync(targetDir, { recursive: true });
    const targetFile = path.join(targetDir, "SKILL.md");
    writeFileSync(targetFile, skillContent, "utf8");

    return NextResponse.json({
      success: true,
      name: finalName,
      filePath: targetFile,
      scope,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
