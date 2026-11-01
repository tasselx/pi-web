import assert from "node:assert/strict";
import test from "node:test";
import { buildHotkeySections } from "./hotkeys.ts";

test("buildHotkeySections adapts send and newline keys to enterSendMode", () => {
  const enterSections = buildHotkeySections({ enterSendMode: "enter" });
  assert.equal(enterSections.length, 3);
  const enterComposer = enterSections.find((s) => s.id === "composer");
  assert.ok(enterComposer);
  assert.equal(
    enterComposer.items.find((i) => i.descriptionKey === "hotkeys.sendMessage")?.keys,
    "Enter",
  );
  assert.equal(
    enterComposer.items.find((i) => i.descriptionKey === "hotkeys.newLine")?.keys,
    "Shift+Enter",
  );

  const ctrlEnterSections = buildHotkeySections({ enterSendMode: "ctrlEnter" });
  const ctrlComposer = ctrlEnterSections.find((s) => s.id === "composer");
  assert.ok(ctrlComposer);
  assert.equal(
    ctrlComposer.items.find((i) => i.descriptionKey === "hotkeys.sendMessage")?.keys,
    "Ctrl/Cmd+Enter",
  );
  assert.equal(
    ctrlComposer.items.find((i) => i.descriptionKey === "hotkeys.followUpMessage")?.keys,
    "Ctrl/Cmd+Alt+Enter",
  );
});
