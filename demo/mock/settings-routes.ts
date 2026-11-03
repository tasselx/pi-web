/**
 * Models, providers, skills, plugins, subagents and other settings panels.
 * Toggles and edits update in-memory state so the panels stay interactive;
 * anything that would install software or contact a provider is refused with
 * a demo notice.
 */
import type {
  PluginStandaloneExtensionInfo,
  PluginsResponse,
  SkillContentResponse,
  SkillToggleResult,
  SleepInhibitStatus,
  ToolSettingsResponse,
} from "@/lib/api-types";
import skillsResponse from "./captured/skills.json";
import subagentProfilesResponse from "./captured/subagent-profiles.json";
import type { MockRequest } from "./http";
import { delay, error, json } from "./http";
import { currentDemoLocale, pick } from "./locale";
import { AUTH_PROVIDERS_RESPONSE, ENABLED_MODELS_RESPONSE, MODELS_CONFIG, MODELS_RESPONSE, MODEL_PRICING } from "./data/models";
import { PLUGINS_RESPONSE, SKILL_DOCUMENTS, SKILL_SEARCH_RESULTS } from "./data/extensions";
import { CODEMODE_INLINE_BUDGET_MAX, settings } from "./settings-state";
import { demoOnlyMessage } from "./unavailable";

type EnabledView = typeof ENABLED_MODELS_RESPONSE;
type EnabledProvider = EnabledView["providers"][number];

const enabledView: EnabledView = structuredClone(ENABLED_MODELS_RESPONSE);
const authState = structuredClone(AUTH_PROVIDERS_RESPONSE);
let modelsConfig = structuredClone(MODELS_CONFIG);
const skillsState = structuredClone(skillsResponse);
const profilesState = structuredClone(subagentProfilesResponse) as { profiles: Array<Record<string, unknown> & { name: string; scope: string; enabled?: boolean }> };

function isProviderLoggedIn(providerId: string): boolean {
  const oauth = authState.oauthProviders.find((provider) => provider.id === providerId);
  if (oauth) return oauth.loggedIn;
  const apiKey = authState.apiKeyProviders.find((provider) => provider.id === providerId);
  if (apiKey) return apiKey.configured;
  return Boolean(modelsConfig.providers[providerId]);
}

function recomputeEnabledView(): EnabledView {
  let enabledTotal = 0;
  let availableTotal = 0;
  const providers: EnabledProvider[] = [];
  for (const provider of enabledView.providers) {
    if (!isProviderLoggedIn(provider.id)) continue;
    const enabledCount = provider.models.filter((model) => model.enabled).length;
    enabledTotal += enabledCount;
    availableTotal += provider.models.length;
    providers.push({ ...provider, enabledCount });
  }
  return {
    ...enabledView,
    providers,
    enabledTotal,
    availableTotal,
    allEnabled: enabledTotal === availableTotal,
    patterns: enabledTotal === availableTotal ? null : providers.flatMap((provider) => provider.models.filter((model) => model.enabled).map((model) => model.ref)) as never,
  };
}

/** GET /api/models for the chat model picker, honouring the switches. */
export function visibleModels() {
  const enabled = new Set(recomputeEnabledView().providers.flatMap((provider) => provider.models.filter((model) => model.enabled).map((model) => model.ref)));
  const modelList = MODELS_RESPONSE.modelList.filter((model) => enabled.has(`${model.provider}/${model.id}`));
  return {
    ...MODELS_RESPONSE,
    modelList,
    models: Object.fromEntries(Object.entries(MODELS_RESPONSE.models).filter(([key]) => enabled.has(key.replace(":", "/")))),
  };
}

function setEnabled(refs: Set<string>, enabled: boolean): Response | null {
  const current = recomputeEnabledView();
  const remaining = current.enabledTotal - (enabled ? 0 : current.providers.flatMap((provider) => provider.models).filter((model) => model.enabled && refs.has(model.ref)).length);
  if (!enabled && remaining <= 0) return json({ error: "Keep at least one model enabled", reason: "last-model" }, 409);
  for (const provider of enabledView.providers) {
    for (const model of provider.models) {
      if (refs.has(model.ref)) model.enabled = enabled;
    }
  }
  return null;
}

async function modelsRoute(request: MockRequest): Promise<Response> {
  const sub = request.segments[2];
  if (!sub) return json(visibleModels());
  if (sub === "refresh") {
    await delay(1200);
    return json({ completed: true, changed: false });
  }
  if (sub === "enabled") {
    if (request.method === "GET") return json(recomputeEnabledView());
    const body = await request.json<{ op?: string; refs?: string[]; provider?: string; enabled?: boolean }>();
    if (body.op === "models" && Array.isArray(body.refs)) {
      const refused = setEnabled(new Set(body.refs), Boolean(body.enabled));
      if (refused) return refused;
    } else if (body.op === "provider" && body.provider) {
      const provider = enabledView.providers.find((candidate) => candidate.id === body.provider);
      const refused = setEnabled(new Set(provider?.models.map((model) => model.ref) ?? []), Boolean(body.enabled));
      if (refused) return refused;
    } else if (body.op === "clear") {
      setEnabled(new Set(enabledView.providers.flatMap((provider) => provider.models.map((model) => model.ref))), true);
    }
    return json(recomputeEnabledView());
  }
  return error("Not found", 404);
}

async function authRoute(request: MockRequest): Promise<Response> {
  const [, , kind, providerId] = request.segments;
  if (kind === "providers") {
    return json({ providers: authState.oauthProviders, oauthProviders: authState.oauthProviders, apiKeyProviders: authState.apiKeyProviders });
  }
  if (kind === "api-key") {
    const provider = authState.apiKeyProviders.find((candidate) => candidate.id === providerId);
    if (!provider) return error(`Unknown provider: ${providerId}`, 400);
    if (request.method === "DELETE") {
      provider.configured = false;
      delete (provider as { source?: string }).source;
      return json({ success: true });
    }
    const body = await request.json<{ apiKey?: string }>();
    if (!body.apiKey?.trim()) return error("apiKey is required", 400);
    provider.configured = true;
    (provider as { source?: string }).source = "stored";
    return json({ success: true });
  }
  if (kind === "logout") {
    const provider = authState.oauthProviders.find((candidate) => candidate.id === providerId);
    if (!provider) return error(`Unknown provider: ${providerId}`, 400);
    provider.loggedIn = false;
    return json({ ok: true });
  }
  if (kind === "login") return error(demoOnlyMessage(), 501);
  return error("Not found", 404);
}

async function modelsConfigRoute(request: MockRequest): Promise<Response> {
  const sub = request.segments[2];
  if (!sub) {
    if (request.method === "PUT") {
      modelsConfig = await request.json();
      return json({ success: true });
    }
    return json(modelsConfig);
  }
  if (sub === "test") {
    const body = await request.json<{ providerName?: string; model?: { id?: string } }>();
    await delay(900 + Math.random() * 600);
    const known = body.providerName && modelsConfig.providers[body.providerName];
    if (!known) return json({ ok: false, error: demoOnlyMessage() });
    return json({ ok: true, latencyMs: 640 + Math.round(Math.random() * 500), status: 200, responseText: currentDemoLocale() === "zh" ? "你好！连接正常。" : "Hello! The connection works." });
  }
  if (sub === "discover") {
    await delay(900);
    const body = await request.json<{ providerName?: string }>();
    if (body.providerName !== "claude-gateway") return json({ error: demoOnlyMessage() }, 502);
    return json({
      endpoint: "https://llm-gateway.example.com/v1/models",
      models: [
        { id: "claude-opus-5", name: "Claude Opus 5" },
        { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
        { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
        { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
        { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
      ],
    });
  }
  if (sub === "catalog") {
    await delay(500);
    const query = (request.query("q") ?? "").trim();
    const match = Object.entries(MODEL_PRICING).find(([ref]) => ref.split("/")[1] === query);
    if (!match) return json({ error: demoOnlyMessage() }, 502);
    const [, price] = match;
    return json({
      recommendation: {
        exactMatches: 3,
        metadataMethod: "consensus",
        preset: { reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000, cost: price },
        price: { status: "reliable", method: "consensus", cost: price },
      },
    });
  }
  return error("Not found", 404);
}

export function usageReport(providerId: string) {
  const capturedAt = Date.now();
  if (providerId === "openai-codex") {
    return {
      providerId,
      status: "ready",
      report: {
        providerId,
        providerName: "OpenAI Codex",
        capturedAt,
        buckets: [
          { id: "codex:primary", label: "5h", used: 23, remaining: 77, limit: 100, unit: "percent", windowMinutes: 300, resetsAt: Math.floor((capturedAt + 2.4 * 3600_000) / 1000) },
          { id: "codex:secondary", label: "7d", used: 41, remaining: 59, limit: 100, unit: "percent", windowMinutes: 10080, resetsAt: Math.floor((capturedAt + 3.2 * 86400_000) / 1000) },
        ],
        metrics: [],
      },
    };
  }
  if (providerId === "deepseek") {
    return {
      providerId,
      status: "ready",
      report: {
        providerId,
        providerName: "DeepSeek",
        capturedAt,
        buckets: [],
        metrics: [
          { id: "availability", label: "API calls", value: "Available" },
          { id: "cny-total", label: "Total balance", value: 86.42, unit: "currency", currency: "CNY" },
          { id: "cny-granted", label: "Granted balance", value: 10, unit: "currency", currency: "CNY" },
          { id: "cny-topped-up", label: "Topped-up balance", value: 76.42, unit: "currency", currency: "CNY" },
        ],
      },
    };
  }
  return { providerId, status: "auth-unavailable", message: demoOnlyMessage() };
}

/** 切换一个示例 skill 的 disable-model-invocation；找不到时报错但不牵连批量里的其他项。 */
function toggleSkill(filePath: string, disabled: boolean): SkillToggleResult {
  const skill = skillsState.skills.find((candidate) => candidate.filePath === filePath);
  if (!skill) return { filePath, error: "file not found" };
  skill.disableModelInvocation = disabled;
  return { filePath };
}

// GET /api/skills/content：示例 skill 的 SKILL.md。同目录里被相对链接指到的其他文档，演示里没有。
function skillContent(request: MockRequest): Response {
  const filePath = request.query("filePath");
  if (!request.query("cwd")) return error("cwd required", 400);
  if (!filePath) return error("filePath required", 400);
  const skill = skillsState.skills.find((candidate) => candidate.filePath === filePath);
  if (!skill) return error("Skill not found", 404);
  if (request.query("document") !== null) return error("Skill document not found", 404);
  return json({ content: pick(SKILL_DOCUMENTS[skill.filePath], currentDemoLocale()) } satisfies SkillContentResponse);
}

async function skillsRoute(request: MockRequest): Promise<Response> {
  const sub = request.segments[2];
  if (!sub) {
    if (request.method === "PATCH") {
      const body = await request.json<{ filePath?: string; filePaths?: unknown; disableModelInvocation?: unknown }>();
      const disabled = Boolean(body.disableModelInvocation);
      // 「全部启用 / 全部禁用」：每个文件各自处理并逐个报告，和主应用一样。
      const filePaths = body.filePaths;
      if (filePaths !== undefined) {
        if (!Array.isArray(filePaths) || !filePaths.every((item) => typeof item === "string" && item)) return error("filePaths must be a list of paths", 400);
        if (typeof body.disableModelInvocation !== "boolean") return error("disableModelInvocation must be a boolean", 400);
        return json({ results: [...new Set<string>(filePaths)].map((filePath) => toggleSkill(filePath, disabled)) });
      }
      if (!body.filePath) return error("filePath required", 400);
      const result = toggleSkill(body.filePath, disabled);
      return result.error ? error(result.error, 404) : json({ success: true });
    }
    return json(skillsState);
  }
  if (sub === "content") return skillContent(request);
  if (sub === "search") {
    await delay(700);
    const body = await request.json<{ query?: string }>();
    const query = (body.query ?? "").toLowerCase();
    const results = SKILL_SEARCH_RESULTS.filter((result) => !query || result.package.toLowerCase().includes(query) || query.split(/\s+/).some((word) => result.package.toLowerCase().includes(word)));
    return json({ results: results.length ? results : SKILL_SEARCH_RESULTS.slice(0, 4) });
  }
  if (sub === "check") return json({ results: [] });
  return error(demoOnlyMessage(), 501);
}

/** 设置 › 插件的列表：示例插件包，加上 pi 自带的内置扩展行（没有文件，路径就是 builtin:<name>）。 */
function pluginsResponse(): PluginsResponse {
  const builtins = Object.entries(settings.builtinExtensions).map(([name, enabled]): PluginStandaloneExtensionInfo => ({
    kind: "extension",
    name: `builtin:${name}`,
    path: `builtin:${name}`,
    relativePath: `builtin:${name}`,
    scope: "global",
    enabled,
    builtin: true,
  }));
  return { ...PLUGINS_RESPONSE, standaloneExtensions: builtins };
}

async function pluginsRoute(request: MockRequest): Promise<Response> {
  if (request.segments[2] === "check") {
    await delay(800);
    return json({ results: PLUGINS_RESPONSE.packages.map((pkg) => ({ source: pkg.source, scope: pkg.scope, displayName: pkg.packageName ?? pkg.source, type: "npm", state: "up-to-date" })) });
  }
  if (request.method === "GET") return json(pluginsResponse());
  const body = await request.json<{ action?: string; name?: unknown; enabled?: unknown }>();
  // 内置扩展的开关只是改内存里的一个标记，演示里真的能生效（设置 › MCP 也跟着变）。
  if (body.action === "set-builtin") {
    const name = body.name;
    if (typeof name !== "string" || !Object.keys(settings.builtinExtensions).includes(name)) return error("name must be a built-in extension", 400);
    if (typeof body.enabled !== "boolean") return error("enabled required", 400);
    settings.builtinExtensions[name] = body.enabled;
    return json(pluginsResponse());
  }
  // 安装、卸载、更新、启用/停用插件包要联网装软件、改磁盘，演示里做不到。
  await delay(500);
  return error(demoOnlyMessage(), 501);
}

async function subagentsRoute(request: MockRequest): Promise<Response> {
  const sub = request.segments[2];
  if (sub === "settings") {
    if (request.method === "PUT") {
      const body = await request.json<{ enabled?: boolean; maxConcurrent?: number }>();
      if (typeof body.enabled === "boolean") settings.subagentsEnabled = body.enabled;
      if (typeof body.maxConcurrent === "number") settings.subagentMaxConcurrent = body.maxConcurrent;
    }
    return json({ enabled: settings.subagentsEnabled, maxConcurrent: settings.subagentMaxConcurrent });
  }
  if (sub === "profiles") {
    if (request.method === "GET") return json(profilesState);
    const body = await request.json<{ scope?: string; name?: string; enabled?: boolean; profile?: Record<string, unknown> & { name: string } }>();
    if (request.method === "PATCH") {
      const profile = profilesState.profiles.find((candidate) => candidate.name === body.name && candidate.scope === body.scope);
      if (!profile) return error("Agent profile not found", 404);
      profile.enabled = Boolean(body.enabled);
      return json({ profile });
    }
    if (request.method === "PUT" && body.profile) {
      const saved = { ...body.profile, scope: body.scope ?? "global", enabled: body.profile.enabled ?? true } as (typeof profilesState.profiles)[number];
      profilesState.profiles = [...profilesState.profiles.filter((candidate) => !(candidate.name === saved.name && candidate.scope === saved.scope)), saved];
      return json({ profile: saved });
    }
    if (request.method === "DELETE") {
      profilesState.profiles = profilesState.profiles.filter((candidate) => !(candidate.name === body.name && candidate.scope === body.scope));
      return json({ ok: true });
    }
  }
  return error("Not found", 404);
}

function toolSettings(): ToolSettingsResponse {
  return {
    isWindows: false,
    powerShellEnabled: settings.powerShellEnabled,
    codemode: settings.codemode,
    codemodeMode: settings.codemodeMode,
    codemodeInlineBudget: settings.codemodeInlineBudget,
  };
}

const TOOL_SETTING_KEYS = ["enabled", "codemode", "codemodeMode", "codemodeInlineBudget"] as const;

// PUT /api/tools/settings：和主应用一样一次只改一项，改完回完整设置；存在内存里。
async function toolSettingsRoute(request: MockRequest): Promise<Response> {
  if (request.method !== "PUT") return json(toolSettings());
  const changes = await request.json();
  const invalid = (message: string) => error(message, 400, { reason: "invalid-request" });
  if (TOOL_SETTING_KEYS.filter((key) => key in changes).length !== 1) {
    return invalid("Send one of enabled (PowerShell), codemode, codemodeMode or codemodeInlineBudget");
  }
  if ("codemodeMode" in changes) {
    const mode = changes.codemodeMode;
    if (mode !== "on" && mode !== "only") return invalid('codemodeMode must be "on" or "only"');
    settings.codemodeMode = { value: mode };
  } else if ("codemodeInlineBudget" in changes) {
    // null 表示去掉这个键，会话回到 pi 的默认值。
    const budget = changes.codemodeInlineBudget;
    if (budget === null) settings.codemodeInlineBudget = {};
    else if (typeof budget === "number" && Number.isInteger(budget) && budget >= 0 && budget <= CODEMODE_INLINE_BUDGET_MAX) settings.codemodeInlineBudget = { value: budget };
    else return invalid(`codemodeInlineBudget must be a whole number from 0 to ${CODEMODE_INLINE_BUDGET_MAX}, or null`);
  } else if ("codemode" in changes) {
    const preference = changes.codemode;
    if (preference !== "automatic" && preference !== "always") return invalid('codemode must be "automatic" or "always"');
    settings.codemode = preference;
  } else {
    // PowerShell 开关只在 Windows 上有；演示里的「这台机器」不是。
    return error("PowerShell tool settings are only available on Windows", 404, { reason: "invalid-request" });
  }
  return json(toolSettings());
}

// 设置 › 常规的缓存/费用提示开关。
async function cacheMissNoticesRoute(request: MockRequest): Promise<Response> {
  if (request.method === "PUT") {
    const { enabled } = await request.json();
    if (typeof enabled !== "boolean") return error("enabled must be a boolean", 400);
    settings.cacheMissNotices = enabled;
  }
  return json({ enabled: settings.cacheMissNotices });
}

// 「运行时防止系统休眠」要由跑 agent 的那台主机去持有；演示页没有这样的主机，
// 所以按「这台机器不支持」回答：面板显示原因、开关不可用，和真实服务器遇到不支持的系统时一样。
async function sleepInhibitRoute(request: MockRequest): Promise<Response> {
  const status: SleepInhibitStatus = {
    enabled: false,
    supported: false,
    unsupportedReason: pick({
      en: "This is a static demo: there is no host running agents that could be kept awake.",
      zh: "这是静态演示，没有正在运行智能体、可以被保持唤醒的主机。",
    }, currentDemoLocale()),
    active: false,
  };
  if (request.method !== "PUT") return json(status);
  const { enabled } = await request.json();
  if (typeof enabled !== "boolean") return error("enabled must be a boolean", 400);
  // 不支持的机器上「开」被拒绝（带上状态），「关」照常接受。
  return enabled ? json({ ...status, error: status.unsupportedReason }, 409) : json(status);
}

export async function settingsRoutes(request: MockRequest): Promise<Response> {
  switch (request.segments[1]) {
    case "models": return modelsRoute(request);
    case "auth": return authRoute(request);
    case "models-config": return modelsConfigRoute(request);
    case "provider-usage": {
      await delay(900);
      const body = await request.json<{ providerId?: string }>();
      return json(usageReport(body.providerId ?? ""));
    }
    case "skills": return skillsRoute(request);
    case "plugins": return pluginsRoute(request);
    case "subagents": return subagentsRoute(request);
    case "tools": return request.segments[2] === "settings" ? toolSettingsRoute(request) : error(`Not found: ${request.path}`, 404);
    case "cache-miss-notices": return cacheMissNoticesRoute(request);
    case "sleep-inhibit": return sleepInhibitRoute(request);
    case "web-auth":
      return request.method === "GET" ? json({ enabled: false, authenticated: true }) : json({ ok: true });
    default:
      return error(`Not found: ${request.path}`, 404);
  }
}
