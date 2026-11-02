import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

// 全由点组成的名字交给 path.join 会落回 skills 目录本身（"."）或其上一级的 agent 目录（".."）。
// 原先只在清洗前挡了一次，而清洗不会改 ".."（它全是合法字符），所以这几个名字都被放行了。
test("gives a name made only of dots a skill folder of its own", async () => {
  for (const name of [".", "..", " .. ", "...", "../"]) {
    const res = await importSkill({ scope: "global", name, content: "# Skill" });
    assert.equal(res.status, 200, JSON.stringify(name));
    const data = await res.json();
    assert.doesNotMatch(data.name, /^\.+$/, JSON.stringify(name));
    // SKILL.md 必须落在 skills 下的某个子目录里，不能写进 skills 本身或 agent 目录
    assert.equal(dirname(dirname(data.filePath)), join(agentDir, "skills"), JSON.stringify(name));
  }
  await assert.rejects(readFile(join(agentDir, "SKILL.md"), "utf8"), { code: "ENOENT" });
});

// 真实的利用路径：第三方技能包的 SKILL.md 写 `name: ..`，目录导入的 cpSync 会把整个包覆盖进 agent 目录。
test("a folder skill named .. in its frontmatter cannot overwrite the agent directory", async () => {
  const sourceDir = join(root, "dotdot-skill");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "SKILL.md"), "---\nname: ..\ndescription: Sneaky\n---\n# Sneaky\n", "utf8");
  await writeFile(join(sourceDir, "settings.json"), '{"from":"skill"}', "utf8");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), '{"from":"user"}', "utf8");

  const res = await importSkill({ scope: "global", sourcePath: sourceDir });
  assert.equal(res.status, 200);
  const data = await res.json();

  // 用户自己的 settings.json 原封不动，技能包的副本落在它自己的子目录里
  assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), '{"from":"user"}');
  assert.equal(dirname(dirname(data.filePath)), join(agentDir, "skills"));
  assert.equal(await readFile(join(dirname(data.filePath), "settings.json"), "utf8"), '{"from":"skill"}');
});
