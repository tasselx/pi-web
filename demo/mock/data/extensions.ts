/** Sample plugin packages and skills.sh search results for the settings panels. */
import type { PluginsResponse, SkillSearchResult } from "@/lib/api-types";
import type { Localized } from "../locale";
import { AGENT_DIR, PROJECT_ROOT } from "../paths";

const notifyPath = `${AGENT_DIR}/npm/node_modules/@demo/pi-notify`;
const reviewPath = `${PROJECT_ROOT}/.pi/git/github.com/demo/pi-review-kit`;

export const PLUGINS_RESPONSE: PluginsResponse = {
  packages: [
    {
      source: "npm:@demo/pi-notify",
      scope: "global",
      canCheckForUpdates: true,
      filtered: false,
      disabled: false,
      installedPath: notifyPath,
      packageName: "@demo/pi-notify",
      version: "1.4.0",
      description: "Desktop notifications and a status-bar timer while the agent is working.",
      counts: { extensions: 1, skills: 0, prompts: 0, themes: 0 },
      resources: [
        { kind: "extension", name: "notify", path: `${notifyPath}/extensions/notify.ts`, relativePath: "extensions/notify.ts" },
      ],
      status: "loaded",
    },
    {
      source: "git:github.com/demo/pi-review-kit",
      scope: "project",
      canCheckForUpdates: true,
      filtered: false,
      disabled: false,
      installedPath: reviewPath,
      packageName: "pi-review-kit",
      version: "0.3.2",
      description: "Code review prompt templates, a reviewer skill and a high-contrast theme.",
      counts: { extensions: 0, skills: 1, prompts: 2, themes: 1 },
      resources: [
        { kind: "skill", name: "code-review", path: `${reviewPath}/skills/code-review/SKILL.md`, relativePath: "skills/code-review/SKILL.md" },
        { kind: "prompt", name: "review", path: `${reviewPath}/prompts/review.md`, relativePath: "prompts/review.md" },
        { kind: "prompt", name: "security-review", path: `${reviewPath}/prompts/security-review.md`, relativePath: "prompts/security-review.md" },
        { kind: "theme", name: "high-contrast", path: `${reviewPath}/themes/high-contrast.json`, relativePath: "themes/high-contrast.json" },
      ],
      status: "loaded",
    },
  ],
  standaloneExtensions: [],
  totals: { extensions: 1, skills: 1, prompts: 2, themes: 1 },
  diagnostics: [],
  projectResourcesLoaded: true,
};

/**
 * 两个示例 skill 的 SKILL.md：设置 › Skills 的详情页读它来显示说明。
 * 键是 captured/skills.json 里的 filePath；frontmatter 的描述与那份数据一致。
 */
export const SKILL_DOCUMENTS: Record<string, Localized> = {
  [`${AGENT_DIR}/skills/frontend-design/SKILL.md`]: {
    en: `---
name: frontend-design
description: Build polished, accessible UI with the project's design tokens. Use when creating or restyling React components.
---

# Frontend design

Build UI that matches the project's design system instead of inventing a new look.

## Workflow

1. Read the design tokens (colors, spacing, type scale) before writing any styles.
2. Reuse an existing component when one fits; extend it rather than copying it.
3. Check keyboard access, focus order and color contrast for every interactive element.
4. Look at the result at a narrow and a wide width before calling it done.

## Rules

- Use tokens, never raw hex values or pixel sizes.
- Every control gets a visible focus state and an accessible name.
`,
    zh: `---
name: frontend-design
description: Build polished, accessible UI with the project's design tokens. Use when creating or restyling React components.
---

# 前端设计

按项目已有的设计系统来做界面，不要另起一套样式。

## 流程

1. 写样式之前，先读设计令牌（颜色、间距、字号层级）。
2. 已有合适的组件就复用，需要时扩展它，不要复制一份。
3. 每个可交互元素都检查键盘可达性、焦点顺序和颜色对比度。
4. 做完之前，分别在窄屏和宽屏下看一遍结果。

## 规则

- 一律用令牌，不写裸的十六进制颜色或像素值。
- 每个控件都要有可见的焦点样式和可访问的名称。
`,
  },
  [`${AGENT_DIR}/skills/release-notes/SKILL.md`]: {
    en: `---
name: release-notes
description: Draft user-facing release notes from merged pull requests and commit history.
disable-model-invocation: true
---

# Release notes

Turn what shipped since the last tag into notes a user would want to read.

## Workflow

1. Find the last release tag and list the pull requests merged since.
2. Group the changes: new features, improvements, fixes.
3. Write each entry from the user's point of view; skip internal refactors.
4. Link every entry to its pull request.

## Output

A Markdown section headed with the version and date, ready to paste into the release page.
`,
    zh: `---
name: release-notes
description: Draft user-facing release notes from merged pull requests and commit history.
disable-model-invocation: true
---

# 发布说明

把上次打标签以来发布的内容，整理成用户愿意读的说明。

## 流程

1. 找到上一个发布标签，列出此后合并的拉取请求。
2. 把改动分组：新功能、改进、修复。
3. 每一条都从用户的角度来写，跳过内部重构。
4. 每一条都附上对应拉取请求的链接。

## 输出

一段以版本号和日期作标题的 Markdown，可以直接贴到发布页。
`,
  },
};

export const SKILL_SEARCH_RESULTS: SkillSearchResult[] = [
  { package: "anthropics/skills@frontend-design", installs: "48.2K", url: "https://skills.sh/anthropics/skills/frontend-design" },
  { package: "anthropics/skills@webapp-testing", installs: "21.7K", url: "https://skills.sh/anthropics/skills/webapp-testing" },
  { package: "anthropics/skills@mcp-builder", installs: "19.9K", url: "https://skills.sh/anthropics/skills/mcp-builder" },
  { package: "anthropics/skills@skill-creator", installs: "17.3K", url: "https://skills.sh/anthropics/skills/skill-creator" },
  { package: "anthropics/skills@pdf", installs: "15.8K", url: "https://skills.sh/anthropics/skills/pdf" },
  { package: "anthropics/skills@docx", installs: "12.4K", url: "https://skills.sh/anthropics/skills/docx" },
];
