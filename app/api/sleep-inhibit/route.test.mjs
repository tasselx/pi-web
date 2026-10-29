import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-sleep-inhibit-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");
const { createSleepInhibitor } = await jiti.import("../../../lib/sleep-inhibitor.ts");

const settingsPath = path.join(agentDir, "settings.json");
const supportedPlan = { supported: true, holders: [{ label: "fake", command: "fake-holder", args: [] }] };

test.after(async () => {
  globalThis.__piSleepInhibitor?.dispose();
  delete globalThis.__piSleepInhibitor;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

/** A holder that reports ready at once and ends when its stdin closes or it is killed. */
function fakeSpawn() {
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    const end = () => {
      if (child.exitCode !== null) return;
      child.exitCode = 0;
      setImmediate(() => child.emit("exit", 0, null));
    };
    child.kill = () => {
      end();
      return true;
    };
    child.stdin.on("close", end);
    setImmediate(() => child.stdout.write("ready\n"));
    children.push(child);
    return child;
  };
  return { spawn, children, live: () => children.filter((child) => child.exitCode === null).length };
}

/** A fresh controller in place of the process-wide one, as after a restart: it reads the saved switch itself. */
function install({ plan = supportedPlan, running = 0 } = {}) {
  globalThis.__piSleepInhibitor?.dispose();
  const holders = fakeSpawn();
  const state = { running };
  globalThis.__piSleepInhibitor = createSleepInhibitor({
    plan,
    countRunning: () => state.running,
    spawn: holders.spawn,
    log: () => {},
  });
  return { state, holders, inhibitor: globalThis.__piSleepInhibitor };
}

function put(body, headers = { host: "localhost", "Content-Type": "application/json" }) {
  return PUT(new Request("http://localhost/api/sleep-inhibit", {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

test("the switch is off by default and nothing is written for it", async () => {
  await rm(settingsPath, { force: true });
  install();
  assert.deepEqual(await (await GET()).json(), { enabled: false, supported: true, active: false });
  const off = await put({ enabled: false });
  assert.equal(off.status, 200);
  assert.deepEqual(await off.json(), { enabled: false, supported: true, active: false });
  await assert.rejects(readFile(settingsPath, "utf8"), { code: "ENOENT" });
});

test("switching on is saved beside the other settings and takes effect at once; off removes it and releases", async () => {
  await writeFile(settingsPath, JSON.stringify({ defaultModel: "m" }));
  const { state, holders } = install({ running: 1 });

  const on = await put({ enabled: true });
  assert.equal(on.status, 200);
  assert.deepEqual(await on.json(), { enabled: true, supported: true, active: true });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m", piWebPreventSleep: true });
  assert.equal(holders.live(), 1);
  assert.deepEqual(await (await GET()).json(), { enabled: true, supported: true, active: true });

  const off = await put({ enabled: false });
  assert.deepEqual(await off.json(), { enabled: false, supported: true, active: false });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m" });
  assert.equal(holders.live(), 0);
  assert.equal(state.running, 1, "the running task is not touched");
});

test("a saved switch is in force after a restart", async () => {
  await writeFile(settingsPath, JSON.stringify({ piWebPreventSleep: true }));
  const { state, inhibitor, holders } = install();
  // Nothing running: the switch is on, and nothing is held.
  assert.deepEqual(await (await GET()).json(), { enabled: true, supported: true, active: false });
  assert.equal(holders.live(), 0);

  // The first task after the restart takes the hold.
  state.running = 1;
  inhibitor.refresh();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(await (await GET()).json(), { enabled: true, supported: true, active: true });
});

test("a machine that cannot prevent sleep refuses the switch with the reason and saves nothing", async () => {
  await writeFile(settingsPath, JSON.stringify({ defaultModel: "m" }));
  install({ plan: { supported: false, reason: "caffeinate was not found at /usr/bin/caffeinate." } });

  const status = await (await GET()).json();
  assert.deepEqual(status, { enabled: false, supported: false, unsupportedReason: "caffeinate was not found at /usr/bin/caffeinate.", active: false });

  const on = await put({ enabled: true });
  assert.equal(on.status, 409);
  const body = await on.json();
  assert.equal(body.supported, false);
  assert.match(body.error, /caffeinate was not found/);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m" });

  // Switching off is always fine: it clears a value saved elsewhere.
  assert.equal((await put({ enabled: false })).status, 200);
});

test("a settings file that cannot be written is reported and leaves the running state alone", async () => {
  await writeFile(settingsPath, "{ not json");
  const { inhibitor, holders } = install({ running: 1 });
  const on = await put({ enabled: true });
  assert.equal(on.status, 500);
  assert.equal(inhibitor.status().enabled, false);
  assert.equal(holders.live(), 0);
});

test("refuses what is not a boolean, a foreign origin and a non-JSON body", async () => {
  await writeFile(settingsPath, JSON.stringify({ defaultModel: "m" }));
  const { holders } = install({ running: 1 });
  assert.equal((await put({ enabled: "yes" })).status, 400);
  assert.equal((await put({})).status, 400);
  assert.equal((await put("{")).status, 400);
  assert.equal((await put({ enabled: true }, { host: "localhost", "Content-Type": "text/plain" })).status, 415);
  assert.equal((await put({ enabled: true }, { host: "localhost", origin: "https://evil.example", "Content-Type": "application/json" })).status, 403);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m" });
  assert.equal(holders.live(), 0);
});
