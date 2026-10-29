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
