import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { enLocale } from "../lib/i18n/messages/en.ts";
import { zhCNLocale } from "../lib/i18n/messages/zh-CN.ts";
import { zhTWLocale } from "../lib/i18n/messages/zh-TW.ts";

const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
const loginSource = await readFile(new URL("../app/login/page.tsx", import.meta.url), "utf8");
const settingsSource = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");

test("the trust dialog Settings › MCP opens stacks above Settings", () => {
  const zIndex = (selector) => Number(cssSource.match(new RegExp(`\\${selector} \\{[^}]*z-index: (\\d+);`))?.[1]);
  assert.ok(zIndex(".project-trust-backdrop") > zIndex(".settings-dialog-backdrop"));
});

test("signing out removes the stored drafts once the server signed out", async () => {
  const panelSource = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
  assert.match(
    panelSource,
    /if \(!response\.ok\) throw new Error\([^\n]*\);\n(?:\s*\/\/[^\n]*\n)*\s*clearStoredDrafts\(\);\n\s*window\.location\.replace\("\/login"\);/,
  );
});

test("the login page returns only to a destination safeLoginDestination() accepts", () => {
  assert.match(loginSource, /safeLoginDestination\(destination, window\.location\.origin\)/);
});

test("the sleep switch is never lit for a hold that cannot exist, and the reason is visible text", () => {
  const section = settingsSource.match(/<h3 className="settings-general-heading">\{t\("settings\.power"\)\}<\/h3>[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.ok(section, "the Power section");
  assert.match(section, /checked=\{sleepInhibit\?\.enabled === true && sleepInhibit\.supported\}/);
  assert.match(section, /disabled=\{sleepInhibit\?\.supported === false\}/);
  assert.match(section, /describedBy=\{sleepNote \? "settings-prevent-sleep-description settings-prevent-sleep-note"/);
  assert.match(section, /role=\{sleepNote\.kind === "failed" \? "alert" : "status"\}/);
  assert.doesNotMatch(section, /title=\{sleepNote/, "no reason hides in a tooltip");
});

test("only an HTTP error fails the sleep request; a failed hold arrives as status, not as an error", () => {
  const load = settingsSource.match(/void fetch\("\/api\/sleep-inhibit"\)[\s\S]*?\.catch\(/)?.[0] ?? "";
  const save = settingsSource.match(/const toggleSleepInhibit = async[\s\S]*?\n  \};\n/)?.[0] ?? "";
  for (const [name, source] of [["load", load], ["save", save]]) {
    assert.ok(source, name);
    assert.match(source, /if \(!response\.ok\) throw new Error\(data\.error \?\? `HTTP \$\{response\.status\}`\);/, name);
    // `failure` rides on a 200 reply; treating any data.error as a failed request would hide it.
    assert.doesNotMatch(source, /!response\.ok \|\| data\.error/, name);
  }
  assert.match(save, /setSleepInhibit\(data\)/);
});

test("the auto-compaction switch saves pi's global setting and applies it to the open chat", () => {
  const section = settingsSource.match(/<h3 className="settings-general-heading">\{t\("settings\.context"\)\}<\/h3>[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.ok(section, "the Context section");
  assert.match(section, /checked=\{autoCompaction === true\}/);
  assert.match(section, /loading=\{\(autoCompaction === null && !autoCompactionError\) \|\| autoCompactionSaving\}/);
  assert.match(section, /describedBy="settings-auto-compaction-description"/);
  const save = settingsSource.match(/const toggleAutoCompaction = async[\s\S]*?\n  \};\n/)?.[0] ?? "";
  assert.ok(save, "the save handler");
  assert.match(save, /fetch\("\/api\/compaction"/);
  assert.match(save, /type: "set_auto_compaction"/);

  // The trigger slider writes one model's reserve override; the open chat re-reads settings.
  assert.match(section, /id="settings-auto-compaction-threshold"/);
  assert.match(section, /min=\{COMPACTION_TRIGGER_MIN_PERCENT\}/);
  assert.match(section, /max=\{COMPACTION_TRIGGER_MAX_PERCENT\}/);
  assert.match(section, /step=\{0\.1\}/);
  assert.match(section, /onPointerUp=/);
  const thresholdSave = settingsSource.match(/const saveCompactionThreshold = async[\s\S]*?\n  \};\n/)?.[0] ?? "";
  assert.ok(thresholdSave, "the trigger save handler");
  assert.match(thresholdSave, /reserveTokensForTriggerPercent/);
  assert.match(thresholdSave, /reserveTokens,/);
  assert.match(thresholdSave, /await reloadCompactionSettings\(\)/);
  const reset = settingsSource.match(/const resetCompactionThreshold = async[\s\S]*?\n  \};\n/)?.[0] ?? "";
  assert.ok(reset, "the trigger reset handler");
  assert.match(reset, /reserveTokens: null/);
  assert.match(settingsSource, /type: "reload_settings"/);

  for (const [name, locale] of [["en", enLocale], ["zh-CN", zhCNLocale], ["zh-TW", zhTWLocale]]) {
    for (const key of [
      "settings.context",
      "settings.autoCompaction",
      "settings.autoCompactionDescription",
      "settings.autoCompactionThreshold",
      "settings.autoCompactionThresholdValue",
      "settings.autoCompactionThresholdReset",
      "settings.autoCompactionThresholdHint",
    ]) {
      assert.ok(locale.messages[key], `${name} ${key}`);
    }
  }
});

test("the sleep setting is named and described as specified, in all three languages", () => {
  assert.equal(zhCNLocale.messages["settings.preventSleep"], "运行时防止系统休眠");
  assert.equal(zhCNLocale.messages["settings.preventSleepDescription"], "在 pi-web 运行任务时，让电脑保持唤醒状态。");
  for (const [name, locale] of [["en", enLocale], ["zh-CN", zhCNLocale], ["zh-TW", zhTWLocale]]) {
    for (const key of ["settings.power", "settings.preventSleep", "settings.preventSleepDescription", "settings.preventSleepUnavailable", "settings.preventSleepFailed"]) {
      assert.ok(locale.messages[key], `${name} ${key}`);
    }
    assert.match(locale.messages["settings.preventSleepUnavailable"], /\{reason\}/, name);
    assert.match(locale.messages["settings.preventSleepFailed"], /\{reason\}/, name);
  }
});
