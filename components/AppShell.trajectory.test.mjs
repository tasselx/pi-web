import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";

// The handlers are run as AppShell wrote them: found in its syntax tree and
// executed with the few names they use (same way as AppShell.sidebar-breakpoint).
const text = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("AppShell.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = [];
(function visit(node) { nodes.push(node); ts.forEachChild(node, visit); })(source);

function declaration(name) {
  const found = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === name);
  assert.ok(found, `${name} not found in AppShell`);
  return found;
}

function run(code, context) {
  return new Script(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText).runInContext(context);
}

/** The function a `useCallback` declaration wraps. */
function callback(name) {
  return declaration(name).initializer.arguments[0].getText(source);
}

/** The effect that collapses the trajectory when the selected session changes. */
const clearOnSelectionChange = nodes.find((node) => ts.isCallExpression(node)
  && node.expression.getText(source) === "useEffect"
  && node.arguments[1]?.getText(source) === "[selectedSession?.id]"
  && node.arguments[0].getText(source).includes("setTrajectorySessionId(null)"));
assert.ok(clearOnSelectionChange, "the effect that clears the trajectory on a session change");

/**
 * AppShell's trajectory state for a selected session. Only the names the
 * handler uses exist, so a handler reaching for anything else (the top bar's
 * panels, the chat's remount key) throws a ReferenceError here.
 */
function appShell({ selected = "s1", open = null } = {}) {
  const context = createContext({});
  const shell = {
    trajectorySessionId: open,
    selected,
    context,
    /** The id AppShell passes to the view: the trajectory of the selected session, or none. */
    get opened() {
      context.trajectorySessionId = shell.trajectorySessionId;
      context.selectedSession = shell.selected === null ? null : { id: shell.selected };
      return run(declaration("openTrajectorySessionId").initializer.getText(source), context);
    },
    /** A pick on the Chat | Trajectory tabs. */
    view(next) { run(`(${callback("handleChatViewChange")})(${JSON.stringify(next)})`, shell.sync()); },
    selectOther(id) {
      shell.selected = id;
      run(`(${clearOnSelectionChange.arguments[0].getText(source)})()`, shell.sync());
    },
    sync() {
      context.selectedSessionRef = { current: shell.selected === null ? null : { id: shell.selected } };
      context.setTrajectorySessionId = (value) => {
        shell.trajectorySessionId = typeof value === "function" ? value(shell.trajectorySessionId) : value;
      };
      return context;
    },
  };
  return shell;
}

test("Trajectory opens on its tab and Chat brings the conversation back, over and over", () => {
  const shell = appShell();
  assert.equal(shell.opened, null);
  for (let round = 0; round < 3; round++) {
    shell.view("trajectory");
    assert.equal(shell.opened, "s1", `open, round ${round}`);
    shell.view("chat");
    assert.equal(shell.opened, null, `closed, round ${round}`);
  }
});

test("picking the view already shown changes nothing: they are tabs, not switches", () => {
  const shell = appShell();
  shell.view("chat");
  assert.equal(shell.opened, null);
  shell.view("trajectory");
  shell.view("trajectory");
  assert.equal(shell.opened, "s1");
  shell.view("chat");
  shell.view("chat");
  assert.equal(shell.opened, null);
});

test("only the selected session's trajectory counts as open, and a pick on another's opens rather than closes", () => {
  const shell = appShell({ selected: "s1", open: "s0" });
  assert.equal(shell.opened, null);
  shell.view("trajectory");
  assert.equal(shell.opened, "s1");
});

test("a trajectory is collapsed by the session changing, and stays collapsed when the first one is selected again", () => {
  const shell = appShell();
  shell.view("trajectory");
  assert.equal(shell.opened, "s1");
  shell.selectOther("s2");
  assert.equal(shell.trajectorySessionId, null);
  assert.equal(shell.opened, null);
  shell.selectOther("s1");
  assert.equal(shell.opened, null);
  // A fresh composer has no session: nothing to open there either.
  shell.selectOther(null);
  shell.view("trajectory");
  assert.equal(shell.trajectorySessionId, null);
  assert.equal(shell.opened, null);
});

test("the handler touches the trajectory only: not the top bar's panels, the session, the chat's key or its requests", () => {
  const body = callback("handleChatViewChange");
  assert.doesNotMatch(body, /setActiveTopPanel|setSystemInfoLoading|setSelectedSession|setSessionKey|setRefreshKey|setSearchTarget|fetch\(/);
  // The chat's mount is keyed by sessionKey alone, which the handler does not bump: the trajectory view is a prop of it.
  assert.match(text, /<ChatWindow\s+key=\{sessionKey\}/);
});

test("the top bar hands the tabs and the view only the selected session's id", () => {
  assert.match(text, /trajectoryView=\{openTrajectorySessionId !== null \? \(\s*<LazyTrajectoryView\s+key=\{openTrajectorySessionId\}\s+sessionId=\{openTrajectorySessionId\}/);
  assert.match(text, /<ChatViewTabs\s+view=\{openTrajectorySessionId !== null \? "trajectory" : "chat"\}\s+onChange=\{handleChatViewChange\}\s+trajectoryDisabled=\{!selectedSession\}/);
});

test("System prompt and Tool definitions are pages of Session info, which a fresh composer can open too", () => {
  // Not buttons of the bar, and not slots of its dropdown any more.
  assert.doesNotMatch(text, /handleSystemInfoToggle|activeTopPanel === "(system|tools)"|data-mobile-toolbar-action=\{mobile \? "(system|tools)"/);
  assert.match(text, /<SessionInfoPanel\s+systemPrompt=\{systemPrompt\}\s+tools=\{systemTools\}\s+systemInfoLoading=\{systemInfoLoading\}\s+onOpenSystemInfo=\{refreshSystemInfo\}/);
  // The button that opens it is drawn without any usage numbers: a new session has none before its first message.
  assert.doesNotMatch(text, /!sessionStats && !contextUsage/);
  assert.match(text, /renderSessionStatsButton = \(mobile: boolean\) => \{[^]*?if \(!mobile && !showChat\) return null;/);
});
