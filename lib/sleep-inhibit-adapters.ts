import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join, win32 } from "node:path";

// 「运行时防止系统休眠」在各个系统上怎么拿锁。每个系统给出若干「持锁命令」，由 lib/sleep-inhibitor.ts 起成子进程：
//   - 它拿到系统的防休眠锁之后，在 stdout 打一行 `ready`；
//   - 然后一直阻塞，直到 stdin 关闭（我们放锁时关它；Pi Web 退出或崩溃时操作系统替我们关它），
//     进程一退出，锁就由系统收回。
// 这样放锁、退出、崩溃都不依赖 Pi Web 自己做清理，也不会残留进程。
// 只拦「空闲后的自动睡眠」：不拦用户主动睡眠（菜单、合盖），也不让显示器常亮，不改任何电源方案。

/** 持锁命令拿到锁之后打的那一行。 */
export const HOLDER_READY_LINE = "ready";

/** 给系统看的占用原因（macOS 的 pmset、Linux 的 systemd-inhibit --list 里能看到）。 */
const REASON = "Pi Web is running a task";

/** POSIX：先报 ready，再让 cat 阻塞读 stdin；读到 EOF（stdin 关闭、父进程没了）就退出。 */
const POSIX_HOLD_SCRIPT = `echo ${HOLDER_READY_LINE}; exec cat >/dev/null`;

/**
 * Windows：SetThreadExecutionState 只对调用它的线程生效，所以要在一条一直活着的线程上设置并阻塞：
 * PowerShell 主线程设好状态，再阻塞在读 stdin 上，进程退出时系统清掉状态。
 * 0x80000001 = ES_CONTINUOUS | ES_SYSTEM_REQUIRED：只拦系统空闲睡眠，不带 ES_DISPLAY_REQUIRED，屏幕照常熄。
 * 十进制写是因为 PowerShell 里 0x80000001 会被当成负的 Int32。
 */
const WINDOWS_HOLD_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -Namespace PiWeb -Name Power -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
  "[void][PiWeb.Power]::SetThreadExecutionState(2147483649)",
  `[Console]::Out.WriteLine('${HOLDER_READY_LINE}')`,
  "[Console]::Out.Flush()",
  "[void][Console]::In.ReadToEnd()",
].join("\n");

export interface HolderCommand {
  /** 日志和设置页里的名字。 */
  label: string;
  command: string;
  args: string[];
}

export type SleepInhibitPlan =
  /** `holders` 按顺序试，第一个拿到锁的为准（GNOME 上的首选可能连不上会话总线）。 */
  | { supported: true; holders: HolderCommand[] }
  | { supported: false; reason: string };

/** 判断「这台机器能不能」要看的东西，抽出来是为了在别的系统上用假环境测试。 */
export interface PlanEnvironment {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** PATH 上有没有这个可执行文件。 */
  hasCommand(name: string): boolean;
  fileExists(path: string): boolean;
}

export function currentPlanEnvironment(): PlanEnvironment {
  return {
    platform: process.platform,
    env: process.env,
    hasCommand: (name) => {
      for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
        if (!dir) continue;
        try {
          accessSync(join(dir, name), constants.X_OK);
          return true;
        } catch {
          // 下一个目录
        }
      }
      return false;
    },
    fileExists: existsSync,
  };
}

export function planSleepInhibitor(environment: PlanEnvironment = currentPlanEnvironment()): SleepInhibitPlan {
  switch (environment.platform) {
    case "darwin": return planMac(environment);
    case "linux": return planLinux(environment);
    case "win32": return planWindows(environment);
    default: return { supported: false, reason: `Preventing system sleep is not supported on ${environment.platform}.` };
  }
}

function planMac({ fileExists }: PlanEnvironment): SleepInhibitPlan {
  const caffeinate = "/usr/bin/caffeinate";
  if (!fileExists(caffeinate)) return { supported: false, reason: `caffeinate was not found at ${caffeinate}.` };
  // -i：只拦空闲睡眠。不带 -d（显示器照常熄屏）、-s、-u；用户手动睡眠不受影响。
  // 带一条命令时 caffeinate 替那条命令持有断言，命令一退出断言就没了。
  return { supported: true, holders: [{ label: "caffeinate", command: caffeinate, args: ["-i", "/bin/sh", "-c", POSIX_HOLD_SCRIPT] }] };
}

function planLinux({ env, hasCommand }: PlanEnvironment): SleepInhibitPlan {
  const holders: HolderCommand[] = [];
  // GNOME 的自动挂起只看 gnome-session 的 inhibit（suspend 位），不看 logind 的 idle 锁，所以 GNOME 上先用它。
  // 只要 suspend：不带 idle，屏幕照常变暗熄屏。会话总线连不上时它会失败，再退到下面的 logind。
  if (/(^|:)GNOME($|:)/i.test(env.XDG_CURRENT_DESKTOP ?? "") && hasCommand("gnome-session-inhibit")) {
    holders.push({
      label: "gnome-session-inhibit",
      command: "gnome-session-inhibit",
      args: ["--app-id", "pi-web", "--reason", REASON, "--inhibit", "suspend", "/bin/sh", "-c", POSIX_HOLD_SCRIPT],
    });
  }
  // logind（不假定 systemd：elogind 同样）。--what=idle 拦空闲后的自动睡眠；
  // 不用 sleep，那个连用户主动挂起也拦。
  const logind = ["systemd-inhibit", "elogind-inhibit"].find((name) => hasCommand(name));
  if (logind) {
    holders.push({
      label: logind,
      command: logind,
      args: ["--what=idle", "--who=Pi Web", `--why=${REASON}`, "--mode=block", "/bin/sh", "-c", POSIX_HOLD_SCRIPT],
    });
  }
  if (holders.length === 0) {
    return {
      supported: false,
      reason: "No sleep inhibitor was found. Install systemd (systemd-inhibit), elogind (elogind-inhibit) or, on GNOME, gnome-session-inhibit.",
    };
  }
  return { supported: true, holders };
}

function planWindows({ env, hasCommand, fileExists }: PlanEnvironment): SleepInhibitPlan {
  // Windows PowerShell 5.1 随系统自带；先用全路径，免得 PATH 被改过。win32.join：这是 Windows 的路径，在哪个系统上算都一样。
  const bundled = win32.join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = fileExists(bundled) ? bundled : hasCommand("powershell.exe") ? "powershell.exe" : null;
  if (!command) return { supported: false, reason: "Windows PowerShell was not found." };
  return {
    supported: true,
    holders: [{
      label: "powershell",
      command,
      // -EncodedCommand 要 UTF-16LE 的 Base64：脚本是常量，不经过任何转义。
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(WINDOWS_HOLD_SCRIPT, "utf16le").toString("base64")],
    }],
  };
}

/** 持锁进程的环境：整份继承（Linux 的 D-Bus 工具要会话总线的变量），只去掉 Pi Web 的登录口令。 */
export function holderEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of Object.keys(copy)) {
    if (key.toUpperCase() === "PI_WEB_PASSWORD") delete copy[key];
  }
  return copy;
}
