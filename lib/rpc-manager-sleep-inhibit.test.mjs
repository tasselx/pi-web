import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";

// What decides when "prevent system sleep while running" holds: the places in
// rpc-manager.ts that report a session's running state to lib/sleep-inhibitor.ts.
// The controller itself is covered by sleep-inhibitor.test.mjs.
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { createSleepInhibitor } = await jiti.import("./sleep-inhibitor.ts");

async function until(condition, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for: ${message}`);
    await sleep(5);
  }
}

/** A switched-on controller over a private session registry, with a holder that is only a stream pair. */
async function setup(t) {
  const registry = new Map();
  const previousRegistry = globalThis.__piSessions;
  const previousInhibitor = globalThis.__piSleepInhibitor;
  const holders = [];
  const inhibitor = createSleepInhibitor({
    plan: { supported: true, holders: [{ label: "fake", command: "fake-holder", args: [] }] },
    loadEnabled: async () => true,
    spawn: () => {
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
      holders.push(child);
      return child;
    },
    // Far beyond the test: every change here has to come from a reported event.
    watchdogMs: 600_000,
    log: () => {},
  });
  globalThis.__piSessions = registry;
  globalThis.__piSleepInhibitor = inhibitor;
  t.after(() => {
    inhibitor.dispose();
    globalThis.__piSessions = previousRegistry;
    globalThis.__piSleepInhibitor = previousInhibitor;
  });
  await inhibitor.ready();

  return {
    inhibitor,
    held: () => inhibitor.status().active,
    liveHolders: () => holders.filter((child) => child.exitCode === null).length,
    /** A wrapper over a fake SDK session, registered as startRpcSession() would. */
    session(id, { prompt = () => Promise.resolve(), ...overrides } = {}) {
      let listener = () => {};
      const inner = {
        sessionId: id,
        isBashRunning: false,
        isStreaming: false,
        isCompacting: false,
        extensionRunner: {},
        sessionManager: { getCwd: () => "/tmp", getSessionName: () => undefined, getEntries: () => [], getSessionFile: () => undefined },
        settingsManager: { getShellPath: () => undefined },
        systemPrompt: "",
        agent: { state: {} },
        getContextUsage: () => null,
        getSteeringMessages: () => [],
        getFollowUpMessages: () => [],
        subscribe: (next) => {
          listener = next;
          return () => {};
        },
        prompt,
        dispose() {},
        ...overrides,
      };
      const wrapper = new AgentSessionWrapper(inner);
      t.after(() => wrapper.destroy());
      wrapper.start();
      registry.set(id, wrapper);
      return { wrapper, inner, emit: (event) => listener(event) };
    },
  };
}

test("an agent run holds from its first event until it has settled", async (t) => {
  const { held, liveHolders, session } = await setup(t);
  const run = session("a");
  assert.equal(held(), false, "an idle session holds nothing");

  run.inner.isStreaming = true;
  run.emit({ type: "agent_start" });
  await until(held, "the hold");
  assert.equal(liveHolders(), 1);

  run.inner.isStreaming = false;
  run.emit({ type: "agent_end" });
  run.emit({ type: "agent_settled" });
  await until(() => !held(), "the release");
  assert.equal(liveHolders(), 0);
});

test("a compaction counts as running, and the hold ends with it", async (t) => {
  const { held, session } = await setup(t);
  const run = session("a");
  run.inner.isCompacting = true;
  run.emit({ type: "compaction_start" });
  await until(held, "the hold");

  run.inner.isCompacting = false;
  run.emit({ type: "compaction_end" });
  await until(() => !held(), "the release");
});

test("one hold serves every running session, subagents included, until the last of them ends", async (t) => {
  const { held, liveHolders, session } = await setup(t);
  const main = session("main");
  const subagent = session("main/subagent-1");
  main.inner.isStreaming = true;
  main.emit({ type: "agent_start" });
  subagent.inner.isStreaming = true;
  subagent.emit({ type: "agent_start" });
  await until(held, "the hold");
  assert.equal(liveHolders(), 1);

  subagent.inner.isStreaming = false;
  subagent.emit({ type: "agent_settled" });
  await sleep(40);
  assert.equal(held(), true, "the main session is still running");

  main.inner.isStreaming = false;
  main.emit({ type: "agent_settled" });
  await until(() => !held(), "the release");
});

test("a prompt holds from the moment it is admitted until it settles, with or without any agent event", async (t) => {
  let acceptPreflight;
  let finishPrompt;
  const { held, session } = await setup(t);
  const { wrapper } = session("a", {
    prompt: (_message, options) => new Promise((resolve) => {
      acceptPreflight = () => options.preflightResult("started");
      finishPrompt = resolve;
    }),
  });

  const sending = wrapper.send({ type: "prompt", message: "hello" });
  await until(held, "the hold while the prompt waits for acceptance");
  acceptPreflight();
  await sending;
  assert.equal(held(), true);

  finishPrompt();
  await until(() => !held(), "the release");
});

test("a prompt that fails leaves no hold behind", async (t) => {
  const { held, session } = await setup(t);
  const { wrapper } = session("a", { prompt: () => Promise.reject(new Error("no model")) });
  await assert.rejects(wrapper.send({ type: "prompt", message: "hello" }), /no model/);
  await sleep(40);
  assert.equal(held(), false);

  const sync = session("b", { prompt: () => { throw new Error("rejected synchronously"); } });
  await assert.rejects(sync.wrapper.send({ type: "prompt", message: "hello" }), /rejected synchronously/);
  await sleep(40);
  assert.equal(held(), false);
});

test("a `!` command holds while it runs", async (t) => {
  let finishCommand;
  const { held, session } = await setup(t);
  const run = session("a");
  run.inner.executeBash = () => {
    run.inner.isBashRunning = true; // the SDK marks it before its first await
    return new Promise((resolve) => {
      finishCommand = (result) => {
        run.inner.isBashRunning = false;
        resolve(result);
      };
    });
  };

  const executing = run.wrapper.send({ type: "bash", command: "sleep 30" });
  await until(held, "the hold");
  finishCommand({ output: "", exitCode: 0 });
  await executing;
  await until(() => !held(), "the release");
});

test("destroying a running session gives its hold up", async (t) => {
  const { held, session } = await setup(t);
  const run = session("a");
  run.inner.isStreaming = true;
  run.emit({ type: "agent_start" });
  await until(held, "the hold");

  run.wrapper.destroy();
  await until(() => !held(), "the release");
});
