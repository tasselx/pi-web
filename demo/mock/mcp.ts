/**
 * 设置 › MCP：静态演示里没有 mcp.json，也连不上任何服务。总览按「没配置过服务」如实回答
 * （Code mode 的选择、设置 › 插件里的内置扩展开关照常生效，它们存在 settings-state 里）；
 * 增删、测试、登录这些要真的服务才能做的事，一律给演示提示，不伪造成功。
 */
import type { McpConfigFileInfo, McpResponse, ProjectTrustStatus } from "@/lib/api-types";
import { error, json, type MockRequest } from "./http";
import { AGENT_DIR } from "./paths";
import { CODEMODE_INLINE_BUDGET_DEFAULT, CODEMODE_INLINE_BUDGET_MAX, settings } from "./settings-state";
import { demoOnlyMessage } from "./unavailable";

/** 演示里的文件夹都不需要信任：信任对话框和 MCP 面板里的信任提示因此都不会出现。 */
export const DEMO_PROJECT_TRUST: ProjectTrustStatus = {
  requiresTrust: false,
  trusted: true,
  decision: null,
  inherited: false,
};

function overview(cwd: string | null): McpResponse {
  const settingsPath = `${AGENT_DIR}/settings.json`;
  const switches = settings.builtinExtensions;
  const files: McpConfigFileInfo[] = [{ scope: "global", path: `${AGENT_DIR}/mcp.json`, exists: false, problems: [] }];
  if (cwd) files.push({ scope: "project", path: `${cwd}/.pi/mcp.json`, exists: false, problems: [] });
  return {
    // 三个内置扩展被关掉时的说法与主应用 lib/mcp-config-read.ts 一致：面板据此显示「已关闭」提示。
    mcp: switches.mcp
      ? { available: true }
      : { available: false, reason: "builtin-disabled", error: "the extensions setting turns builtin:mcp off", settingsPath },
    codemode: {
      preference: settings.codemode,
      sandbox: { state: "available" },
      builtinDisabled: !switches.codemode,
      ...(switches.codemode ? {} : { builtinSettingsPath: settingsPath, globalBuiltinSettingsPath: settingsPath }),
      mode: { ...settings.codemodeMode, settingsPath },
      inlineBudget: { ...settings.codemodeInlineBudget, settingsPath, default: CODEMODE_INLINE_BUDGET_DEFAULT, max: CODEMODE_INLINE_BUDGET_MAX },
    },
    ...(switches["tool-search"] ? {} : { toolSearchDisabled: { settingsPath } }),
    files,
    servers: [],
    ...(cwd ? { project: { cwd, trust: DEMO_PROJECT_TRUST } } : {}),
  };
}

/** GET /api/mcp 读总览；/api/mcp 的写入以及 /api/mcp/test、/api/mcp/sign-in 都要真的服务。 */
export function mcpRoute(request: MockRequest): Response {
  if (request.method === "GET" && request.segments.length === 2) return json(overview(request.query("cwd")));
  return error(demoOnlyMessage(), 501);
}
