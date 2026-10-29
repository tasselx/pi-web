import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".module.css")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: "export default new Proxy({}, { get: (_, key) => String(key) });",
    };
  },
});

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { ChatViewTabs, TRAJECTORY_PANEL_ID, TRAJECTORY_TAB_ID } = await jiti.import("./ChatViewTabs.tsx");

const source = await readFile(new URL("./ChatViewTabs.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("./ChatViewTabs.module.css", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

const h = React.createElement;
const noop = () => {};

function render(props = {}) {
  return renderToStaticMarkup(h(I18nProvider, null, h(ChatViewTabs, {
    view: "chat",
    onChange: noop,
    trajectoryDisabled: false,
    ...props,
  })));
}

/** The two tabs, Chat first: their opening tags and what is inside. */
function tabs(html) {
  const found = [...html.matchAll(/<button ([^>]*)>([\s\S]*?)<\/button>/g)].map((match) => ({ attrs: match[1], inner: match[2] }));
  assert.equal(found.length, 2, "Chat and Trajectory");
  return { chat: found[0], trajectory: found[1] };
}

test("exactly one of the two is selected, and only that one is a tab stop", () => {
  const inChat = tabs(render({ view: "chat" }));
  assert.match(inChat.chat.attrs, /aria-selected="true"/);
  assert.match(inChat.chat.attrs, /tabindex="0"/);
  assert.match(inChat.trajectory.attrs, /aria-selected="false"/);
  assert.match(inChat.trajectory.attrs, /tabindex="-1"/);
  assert.doesNotMatch(inChat.trajectory.attrs, /aria-controls/);

  // The view is Trajectory: the selection and the tab stop move, and the tab names the panel it controls.
  const inTrajectory = tabs(render({ view: "trajectory" }));
  assert.match(inTrajectory.chat.attrs, /aria-selected="false"/);
  assert.match(inTrajectory.chat.attrs, /tabindex="-1"/);
  assert.match(inTrajectory.trajectory.attrs, /aria-selected="true"/);
  assert.match(inTrajectory.trajectory.attrs, /tabindex="0"/);
  assert.match(inTrajectory.trajectory.attrs, new RegExp(`aria-controls="${TRAJECTORY_PANEL_ID}"`));
  assert.match(inTrajectory.trajectory.attrs, new RegExp(`id="${TRAJECTORY_TAB_ID}"`));
});

test("the two are one tab list choosing a view, not switches", () => {
  const html = render({ view: "trajectory" });
  assert.match(html, /^<div class="tabs" role="tablist" aria-label="Chat view">/);
  assert.doesNotMatch(html, /aria-pressed/);
  const { chat, trajectory } = tabs(html);
  assert.match(chat.attrs, /role="tab"/);
  assert.match(trajectory.attrs, /role="tab"/);
});

test("a click chooses its own view, the arrow keys move between the two, and only Trajectory warms up", () => {
  const [, chat, trajectory] = source.split(/<button\b/);
  assert.match(chat, /onClick=\{\(\) => onChange\("chat"\)\}/);
  assert.doesNotMatch(chat, /onTrajectoryIntent/);
  assert.match(trajectory, /onClick=\{\(\) => onChange\("trajectory"\)\}/);
  assert.match(trajectory, /onPointerEnter=\{onTrajectoryIntent\}/);
  assert.match(trajectory, /onFocus=\{onTrajectoryIntent\}/);
  // ← → Home End, as the sidebar's Sessions | Files tabs; a disabled Trajectory is never moved to.
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) assert.match(source, new RegExp(`"${key}"`));
  assert.match(source, /if \(next === "trajectory" && trajectoryDisabled\) return;/);
});

test("without a session the trajectory cannot be opened and says why; Chat is untouched", () => {
  const { chat, trajectory } = tabs(render({ trajectoryDisabled: true }));
  assert.match(trajectory.attrs, /disabled=""/);
  assert.match(trajectory.attrs, /title="Trajectory is available after the session is saved"/);
  assert.doesNotMatch(chat.attrs, /disabled/);
});

test("on a phone the tabs are icons of the toolbar's width, each named and tagged for the toolbar", () => {
  const { chat, trajectory } = tabs(render({ iconWidth: 36, view: "trajectory" }));
  for (const [tab, name, action] of [[chat, "Chat", "chat"], [trajectory, "Trajectory", "trajectory"]]) {
    assert.match(tab.attrs, new RegExp(`aria-label="${name}"`));
    assert.match(tab.attrs, new RegExp(`data-mobile-toolbar-action="${action}"`));
    assert.match(tab.attrs, /style="width:36px"/);
    assert.match(tab.attrs, /data-icon-only="true"/);
    assert.doesNotMatch(tab.inner, /<span>/);
  }
  // On a desktop they carry their words and no toolbar tag.
  const desktop = tabs(render());
  assert.match(desktop.chat.inner, /<span>Chat<\/span>/);
  assert.match(desktop.trajectory.inner, /<span>Trajectory<\/span>/);
  assert.doesNotMatch(desktop.chat.attrs + desktop.trajectory.attrs, /data-mobile-toolbar-action|data-icon-only/);
});

test("the selected tab is drawn like an open top bar button", () => {
  assert.match(styles, /\.tab\[aria-selected='true'\] \{\s*border-top-color: var\(--accent\);\s*color: var\(--text\);\s*background: var\(--bg-selected\);/);
  assert.match(styles, /\.tab\[aria-selected='false'\]:not\(:disabled\):hover/);
  assert.doesNotMatch(styles, /aria-pressed/);
});

test("the trajectory a tab selects is a tabpanel over the chat, which stays mounted under it", () => {
  assert.match(chatWindowSource, /id=\{TRAJECTORY_PANEL_ID\}\s*role="tabpanel"\s*aria-labelledby=\{TRAJECTORY_TAB_ID\}/);
  // The list's wrapper is there with or without the view: only its visibility follows it, never its presence.
  assert.match(chatWindowSource, /\{!isEmptyNew && <div className="contents" style=\{\{ visibility: trajectoryView \? "hidden" : undefined \}\}>/);
});
