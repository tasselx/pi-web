import { existsSync } from "node:fs";
import { getGlobalSettingsPath, readGlobalSettings, updateGlobalSettings } from "./global-settings-file";

// Settings › General 的「运行时防止系统休眠」开关，存在全局 settings.json 的 piWebPreventSleep 里。
// 这是 pi-web 自己的键：pi 的 SettingsManager 写回设置时会保留它不认识的键，所以不会被冲掉。
// 默认关，关就是删键（和 showCacheMissNotices 一样），没有设置文件时「关」什么都不用建。

export const PREVENT_SLEEP_KEY = "piWebPreventSleep";

export function readPreventSleep(settingsPath = getGlobalSettingsPath()): Promise<boolean> {
  return readGlobalSettings(settingsPath, (settings) => settings[PREVENT_SLEEP_KEY] === true);
}

export async function writePreventSleep(enabled: boolean, settingsPath = getGlobalSettingsPath()): Promise<void> {
  if (!enabled && !existsSync(settingsPath)) return;
  await updateGlobalSettings(settingsPath, (settings) => {
    if (enabled) settings[PREVENT_SLEEP_KEY] = true;
    else delete settings[PREVENT_SLEEP_KEY];
  });
}
