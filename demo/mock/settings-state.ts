/** Mutable demo settings that the settings panels read and write. */
import type { CodemodeInlineBudgetSetting, CodemodeModeSetting, McpCodemodePreference } from "@/lib/api-types";

// 与主应用 lib/codemode-settings.ts 相同的两个数；那是服务端模块（读写 settings.json），demo 不拷贝。
export const CODEMODE_INLINE_BUDGET_DEFAULT = 3000;
export const CODEMODE_INLINE_BUDGET_MAX = 1_000_000;

interface DemoSettings {
  subagentsEnabled: boolean;
  subagentMaxConcurrent: number;
  powerShellEnabled: boolean;
  /** 设置 › 常规：缓存/费用提示开关；演示数据里没有缓存统计，所以只是个会记住的开关。 */
  cacheMissNotices: boolean;
  /** 设置 › MCP › Code mode 的三项选择，按 PUT /api/tools/settings 的口径存。 */
  codemode: McpCodemodePreference;
  codemodeMode: CodemodeModeSetting;
  codemodeInlineBudget: CodemodeInlineBudgetSetting;
  /** 设置 › 插件里 pi 自带的内置扩展（pi-web 实际加载的三个）：名字对应是否开启。 */
  builtinExtensions: Record<string, boolean>;
}

export const settings: DemoSettings = {
  subagentsEnabled: true,
  subagentMaxConcurrent: 10,
  powerShellEnabled: false,
  cacheMissNotices: false,
  codemode: "automatic",
  codemodeMode: { value: "on" },
  codemodeInlineBudget: {},
  builtinExtensions: { codemode: true, "tool-search": true, mcp: true },
};
