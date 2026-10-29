import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { enLocale } from "./i18n/messages/en.ts";
import { zhCNLocale } from "./i18n/messages/zh-CN.ts";
import { zhTWLocale } from "./i18n/messages/zh-TW.ts";

// Through jiti: the module imports values of other modules without extensions.
const jiti = createJiti(import.meta.url);
const {
  deleteProjectSessions,
  forkFailureMessage,
  PROJECT_DELETE_IDS_PER_REQUEST,
  projectNameMenuEntries,
  projectRenameRequest,
  requestSessionTitle,
  sessionMenuEntries,
  worktreeCreateFailure,
} = await jiti.import("./sidebar-actions.ts");

const idle = { running: false, unread: false, selected: false, transient: false };

function actions(entries) {
  return entries.map((entry) => entry.kind === "separator" ? "-" : `${entry.id}:${entry.shortcut}${entry.disabledReason ? ` (${entry.disabledReason})` : ""}`);
}

test("a group row offers pin, rename, generate title, fork, unread, archive, new tab and delete", () => {
  assert.deepEqual(actions(sessionMenuEntries("group", idle)), ["pin:P", "rename:R", "generate-title:G", "fork:F", "mark-unread:U", "archive:A", "open-new-tab:T", "-", "delete:D"]);
  assert.deepEqual(
    actions(sessionMenuEntries("pinned", { ...idle, unread: true })),
    ["unpin:P", "rename:R", "generate-title:G", "fork:F", "mark-read:U", "archive:A", "open-new-tab:T", "-", "delete:D"],
  );
});

test("a running family cannot be archived yet, but can be forked", () => {
  for (const context of ["group", "pinned"]) {
    const entries = actions(sessionMenuEntries(context, { ...idle, running: true }));
    assert.ok(entries.includes("archive:A (running)"));
    // Fork copies the finished entries and leaves the run alone.
    assert.ok(entries.includes("fork:F"));
    assert.ok(entries.includes("delete:D"));
  }
});

test("an archived row offers unarchive, pin (which restores it), rename, generate title, fork, new tab and delete", () => {
  assert.deepEqual(actions(sessionMenuEntries("archive", idle)), ["unarchive:A", "pin:P", "rename:R", "generate-title:G", "fork:F", "open-new-tab:T", "-", "delete:D"]);
});

test("Generate title sits right after Rename in every menu, enabled whatever the family is doing", () => {
  for (const context of ["group", "pinned", "archive"]) {
    for (const status of [idle, { ...idle, running: true }, { ...idle, running: true, awaiting: true }, { ...idle, selected: true }]) {
      const entries = sessionMenuEntries(context, status);
      const index = entries.findIndex((entry) => entry.id === "generate-title");
      assert.equal(entries[index - 1].id, "rename", `${context} ${JSON.stringify(status)}`);
      // A run does not stop it: the title is made from a snapshot of the transcript.
      assert.deepEqual(entries[index], { kind: "action", id: "generate-title", shortcut: "G" });
    }
  }
  for (const locale of [enLocale, zhCNLocale, zhTWLocale]) {
    for (const key of ["title.generate", "title.generating", "title.updated", "title.noMessages", "title.failedWithError"]) {
      assert.equal(typeof locale.messages[key], "string", `${locale.id} has ${key}`);
    }
    assert.match(locale.messages["title.failedWithError"], /\{error\}/, locale.id);
  }
});

test("every saved session opens in a new tab, enabled, just before Delete and never first; a transient one cannot", () => {
  for (const context of ["group", "pinned", "archive"]) {
    for (const status of [idle, { ...idle, running: true }, { ...idle, running: true, awaiting: true }, { ...idle, unread: true }, { ...idle, selected: true }]) {
      const entries = sessionMenuEntries(context, status);
      const label = `${context} ${JSON.stringify(status)}`;
      // A menu's first item takes focus when it opens: Enter must not leave the tab.
      assert.notEqual(entries[0].id, "open-new-tab", label);
      assert.deepEqual(entries.slice(-3), [
        { kind: "action", id: "open-new-tab", shortcut: "T" },
        { kind: "separator" },
        { kind: "action", id: "delete", shortcut: "D" },
      ], label);
      assert.equal(entries.filter((entry) => entry.id === "open-new-tab").length, 1, label);
    }
    // In the group and pinned views it follows Archive (disabled or not).
    if (context !== "archive") {
      for (const running of [false, true]) {
        const entries = sessionMenuEntries(context, { ...idle, running });
        assert.equal(entries[entries.length - 4].id, "archive");
      }
    }
    const ids = sessionMenuEntries(context, { ...idle, transient: true }).map((entry) => entry.id);
    assert.ok(!ids.includes("open-new-tab"));
  }
  for (const locale of [enLocale, zhCNLocale, zhTWLocale]) {
    assert.equal(typeof locale.messages["sidebar.openInNewTab"], "string", `${locale.id} has the label`);
  }
  assert.equal(enLocale.messages["sidebar.openInNewTab"], "Open in new tab");
  assert.equal(zhCNLocale.messages["sidebar.openInNewTab"], "在新标签页打开");
  assert.equal(zhTWLocale.messages["sidebar.openInNewTab"], "在新分頁開啟");
});

test("a transient session offers nothing that needs its file", () => {
  for (const context of ["group", "pinned", "archive"]) {
    assert.deepEqual(sessionMenuEntries(context, { ...idle, transient: true }), []);
  }
});

test("shortcuts are unique within a menu", () => {
  for (const context of ["group", "pinned", "archive"]) {
    for (const status of [idle, { ...idle, running: true }, { ...idle, unread: true }]) {
      const shortcuts = sessionMenuEntries(context, status).filter((entry) => entry.kind === "action").map((entry) => entry.shortcut);
      assert.equal(new Set(shortcuts).size, shortcuts.length);
    }
  }
});

test("a refused fork names the reason in the user's language, anything else shows the error", () => {
  assert.deepEqual(forkFailureMessage("not_found", "Session not found"), { key: "sidebar.forkNotFound" });
  assert.deepEqual(forkFailureMessage("unsaved", "x"), { key: "sidebar.forkUnsaved" });
  assert.deepEqual(forkFailureMessage("empty", "x"), { key: "sidebar.forkEmpty" });
  assert.deepEqual(forkFailureMessage("subagent", "x"), { key: "sidebar.forkUnavailable" });
  assert.deepEqual(forkFailureMessage("request-denied", "x"), { key: "sidebar.forkUnavailable" });
  assert.deepEqual(forkFailureMessage("failed", "EACCES"), { key: "sidebar.forkFailed", params: { error: "EACCES" } });
  assert.deepEqual(forkFailureMessage(undefined, "HTTP 502"), { key: "sidebar.forkFailed", params: { error: "HTTP 502" } });
  for (const code of ["not_found", "unsaved", "empty", "subagent", "failed"]) {
    const { key, params } = forkFailureMessage(code, "x");
    assert.equal(typeof enLocale.messages[key], "string", `${key} is translated`);
    if (params) assert.match(enLocale.messages[key], /\{error\}/);
  }
});

test("New worktree on a branch checked out elsewhere names that checkout, anything else shows the error (#1431)", () => {
  const inUse = { error: "Branch 'fix' is already checked out at /repo-worktrees/fix", code: "branch_in_use", branch: "fix", worktreePath: "/repo-worktrees/fix" };
  assert.deepEqual(worktreeCreateFailure(inUse, 409), {
    key: "sidebar.worktreeBranchInUse",
    params: { branch: "fix", path: "/repo-worktrees/fix" },
  });
  assert.deepEqual(worktreeCreateFailure({ ...inUse, code: "branch_worktree_missing" }, 409), {
    key: "sidebar.worktreeBranchMissing",
    params: { branch: "fix", path: "/repo-worktrees/fix" },
  });
  assert.deepEqual(worktreeCreateFailure({ error: "fatal: 'a..b' is not a valid branch name" }, 400), { error: "fatal: 'a..b' is not a valid branch name" });
  assert.deepEqual(worktreeCreateFailure({}, 502), { error: "HTTP 502" });
  for (const locale of [enLocale, zhCNLocale, zhTWLocale]) {
    assert.match(locale.messages["sidebar.worktreeBranchInUse"], /\{branch\}.*\{path\}/);
    assert.match(locale.messages["sidebar.worktreeBranchMissing"], /\{branch\}.*\{path\}.*git worktree prune/);
  }
});

test("a group menu offers Rename… always and Reset name only while the project has a name of its own", () => {
  assert.deepEqual(projectNameMenuEntries({ customName: null }), ["rename-project"]);
  assert.deepEqual(projectNameMenuEntries({ customName: "Thermal Models" }), ["rename-project", "reset-project-name"]);
  for (const key of ["sidebar.renameProject", "sidebar.resetProjectName", "sidebar.projectName"]) {
    assert.equal(typeof enLocale.messages[key], "string", `${key} is translated`);
  }
});

test("a project rename saves a trimmed name, and empty or the folder's own name clears it", () => {
  const plain = { key: "/work/thermal-key", root: "/work/sim/thermal", name: "thermal", customName: null };
  const named = { ...plain, name: "Thermal Models", customName: "Thermal Models" };
  // The field starts with the name shown: left as it is, nothing is saved.
  assert.equal(projectRenameRequest(plain, "thermal"), null);
  assert.equal(projectRenameRequest(named, "  Thermal Models "), null);
  // Saved by projectKey, trimmed; Unicode and markup are text like any other.
  assert.deepEqual(projectRenameRequest(plain, "  热模型 <b>v2</b> "), { action: "rename-project", projectKey: "/work/thermal-key", name: "热模型 <b>v2</b>" });
  assert.deepEqual(projectRenameRequest(named, "Thermal"), { action: "rename-project", projectKey: "/work/thermal-key", name: "Thermal" });
  // Empty or the folder name: back to the folder name, which an unnamed project shows already.
  for (const value of ["", "   ", "thermal", " thermal "]) {
    assert.deepEqual(projectRenameRequest(named, value), { action: "rename-project", projectKey: "/work/thermal-key", name: null }, JSON.stringify(value));
  }
  assert.equal(projectRenameRequest(plain, ""), null);
  assert.equal(projectRenameRequest(plain, "  "), null);
  // Windows roots: the folder name is the last segment either way.
  assert.equal(projectRenameRequest({ ...plain, root: "C:\\work\\sim\\thermal\\" }, "thermal"), null);
  // A name too long for the server goes out as typed: the server refuses it and the sidebar says so.
  const long = "x".repeat(81);
  assert.deepEqual(projectRenameRequest(plain, long), { action: "rename-project", projectKey: "/work/thermal-key", name: long });
});

/** A scripted POST /api/sessions/delete: each call's ids, then the answer `respond` gives. */
function deleteFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { ids } = JSON.parse(init.body);
    calls.push({ url, method: init.method, contentType: init.headers["Content-Type"], ids });
    const answer = await respond(ids, calls.length);
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  };
  return { calls, fetchImpl };
}

test("a project's delete-all goes out in parts, one at a time, and sums what each deleted", async () => {
  const ids = Array.from({ length: PROJECT_DELETE_IDS_PER_REQUEST * 2 + 3 }, (_, index) => `s${index}`);
  const { calls, fetchImpl } = deleteFetch((part, call) => ({
    body: {
      // The server answers subagent sessions too, and keeps one that started running.
      deleted: [...part.filter((id) => id !== "s7"), ...(call === 1 ? ["s0-child"] : [])],
      missing: [],
      running: part.includes("s7") ? ["s7"] : [],
    },
  }));

  const outcome = await deleteProjectSessions(ids, fetchImpl);

  assert.deepEqual(calls.map((call) => call.ids.length), [PROJECT_DELETE_IDS_PER_REQUEST, PROJECT_DELETE_IDS_PER_REQUEST, 3]);
  assert.deepEqual(calls.flatMap((call) => call.ids), ids);
  for (const call of calls) assert.deepEqual([call.url, call.method, call.contentType], ["/api/sessions/delete", "POST", "application/json"]);
  assert.deepEqual(outcome.deletedRoots, ids.filter((id) => id !== "s7"));
  assert.ok(outcome.deleted.includes("s0-child"));
  assert.equal(outcome.deleted.length, ids.length);
  assert.deepEqual(outcome.running, ["s7"]);
  assert.equal(outcome.error, null);
});

test("a refused or failed part ends a project's delete-all, reporting what went before it", async () => {
  const ids = Array.from({ length: PROJECT_DELETE_IDS_PER_REQUEST + 1 }, (_, index) => `s${index}`);
  const refused = deleteFetch((part, call) => (call === 1
    ? { body: { deleted: part, missing: [], running: [] } }
    : { status: 403, body: { error: "Untrusted API request" } }));
  const outcome = await deleteProjectSessions(ids, refused.fetchImpl);
  assert.equal(refused.calls.length, 2);
  assert.equal(outcome.deletedRoots.length, PROJECT_DELETE_IDS_PER_REQUEST);
  assert.equal(outcome.error, "Untrusted API request");

  // No JSON error: the status stands in; a network failure ends it too.
  const bare = await deleteProjectSessions(["a"], async () => new Response("oops", { status: 502 }));
  assert.deepEqual(bare, { deletedRoots: [], deleted: [], running: [], error: "HTTP 502" });
  const offline = await deleteProjectSessions(["a", "b"], async () => { throw new TypeError("Failed to fetch"); });
  assert.deepEqual(offline, { deletedRoots: [], deleted: [], running: [], error: "Failed to fetch" });
  assert.deepEqual(await deleteProjectSessions([], async () => { throw new Error("never called"); }), { deletedRoots: [], deleted: [], running: [], error: null });
});

test("a title is requested for the session id the menu passed, trimmed", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method });
    return new Response(JSON.stringify({ title: "  Fix the login bug \n", usage: null }), { status: 200 });
  };
  // The id is encoded into the path: no session id can reach another route.
  assert.deepEqual(await requestSessionTitle("a/b c", fetchImpl), { title: "Fix the login bug" });
  assert.deepEqual(calls, [{ url: "/api/sessions/a%2Fb%20c/auto-name", method: "POST" }]);
});

test("two sessions' title requests are independent, whichever answers first", async () => {
  // The answer carries no session: the caller pairs it with the id it asked about,
  // so a session opened meanwhile cannot take another's title.
  const answers = new Map();
  const fetchImpl = (url) => new Promise((resolve) => answers.set(url, resolve));
  const first = requestSessionTitle("first", fetchImpl);
  const second = requestSessionTitle("second", fetchImpl);
  assert.deepEqual([...answers.keys()], ["/api/sessions/first/auto-name", "/api/sessions/second/auto-name"]);
  answers.get("/api/sessions/second/auto-name")(new Response(JSON.stringify({ title: "Second title" })));
  answers.get("/api/sessions/first/auto-name")(new Response(JSON.stringify({ title: "First title" })));
  assert.deepEqual(await second, { title: "Second title" });
  assert.deepEqual(await first, { title: "First title" });
});

test("a refused, empty or unreachable title request says why instead of throwing", async () => {
  const answer = (body, status) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  assert.deepEqual(await requestSessionTitle("s", answer({ error: "The session has no usable text to name" }, 500)), { error: "The session has no usable text to name" });
  assert.deepEqual(await requestSessionTitle("s", answer({ error: "Session not found" }, 404)), { error: "Session not found" });
  // No JSON error: the status stands in.
  assert.deepEqual(await requestSessionTitle("s", answer("oops", 502)), { error: "HTTP 502" });
  // A 200 without a usable title is no success.
  assert.deepEqual(await requestSessionTitle("s", answer({ title: "   " }, 200)), { error: "HTTP 200" });
  assert.deepEqual(await requestSessionTitle("s", answer({}, 200)), { error: "HTTP 200" });
  assert.deepEqual(await requestSessionTitle("s", answer({ title: "x" }, 500)), { error: "HTTP 500" });
  assert.deepEqual(await requestSessionTitle("s", async () => { throw new TypeError("Failed to fetch"); }), { error: "Failed to fetch" });
  assert.deepEqual(await requestSessionTitle("s", async () => { throw "boom"; }), { error: "boom" });
});
