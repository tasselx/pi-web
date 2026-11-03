// Demo copy: only the type FileExplorer reads. The real module asks git
// (`check-ignore`) on the server which entries the file tree lists.
export type FileTreeHiddenReason = "ignored" | "excluded" | "always";
