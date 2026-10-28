import { spawn } from "child_process";
import path from "path";

/**
 * 系统自带的「选择文件夹」对话框，由服务端在本机弹出。
 * 浏览器拿不到本地文件夹的绝对路径（showDirectoryPicker、webkitdirectory 都只给名字），
 * 所以只有浏览器和服务在同一台机器时才做得到；调用方先用 isLoopbackHost 判断，
 * 没有系统对话框的地方一律回到应用内的 DirectoryPicker。
 */

/**
 * 各平台弹对话框的命令；没有的平台返回 null。
 * 第一版只有 macOS：Windows（PowerShell）、Linux（zenity / kdialog）在这里加一项即可，
 * 但没法在本机实测，先不写。
 * prompt 当 argv 传而不是拼进脚本：脚本是常量，浏览器给的文字碰不到脚本。
 * 不要加 `tell me to activate`：实测没有它对话框也在最前面（模态面板层级，osascript 成为前台应用），
 * 加了它对话框反而要晚约 2 秒才出现（约 3.2 秒 vs 1.3 秒）。
 */
export function folderDialogCommand(
  platform: string,
  prompt: string,
): { command: string; args: string[] } | null {
  if (platform !== "darwin") return null;
  return {
    command: "osascript",
    args: [
      "-e", "on run argv",
      "-e", "return POSIX path of (choose folder with prompt (item 1 of argv))",
      "-e", "end run",
      prompt,
    ],
  };
}

export type FolderDialogResult = { path: string } | { cancelled: true };

/**
 * 弹出对话框，等用户选完。取消得 { cancelled: true }；命令起不来或异常退出则 reject，
 * 调用方回退到应用内选择器。signal 中止（浏览器断开）时把对话框关掉，免得留一个没人等的窗口。
 */
export function pickFolderNatively(
  prompt: string,
  signal: AbortSignal,
  platform: string = process.platform,
): Promise<FolderDialogResult> {
  const spec = folderDialogCommand(platform, prompt);
  if (!spec) return Promise.reject(new Error(`Unsupported platform: ${platform}`));
  if (signal.aborted) return Promise.resolve({ cancelled: true });

  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    const closeDialog = () => { child.kill(); };
    signal.addEventListener("abort", closeDialog, { once: true });

    child.once("error", (error) => {
      signal.removeEventListener("abort", closeDialog);
      reject(error);
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", closeDialog);
      if (code === 0) {
        const picked = stdout.trim();
        // macOS 给的路径以 / 结尾（"/Users/me/proj/"），去掉它。
        resolve(picked ? { path: path.resolve(picked) } : { cancelled: true });
        return;
      }
      // osascript 的「取消」：退出码 1，stderr 里带 -128（User canceled）；被 abort 关掉的也算取消。
      if (signal.aborted || /\(-128\)/.test(stderr)) {
        resolve({ cancelled: true });
        return;
      }
      reject(new Error(stderr.trim() || `${spec.command} exited with ${code}`));
    });
  });
}
