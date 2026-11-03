export interface HotkeyItem {
  keys: string;
  descriptionKey: string;
}

export interface HotkeySection {
  id: "composer" | "navigation" | "sessionMenu";
  titleKey: string;
  items: HotkeyItem[];
}

export interface BuildHotkeySectionsOptions {
  enterSendMode?: "enter" | "ctrlEnter";
}

export function buildHotkeySections(options: BuildHotkeySectionsOptions = {}): HotkeySection[] {
  const ctrlEnterMode = options.enterSendMode === "ctrlEnter";
  const sendKey = ctrlEnterMode ? "Ctrl/Cmd+Enter" : "Enter";
  const newLineKey = ctrlEnterMode ? "Enter / Shift+Enter" : "Shift+Enter";
  const followUpKey = ctrlEnterMode ? "Ctrl/Cmd+Alt+Enter" : "Alt+Enter";

  return [
    {
      id: "composer",
      titleKey: "hotkeys.groupComposer",
      items: [
        { keys: sendKey, descriptionKey: "hotkeys.sendMessage" },
        { keys: newLineKey, descriptionKey: "hotkeys.newLine" },
        { keys: sendKey, descriptionKey: "hotkeys.steerMessage" },
        { keys: followUpKey, descriptionKey: "hotkeys.followUpMessage" },
        { keys: "↑ / ↓", descriptionKey: "hotkeys.inputHistory" },
        { keys: "Tab / Enter", descriptionKey: "hotkeys.acceptCompletion" },
        { keys: "/", descriptionKey: "hotkeys.slashCommands" },
        { keys: "@", descriptionKey: "hotkeys.mentionFile" },
        { keys: "! / !!", descriptionKey: "hotkeys.bashCommand" },
      ],
    },
    {
      id: "navigation",
      titleKey: "hotkeys.groupNavigation",
      items: [
        { keys: "Esc", descriptionKey: "hotkeys.escape" },
        { keys: "Ctrl+Alt+N", descriptionKey: "hotkeys.newSession" },
        { keys: "Alt+Click", descriptionKey: "hotkeys.toggleAllGroups" },
      ],
    },
    {
      id: "sessionMenu",
      titleKey: "hotkeys.groupSessionMenu",
      items: [
        { keys: "P", descriptionKey: "hotkeys.menuPin" },
        { keys: "A", descriptionKey: "hotkeys.menuArchive" },
        { keys: "R", descriptionKey: "hotkeys.menuRename" },
        { keys: "G", descriptionKey: "hotkeys.menuGenerateTitle" },
        { keys: "F", descriptionKey: "hotkeys.menuFork" },
        { keys: "S", descriptionKey: "hotkeys.menuShare" },
        { keys: "E", descriptionKey: "hotkeys.menuExport" },
        { keys: "T", descriptionKey: "hotkeys.menuOpenNewTab" },
        { keys: "D / Shift+D", descriptionKey: "hotkeys.menuDelete" },
      ],
    },
  ];
}
