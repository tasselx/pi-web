import assert from "node:assert/strict";
import { execFileSync, spawn as realSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSleepInhibitor } = await jiti.import("./sleep-inhibitor.ts");

async function until(condition, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for: ${message}`);
    await sleep(5);
  }
}

/**
 * A stand-in for the holder process. `behavior` says what it does after it starts:
 *   "ready"                  prints the ready line, then holds until stdin closes or it is killed
 *   { readyAfter: ms }       the same, later
 *   "enoent"                 cannot start ('error' event, as for a missing command)
 *   { exit, stderr }         exits before it ever held the lock
 *   "silent"                 never reports ready
 *   { stubborn: true }       holds, and ignores stdin closing and SIGTERM (only SIGKILL ends it)
 *   "throw"                  spawn() itself throws
 */
function fakeSpawner(behaviorFor) {
  const spawned = [];
  const spawn = (command, args, options) => {
    const index = spawned.length;
    const behavior = typeof behaviorFor === "function" ? behaviorFor(command, index) : behaviorFor[Math.min(index, behaviorFor.length - 1)];
    if (behavior === "throw") throw new Error(`spawn ${command} EACCES`);
    const child = new EventEmitter();
    child.command = command;
    child.args = args;
    child.options = options;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.signals = [];
    child.die = (code, signal = null) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.exitCode = signal ? null : code;
      child.signalCode = signal;
      setImmediate(() => child.emit("exit", code, signal));
    };
    child.kill = (signal = "SIGTERM") => {
      child.signals.push(signal);
      if (behavior?.stubborn && signal !== "SIGKILL") return true;
      child.die(null, signal);
      return true;
    };
    if (!behavior?.stubborn) child.stdin.on("close", () => child.die(0));
    spawned.push(child);

    const sayReady = () => setImmediate(() => child.stdout.write("ready\n"));
    if (behavior === "ready" || behavior?.stubborn) sayReady();
    else if (behavior?.readyAfter !== undefined) setTimeout(() => child.stdout.write("ready\n"), behavior.readyAfter);
    else if (behavior === "enoent") setImmediate(() => child.emit("error", Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" })));
    else if (behavior?.exit !== undefined) {
      setImmediate(() => {
        if (behavior.stderr) child.stderr.write(behavior.stderr);
        setImmediate(() => child.die(behavior.exit));
      });
    }
    return child;
  };
  const live = () => spawned.filter((child) => child.exitCode === null && child.signalCode === null);
  return { spawn, spawned, live };
}

function make(t, { behaviors = ["ready"], plan, ...deps } = {}) {
  const state = { running: 0, saved: false, loads: 0, logs: [] };
  const spawner = fakeSpawner(behaviors);
  const inhibitor = createSleepInhibitor({
    plan: plan ?? { supported: true, holders: [{ label: "fake", command: "fake-holder", args: ["--hold"] }] },
    countRunning: () => state.running,
    loadEnabled: async () => {
      state.loads += 1;
      return state.saved;
    },
    spawn: spawner.spawn,
    env: { PATH: "/usr/bin", DBUS_SESSION_BUS_ADDRESS: "unix:path=/bus", PI_WEB_PASSWORD: "secret" },
    readyTimeoutMs: 200,
    graceMs: 50,
    watchdogMs: 40,
    log: (message) => state.logs.push(message),
    ...deps,
  });
  t.after(() => inhibitor.dispose());
  return { inhibitor, state, spawner };
}

test("off by default: running tasks hold nothing, and the saved switch is read once", async (t) => {
  const { inhibitor, state, spawner } = make(t);
  state.running = 2;
  inhibitor.refresh();
  inhibitor.refresh();
  await inhibitor.ready();
  inhibitor.refresh();
  assert.equal(state.loads, 1);
  assert.equal(spawner.spawned.length, 0);
  assert.deepEqual(inhibitor.status(), { enabled: false, supported: true, active: false });
});

test("switched on with no task running holds nothing; the first task takes the hold, the last one gives it up", async (t) => {
  const { inhibitor, state, spawner } = make(t);
  const enabled = await inhibitor.setEnabled(true);
  assert.deepEqual(enabled, { enabled: true, supported: true, active: false });
  assert.equal(spawner.spawned.length, 0);

  state.running = 1;
  inhibitor.refresh();
  await until(() => inhibitor.status().active, "the hold");
  assert.equal(spawner.spawned.length, 1);

  state.running = 0;
  inhibitor.refresh();
  await until(() => spawner.live().length === 0, "the holder to end");
  assert.equal(inhibitor.status().active, false);
  assert.equal(spawner.spawned[0].stdin.destroyed, true, "released by closing its stdin");
  assert.deepEqual(state.logs, []);
});

test("several tasks share one hold; it is kept until the last one ends", async (t) => {
  const { inhibitor, state, spawner } = make(t);
  await inhibitor.setEnabled(true);
  state.running = 3;
  inhibitor.refresh();
  await until(() => inhibitor.status().active, "the hold");
  for (let i = 0; i < 5; i += 1) inhibitor.refresh(); // every event asks again
  assert.equal(spawner.spawned.length, 1);

  state.running = 2;
  inhibitor.refresh();
  state.running = 1;
  inhibitor.refresh();
  await sleep(60);
  assert.equal(inhibitor.status().active, true, "one task finishing while others run must not release");
  assert.equal(spawner.live().length, 1);

  state.running = 0;
  inhibitor.refresh();
  await until(() => spawner.live().length === 0, "the holder to end");
  assert.equal(inhibitor.status().active, false);
});

test("switching on in the middle of a task takes the hold at once; off releases at once; on again re-checks", async (t) => {
  const { inhibitor, state, spawner } = make(t);
  state.running = 1;
  inhibitor.refresh();
  await inhibitor.ready();
  assert.equal(spawner.spawned.length, 0);

  const on = await inhibitor.setEnabled(true);
  assert.equal(on.active, true);
  assert.equal(spawner.live().length, 1);

  const off = await inhibitor.setEnabled(false);
  assert.deepEqual(off, { enabled: false, supported: true, active: false });
  assert.equal(spawner.live().length, 0, "gone by the time the request returns");
  assert.equal(state.running, 1, "the tasks themselves are not touched");

  inhibitor.refresh();
  assert.equal(spawner.spawned.length, 1, "off means task events hold nothing");

  const again = await inhibitor.setEnabled(true);
  assert.equal(again.active, true);
  assert.equal(spawner.spawned.length, 2);
});

test("the saved switch applies from the first task after a restart", async (t) => {
  const { inhibitor, state, spawner } = make(t);
  state.saved = true;
  state.running = 1;
  inhibitor.refresh(); // the first event reads the saved value, then acts on it
  await until(() => inhibitor.status().active, "the hold");
  assert.equal(inhibitor.status().enabled, true);
  assert.equal(spawner.spawned.length, 1);
  assert.equal(state.loads, 1);
});

test("a switch toggled before the saved value arrives wins over it", async (t) => {
  const { inhibitor } = make(t, { loadEnabled: async () => { await sleep(30); return true; } });
  inhibitor.refresh();
  const off = await inhibitor.setEnabled(false);
  await inhibitor.ready();
  assert.equal(off.enabled, false);
  assert.equal(inhibitor.status().enabled, false);
});

test("a saved switch that cannot be read leaves the feature off and says so in the log", async (t) => {
  const { inhibitor, state, spawner } = make(t, { loadEnabled: async () => { throw new Error("EACCES: permission denied"); } });
  state.running = 1;
  inhibitor.refresh();
  await inhibitor.ready();
  assert.equal(inhibitor.status().enabled, false);
  assert.equal(spawner.spawned.length, 0);
  assert.match(state.logs[0], /EACCES/);

  const sync = make(t, { loadEnabled: () => { throw new Error("EIO"); } });
  assert.doesNotThrow(() => sync.inhibitor.refresh());
  await sync.inhibitor.ready();
  assert.match(sync.state.logs[0], /EIO/);
});

test("a holder that cannot start is logged and shown, never fails a task, and is not retried within the run", async (t) => {
  const { inhibitor, state, spawner } = make(t, { behaviors: ["enoent"] });
  await inhibitor.setEnabled(true);
  state.running = 1;
  inhibitor.refresh();
  await until(() => inhibitor.status().failure, "the failure");
  assert.equal(inhibitor.status().active, false, "never shown as held");
  assert.match(inhibitor.status().failure, /fake: .*ENOENT/);
  assert.equal(state.logs.length, 1);

  for (let i = 0; i < 5; i += 1) {
    inhibitor.refresh();
    await sleep(10);
  }
  assert.equal(spawner.spawned.length, 1, "no retry loop while the same run continues");
  assert.equal(state.logs.length, 1, "and no log spam");

  // The run ends without an event reaching us; the watchdog notices, so the next run starts fresh.
  state.running = 0;
  await sleep(120);
  state.running = 1;
  inhibitor.refresh();
  await until(() => spawner.spawned.length === 2, "a fresh attempt for the next run");
});

test("turning the switch off and on again retries a failed hold", async (t) => {
  const { inhibitor, state, spawner } = make(t, { behaviors: ["enoent", "ready"] });
  state.running = 1;
  await inhibitor.setEnabled(true);
  assert.equal(inhibitor.status().active, false);
  assert.ok(inhibitor.status().failure);

  await inhibitor.setEnabled(false);
  assert.equal(inhibitor.status().failure, undefined);
  const again = await inhibitor.setEnabled(true);
  assert.equal(again.active, true);
  assert.equal(again.failure, undefined);
  assert.equal(spawner.spawned.length, 2);
});

test("a failing candidate falls through to the next one; all failing are all named", async (t) => {
  const plan = {
    supported: true,
    holders: [
      { label: "first", command: "first-holder", args: [] },
      { label: "second", command: "second-holder", args: [] },
    ],
  };
  const fallback = make(t, { plan, behaviors: (command) => (command === "first-holder" ? "enoent" : "ready") });
  fallback.state.running = 1;
  await fallback.inhibitor.setEnabled(true);
  assert.equal(fallback.inhibitor.status().active, true);
  assert.equal(fallback.inhibitor.status().failure, undefined);
  assert.deepEqual(fallback.spawner.spawned.map((child) => child.command), ["first-holder", "second-holder"]);

  const failing = make(t, { plan, behaviors: ["enoent"] });
  failing.state.running = 1;
  await failing.inhibitor.setEnabled(true);
  assert.equal(failing.inhibitor.status().active, false);
  assert.match(failing.inhibitor.status().failure, /first: .*second: /);
});

test("spawn throwing, exiting before ready, and never reporting ready all end as a shown failure", async (t) => {
  const thrown = make(t, { behaviors: ["throw"] });
  thrown.state.running = 1;
  await thrown.inhibitor.setEnabled(true);
  assert.match(thrown.inhibitor.status().failure, /EACCES/);

  const early = make(t, { behaviors: [{ exit: 1, stderr: "Failed to connect to the session bus" }] });
  early.state.running = 1;
  await early.inhibitor.setEnabled(true);
  assert.match(early.inhibitor.status().failure, /session bus/);
  assert.equal(early.inhibitor.status().active, false);

  const silent = make(t, { behaviors: ["silent"], readyTimeoutMs: 30 });
  silent.state.running = 1;
  await silent.inhibitor.setEnabled(true);
  assert.match(silent.inhibitor.status().failure, /did not report ready/);
  assert.equal(silent.spawner.live().length, 0, "the stuck holder is not left running");
});

test("a hold killed from outside stops counting as held, is shown, and is not respawned within the run", async (t) => {
  const { inhibitor, state, spawner } = make(t);
  await inhibitor.setEnabled(true);
  state.running = 1;
  inhibitor.refresh();
  await until(() => inhibitor.status().active, "the hold");

  spawner.spawned[0].die(null, "SIGKILL");
  await until(() => !inhibitor.status().active, "the loss to be noticed");
  assert.match(inhibitor.status().failure, /stopped unexpectedly \(SIGKILL\)/);
  inhibitor.refresh();
  await sleep(20);
  assert.equal(spawner.spawned.length, 1);

  state.running = 0;
  inhibitor.refresh();
  state.running = 1;
  inhibitor.refresh();
  await until(() => inhibitor.status().active, "the next run's hold");
  assert.equal(spawner.spawned.length, 2);
  assert.equal(inhibitor.status().failure, undefined);
});

test("a hold still being taken when the last task ends is voided and its holder ended", async (t) => {
  const { inhibitor, state, spawner } = make(t, { behaviors: [{ readyAfter: 60 }] });
  await inhibitor.setEnabled(true);
  state.running = 1;
  inhibitor.refresh();
  await sleep(10);
  assert.equal(spawner.spawned.length, 1);

  state.running = 0;
  inhibitor.refresh();
  await until(() => spawner.live().length === 0, "the half-started holder to end");
  await sleep(100); // past the moment it would have reported ready
  assert.equal(inhibitor.status().active, false);
  assert.equal(inhibitor.status().failure, undefined, "a voided attempt is not a failure");
  assert.deepEqual(inhibitor.status(), { enabled: true, supported: true, active: false });
});

test("switching off while a hold is being taken waits for it to be gone", async (t) => {
  const { inhibitor, state, spawner } = make(t, { behaviors: [{ readyAfter: 40 }] });
  await inhibitor.setEnabled(true);
  state.running = 1;
  inhibitor.refresh();
  await sleep(5);
  const off = await inhibitor.setEnabled(false);
  assert.equal(off.active, false);
  assert.equal(spawner.live().length, 0);
});

test("a holder that ignores the polite release is killed once the grace period passes", async (t) => {
  const { inhibitor, state, spawner } = make(t, { behaviors: [{ stubborn: true }], graceMs: 30 });
  state.running = 1;
  const on = await inhibitor.setEnabled(true);
  assert.equal(on.active, true);

  const off = await inhibitor.setEnabled(false);
  assert.equal(off.active, false);
  assert.deepEqual(spawner.spawned[0].signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(spawner.live().length, 0);
});

test("the watchdog gives the hold up when a run ended without any event", async (t) => {
  const { inhibitor, state, spawner } = make(t);
  await inhibitor.setEnabled(true);
  state.running = 1;
  inhibitor.refresh();
  await until(() => inhibitor.status().active, "the hold");

  state.running = 0; // e.g. a compaction that finished without an event
  await until(() => !inhibitor.status().active, "the watchdog to notice");
  assert.equal(spawner.live().length, 0);
});

test("dispose releases at once and later task events cannot take a new hold", async (t) => {
  const { inhibitor, state, spawner } = make(t);
  state.running = 1;
  await inhibitor.setEnabled(true);
  assert.equal(spawner.live().length, 1);

  inhibitor.dispose();
  assert.equal(spawner.spawned[0].stdin.destroyed, true);
  assert.deepEqual(spawner.spawned[0].signals, ["SIGTERM"]);
  assert.equal(inhibitor.status().active, false);

  inhibitor.refresh(); // process.exit is destroying sessions and telling us about it
  await sleep(20);
  assert.equal(spawner.spawned.length, 1);
});

test("a machine that cannot hold reports why, accepts the switch, and spawns nothing", async (t) => {
  const { inhibitor, state, spawner } = make(t, { plan: { supported: false, reason: "No sleep inhibitor was found." } });
  state.running = 1;
  const status = await inhibitor.setEnabled(true);
  assert.deepEqual(status, { enabled: true, supported: false, unsupportedReason: "No sleep inhibitor was found.", active: false });
  inhibitor.refresh();
  assert.equal(spawner.spawned.length, 0);
});

test("the holder gets pipes, no console window, the session environment and never Pi Web's password", async (t) => {
  const { inhibitor, state, spawner } = make(t);
  state.running = 1;
  await inhibitor.setEnabled(true);
  const [child] = spawner.spawned;
  assert.equal(child.command, "fake-holder");
  assert.deepEqual(child.args, ["--hold"]);
  assert.deepEqual(child.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(child.options.windowsHide, true);
  assert.equal(child.options.env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/bus");
  assert.equal("PI_WEB_PASSWORD" in child.options.env, false);
});

// ---------------------------------------------------------------------------
// Real processes. The holder here is Node itself, so these run on every OS.
// ---------------------------------------------------------------------------

const NODE_HOLDER_ARGS = ["-e", "console.log('ready'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"];
const nodeHolderPlan = { supported: true, holders: [{ label: "node", command: process.execPath, args: NODE_HOLDER_ARGS }] };

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

test("a real holder process is started, reported held, and gone once released", async (t) => {
  const children = [];
  const { inhibitor, state } = make(t, {
    plan: nodeHolderPlan,
    readyTimeoutMs: 10_000,
    graceMs: 2000,
    spawn: (...args) => {
      const child = realSpawn(...args);
      children.push(child);
      return child;
    },
  });
  state.running = 1;
  const on = await inhibitor.setEnabled(true);
  assert.equal(on.active, true, on.failure);
  const [{ pid }] = children;
  assert.equal(processExists(pid), true);

  const off = await inhibitor.setEnabled(false);
  assert.equal(off.active, false);
  assert.equal(processExists(pid), false, "no process is left behind");
});

test("a real holder leaves by itself when its parent is killed, so a crash leaves no hold", { skip: process.platform === "win32" }, async () => {
  const parent = realSpawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const holder = spawn(process.execPath, ${JSON.stringify(NODE_HOLDER_ARGS)}, { stdio: ["pipe", "pipe", "ignore"] });
    holder.stdout.once("data", () => console.log(holder.pid));
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "inherit"] });
  let holderPid;
  try {
    holderPid = Number(await new Promise((resolve, reject) => {
      parent.stdout.once("data", (chunk) => resolve(String(chunk).trim()));
      parent.once("error", reject);
      parent.once("exit", () => reject(new Error("the parent exited before reporting the holder")));
    }));
    assert.equal(processExists(holderPid), true);
    parent.kill("SIGKILL"); // no cleanup code of the parent runs
    await until(() => !processExists(holderPid), "the orphaned holder to exit", 5000);
  } finally {
    parent.kill("SIGKILL");
    if (holderPid && processExists(holderPid)) process.kill(holderPid, "SIGKILL");
  }
});

// ---------------------------------------------------------------------------
// macOS: the real thing, as the system itself reports it.
// ---------------------------------------------------------------------------

function caffeinateIdleAssertions() {
  const output = execFileSync("pmset", ["-g", "assertions"], { encoding: "utf8" });
  return output.split("\n").filter((line) => /\(caffeinate\):/.test(line) && /PreventUserIdleSystemSleep/.test(line)).length;
}

test("macOS: the real caffeinate holds an idle-sleep assertion while a task runs and drops it after", { skip: process.platform !== "darwin" }, async (t) => {
  const state = { running: 1 };
  const inhibitor = createSleepInhibitor({ countRunning: () => state.running, loadEnabled: async () => false, log: () => {} });
  t.after(() => inhibitor.dispose());
  const before = caffeinateIdleAssertions();

  const on = await inhibitor.setEnabled(true);
  assert.equal(on.supported, true);
  assert.equal(on.active, true, on.failure);
  assert.equal(caffeinateIdleAssertions(), before + 1);

  state.running = 0;
  inhibitor.refresh();
  await until(() => caffeinateIdleAssertions() === before, "the assertion to be dropped", 5000);
  assert.equal(inhibitor.status().active, false);

  state.running = 1;
  inhibitor.refresh();
  await until(() => caffeinateIdleAssertions() === before + 1, "the next run's assertion", 5000);
  await inhibitor.setEnabled(false);
  assert.equal(caffeinateIdleAssertions(), before, "switching off releases it at once");
});
