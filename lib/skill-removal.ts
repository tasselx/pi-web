import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  SkillInfo,
  SkillInstallInfo,
  SkillInstallScope,
  SkillRemovalInfo,
} from "@/lib/api-types";
import { runNpx } from "@/lib/npx";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { getSkillRoots, isWithin } from "@/lib/skill-lock";
import { buildSkillUpdateArgs } from "@/lib/skill-updates";

// 设置 › 技能的「移除」与 60 秒内「撤销」（与设置 › MCP 的移除撤销同一套思路，见 lib/mcp-undo.ts）。
// 两种移法：
// - files：技能不是 skills CLI 装的（自己放的、导入的），把它的文件夹整个挪进同目录的暂存区，
//   60 秒内撤销就挪回原处，过期才真删；
// - cli：skills CLI 装的（锁文件里有记录），交给 `npx skills remove`，它会连锁文件一起清；
//   撤销则按锁文件里的来源重新安装（要联网）。
// 登记表放在 globalThis 上：路由各自打包、热更新会重新执行模块；服务重启只是让撤销提前结束。

/** 移除后可撤销的时长。 */
export const SKILL_UNDO_TTL_MS = 60_000;
/** 同时暂存的移除数；超出时最早的那个直接真删。 */
const MAX_HELD = 20;
/**
 * 暂存区的目录名，建在被移走的东西的同一个目录里：必在同一块磁盘，挪动只是 rename，
 * 不必处理跨盘复制中途失败。pi 加载技能时跳过点开头的条目，所以暂存期间不会被当成技能。
 */
const HOLD_DIR = ".pi-web-removed";
const CLI_TIMEOUT_MS = 60_000;
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

interface RemovalOptions {
  cwd: string;
  agentDir: string;
  homeDir?: string;
}

/** 带 HTTP 状态的拒绝：路由原样回给浏览器（服务端的错误文本不翻译）。 */
export class SkillRemovalError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * 经过符号链接后，条目的父目录仍在技能目录里。路径中间有一层链接到别处时，
 * 字符串上看着在技能目录里，实际会动到别处的东西，这种一律不移。
 */
function staysInside(path: string, root: string): boolean {
  try {
    const parent = realpathSync(dirname(path));
    const realRoot = realpathSync(root);
    return parent === realRoot || isWithin(parent, realRoot);
  } catch {
    return false;
  }
}

/**
 * 这个技能能不能在这里移除、怎么移、移的是哪一项。只认 pi 的四个技能目录里的技能；
 * 插件提供的、settings 里配置的路径，不归这里管，返回 undefined。
 */
export function resolveSkillRemoval(
  skill: SkillInfo,
  { cwd, agentDir, homeDir = homedir() }: RemovalOptions,
): SkillRemovalInfo | undefined {
  const roots = getSkillRoots({ cwd, agentDir, homeDir });
  const dir = dirname(skill.filePath);
  // 文件夹技能（skill.md，大小写不论：CLI 装的技能里就有小写的）整个文件夹一起走；
  // 单文件技能只走那个文件，而且只认直接放在技能目录根上的 .md。别处冒出来的 .md
  // （settings 里写的路径等）所在的文件夹可能还装着别的技能，不碰。
  const isFolderSkill = basename(skill.filePath).toLowerCase() === "skill.md";
  const path = isFolderSkill ? dir : skill.filePath;
  for (const scope of ["global", "project"] as const) {
    const root = roots[scope].find((candidate) => isWithin(skill.filePath, candidate));
    if (!root) continue;
    // isWithin 是严格包含：SKILL.md 直接放在技能目录根上时 path 就是目录本身，不会通过
    if (!isWithin(path, root) || (!isFolderSkill && isWithin(dir, root))) return undefined;
    if (!staysInside(path, root)) return undefined;
    return { method: skill.install ? "cli" : "files", path, scope };
  }
  return undefined;
}

export function annotateSkillsWithRemoval(skills: SkillInfo[], options: RemovalOptions): SkillInfo[] {
  return skills.map((skill) => {
    const removal = resolveSkillRemoval(skill, options);
    return removal ? { ...skill, removal } : skill;
  });
}

/** 暂存期间要留住的东西，以及撤销时怎么放回去。 */
interface Held {
  token: string;
  name: string;
  scope: SkillInstallScope;
  cwd: string;
  /** 撤销后列表里重新出现的技能文件。 */
  filePath: string;
  /** 被移走的文件夹（或单文件）原来的位置。 */
  path: string;
  /** 暂存到期的时刻（本进程的时钟）。 */
  expiresAt: number;
  how: { method: "files"; heldPath: string } | { method: "cli"; install: SkillInstallInfo };
}

interface HeldRecord extends Held {
  timer: ReturnType<typeof setTimeout>;
}

const STORE_KEY: symbol = Symbol.for("pi-web:skill-removal");

function records(): Map<string, HeldRecord> {
  const store = globalThis as Record<symbol, Map<string, HeldRecord> | undefined>;
  return (store[STORE_KEY] ??= new Map());
}

/** 把记录移出登记表并停掉它的计时器；它留住的文件由调用方决定保留还是删除。 */
function forget(record: HeldRecord): void {
  clearTimeout(record.timer);
  // 只删这一条：同一个令牌可能已被放回成了新记录
  if (records().get(record.token) === record) records().delete(record.token);
}

/** 暂存结束：等着撤销的文件真正删掉。清理失败不影响别的，只记一笔。 */
function discard(held: Held): void {
  if (held.how.method !== "files") return;
  const holdDir = dirname(held.how.heldPath);
  try {
    rmSync(holdDir, { recursive: true, force: true });
    // 暂存区空了就一并删掉，别在用户的技能目录里留个空壳；还有别的暂存时 rmdir 会失败，留着即可
    try {
      rmdirSync(dirname(holdDir));
    } catch {
      /* 非空 */
    }
  } catch (error) {
    console.warn(`[skills/remove] could not delete ${holdDir}:`, error);
  }
}

function hold(held: Held, now: number): void {
  const map = records();
  while (map.size >= MAX_HELD) {
    const oldest = map.values().next().value as HeldRecord;
    forget(oldest);
    discard(oldest);
  }
  const record = { ...held } as HeldRecord;
  record.timer = setTimeout(() => {
    forget(record);
    discard(record);
  }, Math.max(0, held.expiresAt - now));
  // 等着撤销的东西不该拖住进程退出
  record.timer.unref?.();
  map.set(held.token, record);
}

/** 取走令牌对应的暂存，仅一次；过期的或未知的返回 undefined。失败的撤销用 giveBack 放回。 */
function take(token: string, now = Date.now()): Held | undefined {
  const record = records().get(token);
  if (!record) return undefined;
  forget(record);
  const { timer, ...held } = record;
  void timer;
  if (held.expiresAt <= now) {
    discard(held);
    return undefined;
  }
  return held;
}

/** 撤销失败时把暂存放回去，剩余时间照旧。 */
function giveBack(held: Held, now = Date.now()): void {
  if (held.expiresAt <= now || records().has(held.token)) return;
  hold(held, now);
}

/** 上一个进程没来得及清的暂存（服务在 60 秒内被停掉时留下的），在下一次移除时顺手清掉。 */
function sweepOrphans(holdRoot: string): void {
  const live = new Set(records().keys());
  try {
    for (const name of readdirSync(holdRoot)) {
      if (!live.has(name)) rmSync(join(holdRoot, name), { recursive: true, force: true });
    }
  } catch {
    /* 没有暂存区，或读不了：不影响这次移除 */
  }
}

/** lstat 而不是 existsSync：一个指向已删除目标的悬空链接也算「还在那里」。 */
function occupied(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 项目目录里跑 npx 会优先用项目自己的 node_modules/.bin，所以和安装一样，
 * 项目范围的 CLI 操作要求该项目已被信任。
 */
function assertTrustedForCli(scope: SkillInstallScope, cwd: string): void {
  if (scope === "project" && !getProjectTrustStatus(cwd, getAgentDir()).trusted) {
    throw new SkillRemovalError("Project resources must be trusted before changing project skills", 403);
  }
}

/** 跑 skills CLI，返回去掉终端控制码的输出；失败时抛出带输出末尾的错误。 */
async function runSkillsCli(args: string[], scope: SkillInstallScope, cwd: string): Promise<string> {
  console.log(`[skills/remove] running: npx ${args.join(" ")}`);
  try {
    const { stdout, stderr } = await runNpx(args, {
      timeout: CLI_TIMEOUT_MS,
      cwd: scope === "project" ? cwd : undefined,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    return `${stdout}${stderr}`.replace(ANSI_RE, "").trim();
  } catch (error: unknown) {
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    const output = `${detail.stdout ?? ""}${detail.stderr ?? ""}`.replace(ANSI_RE, "").trim();
    throw new SkillRemovalError((output || detail.message || String(error)).slice(-300), 500);
  }
}

/**
 * 移除一个技能并暂存 60 秒。`removal` 是列表时算好的结果，路由已确认它属于当前 cwd 加载的技能。
 * 返回令牌和暂存到期的时刻。
 */
export async function removeSkill(
  skill: SkillInfo,
  removal: SkillRemovalInfo,
  cwd: string,
): Promise<{ token: string; expiresAt: number }> {
  const token = randomUUID();
  let how: Held["how"];

  if (removal.method === "cli") {
    const install = skill.install;
    if (!install) throw new SkillRemovalError("This skill has no skills CLI install record", 409);
    // 名字来自 SKILL.md / 锁文件：以 - 开头的会被 CLI 当成选项（--all 会清掉所有技能）
    if (!skill.name || skill.name.startsWith("-")) {
      throw new SkillRemovalError("This skill's name cannot be passed to the skills CLI", 409);
    }
    assertTrustedForCli(removal.scope, cwd);
    // 不能带 --agent pi：只卸载 pi 时，只要机器上还有别的已安装代理（Cursor、Codex 等）共用
    // .agents/skills，CLI 就保留目录和锁条目，却仍然报告「已移除」。不指定代理才是整体卸载。
    const args = ["skills", "remove", skill.name, "-y"];
    if (removal.scope === "global") args.push("-g");
    const output = await runSkillsCli(args, removal.scope, cwd);
    // CLI 找不到同名技能、或文件因故保留时也以 0 退出，所以以「文件确实没了」为准，不看退出码
    if (existsSync(skill.filePath)) {
      throw new SkillRemovalError(
        `The skills CLI did not remove ${skill.name}: ${output.slice(-300) || "no output"}`,
        500,
      );
    }
    how = { method: "cli", install };
  } else {
    const holdRoot = join(dirname(removal.path), HOLD_DIR);
    sweepOrphans(holdRoot);
    const holdDir = join(holdRoot, token);
    const heldPath = join(holdDir, basename(removal.path));
    mkdirSync(holdDir, { recursive: true });
    try {
      renameSync(removal.path, heldPath);
    } catch (error) {
      // 没挪成：技能还在原处，只清掉刚建的空暂存目录
      rmSync(holdDir, { recursive: true, force: true });
      try {
        rmdirSync(holdRoot);
      } catch {
        /* 非空 */
      }
      throw error;
    }
    how = { method: "files", heldPath };
  }

  // 到期时刻在移除完成后才算：CLI 最长要跑 60 秒，不能吃掉撤销的时间
  const now = Date.now();
  const expiresAt = now + SKILL_UNDO_TTL_MS;
  hold({ token, name: skill.name, scope: removal.scope, cwd, filePath: skill.filePath, path: removal.path, expiresAt, how }, now);
  return { token, expiresAt };
}

/** 撤销令牌对应的移除，返回重新出现的技能文件。令牌只能用一次；失败的撤销把暂存放回去。 */
export async function restoreSkill(token: string): Promise<{ filePath: string; name: string }> {
  const held = take(token);
  if (!held) throw new SkillRemovalError("This removal can no longer be undone", 410);
  try {
    if (held.how.method === "files") {
      // 原处又有了同名的东西：不覆盖，留着暂存让用户处理后再试
      if (occupied(held.path)) {
        throw new SkillRemovalError(`${basename(held.path)} exists again, so the removed one was not put back`, 409);
      }
      mkdirSync(dirname(held.path), { recursive: true });
      renameSync(held.how.heldPath, held.path);
      discard(held);
    } else {
      assertTrustedForCli(held.scope, held.cwd);
      // 与「更新」同一套参数：按锁文件记录的来源、子目录和版本引用重新安装这一个技能
      const output = await runSkillsCli(buildSkillUpdateArgs(held.how.install), held.scope, held.cwd);
      if (!existsSync(held.filePath)) {
        throw new SkillRemovalError(
          `The skills CLI did not bring ${held.name} back: ${output.slice(-300) || "no output"}`,
          500,
        );
      }
    }
  } catch (error) {
    giveBack(held);
    throw error;
  }
  return { filePath: held.filePath, name: held.name };
}
