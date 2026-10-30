import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { buildQuotedSelection } = await createJiti(import.meta.url).import("./quoted-selection.ts");

// 引用块之后留一个空行，没有引导语：引用本身已指明是哪一段，接着写什么都行。
test("selected message text becomes a markdown quote followed by a blank line", () => {
  assert.equal(
    buildQuotedSelection(" first line\nsecond line "),
    "> first line\n> second line\n\n",
  );
});
