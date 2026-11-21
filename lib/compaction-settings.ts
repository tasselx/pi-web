/** pi's compaction token defaults (settings-defaults.js), for a missing settings key. */
export const COMPACTION_RESERVE_TOKENS_DEFAULT = 16384;
export const COMPACTION_KEEP_RECENT_TOKENS_DEFAULT = 20000;

/** The slider offers these trigger points, as a share of the model's context window. */
export const COMPACTION_TRIGGER_MIN_PERCENT = 50;
export const COMPACTION_TRIGGER_MAX_PERCENT = 99.9;

const MIN_RESERVE_TOKENS = 1024;

/** The trigger point a reserve leaves, as a percentage of the context window; null when it cannot trigger. */
export function compactionTriggerPercent(contextWindow: number, reserveTokens: number): number | null {
  if (!(contextWindow > 0) || !(reserveTokens >= 0) || reserveTokens >= contextWindow) return null;
  const percent = (1 - reserveTokens / contextWindow) * 100;
  return Math.min(
    COMPACTION_TRIGGER_MAX_PERCENT,
    Math.max(COMPACTION_TRIGGER_MIN_PERCENT, Math.round(percent * 10) / 10),
  );
}

/** The reserve tokens a trigger percentage writes for one model's context window. */
export function reserveTokensForTriggerPercent(contextWindow: number, percent: number): number {
  const clamped = Math.min(COMPACTION_TRIGGER_MAX_PERCENT, Math.max(COMPACTION_TRIGGER_MIN_PERCENT, percent));
  return Math.max(MIN_RESERVE_TOKENS, Math.round(contextWindow * (1 - clamped / 100)));
}
