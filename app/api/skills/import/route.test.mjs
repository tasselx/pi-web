import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-web-skills-import-"));
const agentDir = join(root, "agent");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { POST } = await jiti.import("./route.ts");

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});

function importSkill(body) {
  return POST(new Request("http://localhost/api/skills/import", {
    method: "POST",
    headers: {
      host: "localhost",
      "content-type": "application/json",
      origin: "http://localhost",
    },
    body: JSON.stringify(body),
  }));
}

test("refuses missing content and missing sourcePath", async () => {
  const res = await importSkill({ scope: "global" });
  assert.equal(res.status, 400);
});

test("imports a skill from raw content to global scope", async () => {
  const res = await importSkill({
    scope: "global",
    name: "test-content-skill",
    content: "---\nname: test-content-skill\ndescription: Test skill\n---\n# Test\n",
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.name, "test-content-skill");
  const written = await readFile(data.filePath, "utf8");
  assert.match(written, /test-content-skill/);
});

test("imports a skill from a source directory", async () => {
  const sourceDir = join(root, "my-local-skill");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(
    join(sourceDir, "SKILL.md"),
    "---\nname: dir-skill\ndescription: From dir\n---\n# Dir Skill\n",
    "utf8",
  );
  await writeFile(join(sourceDir, "extra.txt"), "extra data", "utf8");

  const res = await importSkill({
    scope: "global",
    sourcePath: sourceDir,
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.name, "dir-skill");
  const extraWritten = await readFile(join(agentDir, "skills", "dir-skill", "extra.txt"), "utf8");
  assert.equal(extraWritten, "extra data");
});

test("sanitizes potentially malicious names", async () => {
  const res = await importSkill({
    scope: "global",
    name: "../../etc/passwd",
    content: "# Skill",
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.ok(!data.filePath.includes("etc/passwd"));
  assert.ok(data.filePath.startsWith(agentDir));
});
