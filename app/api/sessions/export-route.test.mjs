import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./[id]/export/route.ts", import.meta.url), "utf8");

test("session export renders in memory, without a shared temp path", () => {
  // Export happens in exportSessionContent(); the route never writes a temp file,
  // so the shared /tmp/pi-web-export directory (upstream #1626) cannot exist here.
  assert.match(source, /exportSessionContent\(/);
  assert.doesNotMatch(source, /join\(tmpdir\(\), "pi-web-export"\)/);
});
