// 浏览器里“最近使用”的 模型 + 推理级别（effort）。
// 与 tool-preset-preference.ts 同一思路：只存在这个浏览器里，不写 pi 的 settings.json——
// 浏览器里的模型/推理选择是会话级的（docs/agents/models.md），一次性的选择不该变成 pi CLI 的默认。

const STORAGE_KEY = "pi-recent-models";

// 同一个模型换了 effort 算另一条，所以上限数的是组合而不是模型。
const RECENT_MODELS_LIMIT = 5;

export interface RecentModel {
  provider: string;
  modelId: string;
  /** 记录时实际生效的推理级别；null 表示自动（跟随默认）。 */
  thinkingLevel: string | null;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    // 没有 localStorage 的环境（隐私模式、测试里的 window 垫片）按“没有存储”处理。
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function isRecentModel(value: unknown): value is RecentModel {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.provider === "string"
    && typeof entry.modelId === "string"
    && (entry.thinkingLevel === null || typeof entry.thinkingLevel === "string");
}

function getRecentModels(storage: StorageLike | null): RecentModel[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    // 这份数据在用户的浏览器里，可能被改过或来自别的版本：只收形状合规的条目，丢掉多余字段。
    return parsed
      .filter(isRecentModel)
      .slice(0, RECENT_MODELS_LIMIT)
      .map(({ provider, modelId, thinkingLevel }) => ({ provider, modelId, thinkingLevel }));
  } catch {
    return [];
  }
}

/** 把这次实际用的组合放到最前（同款旧记录去掉，截到上限），存下并返回新列表。 */
export function recordRecentModel(
  entry: RecentModel,
  storage: StorageLike | null = getBrowserStorage(),
): RecentModel[] {
  const others = getRecentModels(storage).filter((item) => (
    item.provider !== entry.provider || item.modelId !== entry.modelId || item.thinkingLevel !== entry.thinkingLevel
  ));
  const next = [entry, ...others].slice(0, RECENT_MODELS_LIMIT);
  if (!storage) return next;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 浏览器存储只是尽力而为。
  }
  return next;
}

/** 当前工作区的模型列表里还选得到的记录，顺序不变。 */
export function availableRecentModels(
  recent: RecentModel[],
  modelList: { provider: string; id: string }[],
): RecentModel[] {
  return recent.filter((entry) => (
    modelList.some((model) => model.provider === entry.provider && model.id === entry.modelId)
  ));
}

/**
 * 记录里的推理级别在该模型上还能不能用：模型的级别表不含它（模型换了能力）就回到自动。
 * 拿不到该模型的级别表时不质疑记录。
 */
export function restorableThinkingLevel(
  entry: RecentModel,
  thinkingLevels: Record<string, string[]> | undefined,
): string | null {
  if (!entry.thinkingLevel) return null;
  const supported = thinkingLevels?.[`${entry.provider}:${entry.modelId}`];
  return !supported || supported.includes(entry.thinkingLevel) ? entry.thinkingLevel : null;
}

/**
 * 新会话的起点沿用最近使用时的推理级别——只有选中的正是起点那个模型才适用，
 * 否则返回 null，由 enabledModels 的 pin / 默认级别决定。
 */
export function recentThinkingLevelFor(
  start: RecentModel | null,
  model: { provider: string; modelId: string } | null,
): string | null {
  return start && model && start.provider === model.provider && start.modelId === model.modelId
    ? start.thinkingLevel
    : null;
}

/**
 * 读出浏览器里的记录，并算出新会话该默认选中的那一条：当前工作区还选得到的第一条，
 * 它的推理级别取 restorableThinkingLevel()。
 */
export function readRecentModels(
  modelList: { provider: string; id: string }[],
  thinkingLevels: Record<string, string[]> | undefined,
  storage: StorageLike | null = getBrowserStorage(),
): { recent: RecentModel[]; start: RecentModel | null } {
  const recent = getRecentModels(storage);
  const first = availableRecentModels(recent, modelList)[0];
  return {
    recent,
    start: first ? { ...first, thinkingLevel: restorableThinkingLevel(first, thinkingLevels) } : null,
  };
}
