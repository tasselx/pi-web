// Client-safe display of session usage: the toolbar's stats button and
// popover, and the agent switcher's per-agent rows.

/** 950 · 18k · 1.2M */
export function formatCompactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(0)}k`;
  return String(value);
}

/** $0.12 · <$0.01 · null when nothing was billed. */
export function formatCostShort(cost: number): string | null {
  if (!(cost > 0)) return null;
  return cost >= 0.01 ? `$${cost.toFixed(2)}` : "<$0.01";
}

/**
 * 缓存命中率（0–100）= 缓存读取 /（输入 + 缓存写入 + 缓存读取），分母覆盖所有输入类 token。
 * 顶栏统计与展开的会话信息共用这一个算法，免得两处各算一遍对不上。
 * 一次缓存读写都没有、或没有任何输入类 token 时没有意义，返回 null。
 */
export function cacheHitRatePercent(tokens: { input: number; cacheRead: number; cacheWrite: number }): number | null {
  const denominator = tokens.cacheRead + tokens.cacheWrite + tokens.input;
  if (tokens.cacheRead + tokens.cacheWrite <= 0 || denominator <= 0) return null;
  return (tokens.cacheRead / denominator) * 100;
}

/** 0s · 42s · 3m 5s · 1h 20m */
export function formatActiveDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
