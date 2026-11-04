import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type PiCodingAgentModule = {
  getPackageDir: () => string;
};

type ExportHtmlModule = {
  exportFromFile: (inputPath: string, outputPath: string) => Promise<string>;
};

async function getPiPackageDir(): Promise<string | null> {
  try {
    const { getPackageDir } = (await import("@earendil-works/pi-coding-agent")) as PiCodingAgentModule;
    return getPackageDir();
  } catch {
    return null;
  }
}

async function getPiCliPath(): Promise<string | null> {
  const candidates = new Set<string>();
  const packageDir = await getPiPackageDir();

  if (packageDir) {
    candidates.add(join(packageDir, "dist", "cli.js"));
  }

  try {
    const resolver = (import.meta as ImportMeta & {
      resolve?: (specifier: string) => string | Promise<string>;
    }).resolve;
    if (typeof resolver === "function") {
      const indexUrl = await resolver("@earendil-works/pi-coding-agent");
      candidates.add(join(dirname(fileURLToPath(indexUrl)), "cli.js"));
    }
  } catch {
    // Next.js production bundles can strip import.meta.resolve.
  }

  candidates.add(
    join(
      process.cwd(),
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js",
    ),
  );

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function runPiHtmlExport(filePath: string, outputPath: string): Promise<void> {
  const cliPath = await getPiCliPath();
  if (cliPath) {
    await execFileAsync(process.execPath, [cliPath, "--export", filePath, outputPath], {
      cwd: process.cwd(),
      timeout: 30_000,
      env: {
        ...process.env,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
      },
      maxBuffer: 1024 * 1024,
    });
    return;
  }

  const packageDir = await getPiPackageDir();
  if (!packageDir) throw new Error("pi CLI not found");

  const exporterUrl = pathToFileURL(join(packageDir, "dist", "core", "export-html", "index.js")).href;
  const { exportFromFile } = (await import(exporterUrl)) as ExportHtmlModule;
  await exportFromFile(filePath, outputPath);
}

/**
 * Export a session `.jsonl` file to `outputPath` as standalone HTML. Returns
 * the HTML pi wrote, unchanged.
 */
export async function exportSessionHtmlToFile(filePath: string, outputPath: string): Promise<string> {
  await runPiHtmlExport(filePath, outputPath);
  // 上游 1fbf6c6：pi 1.5.0 的导出模板已改为迭代遍历，旧的字符串补丁匹配不到会让导出必抛错，故直接返回原文
  return readFileSync(outputPath, "utf8");
}
