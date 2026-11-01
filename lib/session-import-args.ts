export type ParsedImportCommand =
  | { kind: "bare" }
  | { kind: "path"; path: string }
  | { kind: "invalid" };

/**
 * Parse `/import` and `/import <path.jsonl>`, matching pi TUI's
 * `getPathCommandArgument(text, "/import")` (`interactive-mode.js`).
 */
export function parseImportSlashCommand(text: string): ParsedImportCommand {
  const trimmed = text.trim();
  if (trimmed === "/import") return { kind: "bare" };
  if (!trimmed.startsWith("/import ")) return { kind: "invalid" };

  const argsString = trimmed.slice("/import".length + 1).trimStart();
  if (!argsString) return { kind: "bare" };

  const firstChar = argsString[0];
  if (firstChar === '"' || firstChar === "'") {
    const closingQuoteIndex = argsString.indexOf(firstChar, 1);
    if (closingQuoteIndex < 0) return { kind: "invalid" };
    const quoted = argsString.slice(1, closingQuoteIndex).trim();
    return quoted ? { kind: "path", path: quoted } : { kind: "invalid" };
  }

  const firstWhitespaceIndex = argsString.search(/\s/);
  const path = firstWhitespaceIndex < 0
    ? argsString
    : argsString.slice(0, firstWhitespaceIndex);
  return path ? { kind: "path", path } : { kind: "invalid" };
}
