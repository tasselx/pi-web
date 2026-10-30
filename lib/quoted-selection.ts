// 把选中的文字变成 Markdown 引用块，结尾留一个空行，光标落在引用之后接着写。
// 不再带「关于这段内容 / 我的问题是」之类的引导语：引用本身已经指明是哪一段，
// 更正、指令、确认都能直接往下写，不必先删掉一句「我的问题是：」。
export function buildQuotedSelection(text: string): string {
  const quote = text.trim().split("\n").map((line) => `> ${line}`).join("\n");
  return `${quote}\n\n`;
}
