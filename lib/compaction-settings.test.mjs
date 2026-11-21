import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPACTION_RESERVE_TOKENS_DEFAULT,
  COMPACTION_TRIGGER_MAX_PERCENT,
  COMPACTION_TRIGGER_MIN_PERCENT,
  compactionTriggerPercent,
  reserveTokensForTriggerPercent,
} from "./compaction-settings.ts";

const CONTEXT = 1_048_576;

test("pi's default reserve shows as 98.4% of a 1M window", () => {
  assert.equal(compactionTriggerPercent(CONTEXT, COMPACTION_RESERVE_TOKENS_DEFAULT), 98.4);
});

test("a reserve at or beyond the window has no trigger to show", () => {
  assert.equal(compactionTriggerPercent(0, 16384), null);
  assert.equal(compactionTriggerPercent(CONTEXT, CONTEXT), null);
  assert.equal(compactionTriggerPercent(CONTEXT, CONTEXT + 1), null);
});

test("the slider keeps a reserve that means an early trigger inside its bounds", () => {
  assert.equal(compactionTriggerPercent(CONTEXT, CONTEXT / 2 + 1), COMPACTION_TRIGGER_MIN_PERCENT);
  assert.equal(compactionTriggerPercent(CONTEXT, 1), COMPACTION_TRIGGER_MAX_PERCENT);
});

test("a trigger percentage writes the matching reserve and reads back the same point", () => {
  const reserve = reserveTokensForTriggerPercent(CONTEXT, 98.4);
  assert.equal(reserve, Math.round(CONTEXT * 0.016));
  assert.equal(compactionTriggerPercent(CONTEXT, reserve), 98.4);
  assert.equal(reserveTokensForTriggerPercent(CONTEXT, 10), Math.round(CONTEXT * 0.5));
  assert.ok(reserveTokensForTriggerPercent(CONTEXT, 100) > 0);
});
