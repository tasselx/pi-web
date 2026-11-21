import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-compaction-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");

const settingsPath = path.join(agentDir, "settings.json");
const MODEL = "openrouter/deepseek/deepseek-v4.1-flash-1017";

function put(body, headers = { host: "localhost", "Content-Type": "application/json" }) {
  return PUT(new Request("http://localhost/api/compaction", {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

function get(query = "") {
  return GET(new Request(`http://localhost/api/compaction${query}`));
}

async function settings() {
  return JSON.parse(await readFile(settingsPath, "utf8"));
}

test("reads pi's defaults and keeps the token settings when the switch moves", async () => {
  assert.deepEqual(await (await get()).json(), {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
    modelOverride: false,
  });

  await writeFile(settingsPath, JSON.stringify({
    defaultModel: "m",
    compaction: {
      enabled: true,
      reserveTokens: 50000,
      keepRecentTokens: 1000,
      modelOverrides: { [MODEL]: { reserveTokens: 30000, keepRecentTokens: 500 } },
    },
  }));
  const off = await put({ enabled: false });
  assert.equal(off.status, 200);
  assert.deepEqual(await off.json(), {
    enabled: false,
    reserveTokens: 50000,
    keepRecentTokens: 1000,
    modelOverride: false,
  });
  assert.deepEqual(await settings(), {
    defaultModel: "m",
    compaction: {
      enabled: false,
      reserveTokens: 50000,
      keepRecentTokens: 1000,
      modelOverrides: { [MODEL]: { reserveTokens: 30000, keepRecentTokens: 500 } },
    },
  });

  const on = await put({ enabled: true });
  assert.equal((await on.json()).enabled, true);
  assert.deepEqual(await (await get(`?provider=openrouter&modelId=deepseek/deepseek-v4.1-flash-1017`)).json(), {
    enabled: true,
    reserveTokens: 30000,
    keepRecentTokens: 500,
    modelOverride: true,
  });
});

test("sets and clears one model's reserve override, keeping its other keys", async () => {
  await writeFile(settingsPath, JSON.stringify({
    compaction: {
      reserveTokens: 16384,
      modelOverrides: { [MODEL]: { keepRecentTokens: 5000 } },
    },
  }));

  const saved = await put({ provider: "openrouter", modelId: "deepseek/deepseek-v4.1-flash-1017", reserveTokens: 209715 });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), {
    enabled: true,
    reserveTokens: 209715,
    keepRecentTokens: 5000,
    modelOverride: true,
  });
  assert.deepEqual(await settings(), {
    compaction: {
      reserveTokens: 16384,
      modelOverrides: { [MODEL]: { keepRecentTokens: 5000, reserveTokens: 209715 } },
    },
  });

  // Clearing only the reserve leaves the override's other key in place.
  const cleared = await put({ provider: "openrouter", modelId: "deepseek/deepseek-v4.1-flash-1017", reserveTokens: null });
  assert.deepEqual(await cleared.json(), {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 5000,
    modelOverride: false,
  });
  assert.deepEqual(await settings(), {
    compaction: {
      reserveTokens: 16384,
      modelOverrides: { [MODEL]: { keepRecentTokens: 5000 } },
    },
  });

  // An override holding only the reserve goes, and so does the empty modelOverrides.
  await writeFile(settingsPath, JSON.stringify({
    compaction: { modelOverrides: { [MODEL]: { reserveTokens: 209715 } } },
  }));
  assert.equal((await put({ provider: "openrouter", modelId: "deepseek/deepseek-v4.1-flash-1017", reserveTokens: null })).status, 200);
  assert.deepEqual(await settings(), {});
});

test("refuses what it cannot write and leaves the file alone", async () => {
  await writeFile(settingsPath, JSON.stringify({ defaultModel: "m" }));
  assert.equal((await put({ enabled: "yes" })).status, 400);
  assert.equal((await put({})).status, 400);
  assert.equal((await put({ reserveTokens: 1000 })).status, 400);
  assert.equal((await put({ provider: "p", modelId: "m", reserveTokens: 1.5 })).status, 400);
  assert.equal((await put({ provider: "p", modelId: "m", reserveTokens: -1 })).status, 400);
  assert.equal((await put("{")).status, 400);
  assert.equal((await put({ enabled: true }, { host: "localhost", "Content-Type": "text/plain" })).status, 415);
  assert.equal((await put({ enabled: true }, { host: "localhost", origin: "https://evil.example", "Content-Type": "application/json" })).status, 403);
  assert.deepEqual(await settings(), { defaultModel: "m" });
});
