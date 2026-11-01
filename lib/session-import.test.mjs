import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": new URL("..", import.meta.url).pathname.replace(/\/$/, "") },
});

const { parseImportSlashCommand } = await jiti.import("./session-import-args.ts");
const { SessionImportError, importSessionJsonl, parseSessionJsonlText } = await jiti.import(
  "./session-import.ts",
);

test("parseImportSlashCommand handles bare /import, unquoted and quoted paths", () => {
  assert.deepEqual(parseImportSlashCommand("/import"), { kind: "bare" });
  assert.deepEqual(parseImportSlashCommand("  /import   "), { kind: "bare" });
  assert.deepEqual(parseImportSlashCommand("/import /tmp/a.jsonl"), {
    kind: "path",
    path: "/tmp/a.jsonl",
  });
  assert.deepEqual(parseImportSlashCommand('/import "/tmp/my session.jsonl"'), {
    kind: "path",
    path: "/tmp/my session.jsonl",
  });
  assert.deepEqual(parseImportSlashCommand('/import "/tmp/unclosed'), {
    kind: "invalid",
  });
});

test("parseSessionJsonlText validates pi session header", () => {
  const valid = [
    JSON.stringify({ type: "session", version: 3, id: "abc-123", timestamp: "2026-10-31T00:00:00.000Z", cwd: "/tmp" }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "hi" } }),
  ].join("\n");
  const parsed = parseSessionJsonlText(valid);
  assert.equal(parsed.header.id, "abc-123");

  assert.throws(
    () => parseSessionJsonlText("not json at all\n"),
    (err) => err instanceof SessionImportError && err.code === "invalid_session",
  );
});

test("importSessionJsonl imports from content and from server path with fallbackCwd", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-import-test-"));
  const sessionDir = join(tempDir, "sessions");
  const projectDir = join(tempDir, "project");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  try {
    const sampleId = `imported-${Date.now()}`;
    const sampleJsonl = `${[
      JSON.stringify({
        type: "session",
        version: 3,
        id: sampleId,
        timestamp: "2026-10-31T00:00:00.000Z",
        cwd: "/nonexistent/original/path",
      }),
      JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-10-31T00:00:01.000Z",
        message: { role: "user", content: "Imported hello" },
      }),
    ].join("\n")}\n`;

    const uploaded = await importSessionJsonl({
      content: sampleJsonl,
      fileName: "uploaded.jsonl",
      fallbackCwd: projectDir,
      sessionDir,
    });
    assert.equal(uploaded.sessionId, sampleId);
    assert.equal(existsSync(uploaded.path), true);
    assert.equal(uploaded.session.cwd, projectDir);
    assert.equal(uploaded.session.firstMessage, "Imported hello");

    // Importing again assigns a fresh sessionId so it does not collide with the first import.
    const sourceFile = join(tempDir, "external.jsonl");
    writeFileSync(sourceFile, sampleJsonl, "utf8");
    const second = await importSessionJsonl({
      sourcePath: sourceFile,
      fallbackCwd: projectDir,
      sessionDir,
    });
    assert.notEqual(second.sessionId, sampleId);
    const secondHeader = JSON.parse(readFileSync(second.path, "utf8").split("\n")[0]);
    assert.equal(secondHeader.id, second.sessionId);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
