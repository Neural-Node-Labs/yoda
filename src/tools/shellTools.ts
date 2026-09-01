import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { glob } from "glob";
import { escapeRegExp } from "./language";

export function toolExecuteShellCommand(command: string): string {
  try {
    const result = spawnSync(command, { shell: true, encoding: "utf-8", timeout: 30_000 });
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return "Error: Command execution timed out after 30 seconds.";
    }
    const output = result.status === 0 ? result.stdout : result.stderr;
    return output ? output.slice(0, 3000) : "Command executed with no output.";
  } catch (e: any) {
    return `Execution error: ${e.message ?? e}`;
  }
}

export function toolListDirectory(dirPath: string = ".", depth: number = 2): string {
  const res: string[] = [];
  const sep = path.sep;
  const baseDepth = dirPath.replace(new RegExp(`${escapeRegExp(sep)}+$`), "").split(sep).length - 1;

  function walk(root: string) {
    const curDepth = root.split(sep).length - 1 - baseDepth;
    if (curDepth >= depth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }

    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "__pycache__")
      .map((e) => e.name);
    const files = entries.filter((e) => e.isFile() && !e.name.startsWith(".")).map((e) => e.name);

    const indent = "  ".repeat(curDepth);
    res.push(`${indent}${path.basename(root)}/`);
    for (const f of files) res.push(`${indent}  ${f}`);
    for (const d of dirs) walk(path.join(root, d));
  }

  walk(dirPath);
  return res.slice(0, 100).join("\n") || "Empty directory.";
}

export async function toolFindFiles(pattern: string): Promise<string> {
  const matches = await glob(`**/${pattern}`, { nodir: false });
  return matches.length > 0 ? matches.slice(0, 50).join("\n") : `No files found matching ${pattern}`;
}

export function toolGitDiff(ref: string = "HEAD~1"): string {
  const result = spawnSync("git", ["diff", ref], { encoding: "utf-8" });
  const out = result.stdout;
  return out ? out.slice(0, 3000) : "No changes.";
}

export function toolGitLog(filePath: string = "", maxCount: number = 5): string {
  const cmd = ["log", `-n${maxCount}`, "--oneline"];
  if (filePath) cmd.push(filePath);
  const result = spawnSync("git", cmd, { encoding: "utf-8" });
  return result.stdout || "No git log history.";
}
