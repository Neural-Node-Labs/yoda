import * as path from "path";
import { spawnSync } from "child_process";

export type SourceLanguage =
  | "python"
  | "javascript"
  | "typescript"
  | "go"
  | "rust"
  | "java"
  | "c"
  | "cpp"
  | "ruby"
  | "php"
  | "shell"
  | "json"
  | "unknown";

export function detectLanguage(filePath: string): SourceLanguage {
  switch (path.extname(filePath).toLowerCase()) {
    case ".py":
      return "python";
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".jsx":
      return "javascript";
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".java":
      return "java";
    case ".c":
    case ".h":
      return "c";
    case ".cpp":
    case ".cc":
    case ".cxx":
    case ".hpp":
    case ".hh":
      return "cpp";
    case ".rb":
      return "ruby";
    case ".php":
      return "php";
    case ".sh":
    case ".bash":
      return "shell";
    case ".json":
      return "json";
    default:
      return "unknown";
  }
}

export function commandExists(cmd: string): boolean {
  const finder = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(finder, [cmd], { encoding: "utf-8" });
  return result.status === 0;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
