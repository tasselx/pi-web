import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * Patch the exported HTML to fix recursive functions that overflow
 * the call stack on deep linear session trees (e.g., 5000+ entries).
 */
export function patchExportHtml(html: string): string {
  const n = (s: string) => s.replace(/\r\n/g, "\n");
  html = n(html);

  const replaceRequired = (source: string, name: string, search: string, replacement: string) => {
    const normalizedSearch = n(search);
    const normalizedReplacement = n(replacement);
    const matches = source.split(normalizedSearch).length - 1;
    if (matches !== 1) {
      throw new Error(`Failed to patch exported HTML: ${name} expected 1 match, found ${matches}`);
    }
    return source.replace(normalizedSearch, normalizedReplacement);
  };

  html = replaceRequired(
    html,
    "sortChildren",
    `        function sortChildren(node) {
          node.children.sort((a, b) =>
            new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
          );
          node.children.forEach(sortChildren);
        }`,
    `        function sortChildren(root) {
          const stack = [root];
          while (stack.length) {
            const node = stack.pop();
            node.children.sort((a, b) =>
              new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
            );
            for (let i = node.children.length - 1; i >= 0; i--) {
              stack.push(node.children[i]);
            }
          }
        }`,
  );

  html = replaceRequired(
    html,
    "mapNodes",
    `          function mapNodes(node) {
            treeNodeMap.set(node.entry.id, node);
            node.children.forEach(mapNodes);
          }
          tree.forEach(mapNodes);`,
    `          const stack = [...tree].reverse();
          while (stack.length) {
            const node = stack.pop();
            treeNodeMap.set(node.entry.id, node);
            for (let i = node.children.length - 1; i >= 0; i--) {
              stack.push(node.children[i]);
            }
          }`,
  );

  html = replaceRequired(
    html,
    "markActive",
    `        function markActive(node) {
          let has = activePathIds.has(node.entry.id);
          for (const child of node.children) {
            if (markActive(child)) has = true;
          }
          containsActive.set(node, has);
          return has;
        }`,
    `        function markActive(root) {
          // Post-order traversal using two stacks
          const stack1 = [root];
          const stack2 = [];
          while (stack1.length) {
            const node = stack1.pop();
            stack2.push(node);
            for (const child of node.children) {
              stack1.push(child);
            }
          }
          while (stack2.length) {
            const node = stack2.pop();
            let has = activePathIds.has(node.entry.id);
            for (const child of node.children) {
              if (containsActive.get(child)) has = true;
            }
            containsActive.set(node, has);
          }
        }`,
  );

  return html;
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
 * Export a session `.jsonl` file to `outputPath` as standalone HTML and apply
 * the iterative tree-walk patch (`patchExportHtml`). Returns the patched HTML.
 */
export async function exportSessionHtmlToFile(filePath: string, outputPath: string): Promise<string> {
  await runPiHtmlExport(filePath, outputPath);
  const html = readFileSync(outputPath, "utf8");
  const patchedHtml = patchExportHtml(html);
  writeFileSync(outputPath, patchedHtml, "utf8");
  return patchedHtml;
}
