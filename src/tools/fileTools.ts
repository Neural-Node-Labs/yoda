import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { glob } from "glob";
import { detectLanguage, escapeRegExp } from "./language";

// ---- Read tools ----------------------------------------------------------

export function toolReadOutline(filePath: string): string {
  if (!fs.existsSync(filePath)) return `Error: ${filePath} not found.`;
  try {
    const lines = fs.readFileSync(filePath, "utf-8").split("\n");
    const outline: string[] = [];
    lines.forEach((l, i) => {
      if (/^\s*(def|class|import|from)\b/.test(l)) {
        outline.push(`${String(i + 1).padStart(4)}: ${l.replace(/\s+$/, "")}`);
      }
    });
    return outline.length > 0 ? outline.join("\n") : `No top-level structures found in ${filePath}.`;
  } catch (e: any) {
    return `Error reading outline: ${e.message ?? e}`;
  }
}

export function toolReadFileRange(filePath: string, start: number, end: number): string {
  if (!fs.existsSync(filePath)) return `Error: ${filePath} not found.`;
  try {
    const startClamped = Math.max(1, start);
    const lines = fs.readFileSync(filePath, "utf-8").split(/(?<=\n)/);
    const selected = lines.slice(startClamped - 1, end);
    const output = selected.map((l, i) => `${String(i + startClamped).padStart(4)} | ${l.replace(/\s+$/, "")}`);
    return output.join("\n");
  } catch (e: any) {
    return `Error: ${e.message ?? e}`;
  }
}

interface ReadRequest {
  path: string;
  start?: number;
  end?: number;
}

export function toolReadMultipleFiles(requests: ReadRequest[]): string {
  const outputs: string[] = [];
  for (const req of requests) {
    const st = req.start ?? 1;
    const ed = req.end ?? 100;
    outputs.push(`--- ${req.path} (lines ${st}-${ed}) ---\n` + toolReadFileRange(req.path, st, ed));
  }
  return outputs.join("\n\n");
}

export function toolReadFullFile(filePath: string): string {
  if (!fs.existsSync(filePath)) return `Error: ${filePath} not found.`;
  const lines = fs.readFileSync(filePath, "utf-8").split(/(?<=\n)/);
  if (lines.length > 500) {
    return `Refused: File exceeds 500 lines (${lines.length} lines). Use read_file_range or read_outline.`;
  }
  return lines.join("");
}

// ---- Search tools ----------------------------------------------------------

export function toolSearchCode(pattern: string, contextLines: number = 2): string {
  try {
    const result = spawnSync("rg", ["-n", "-C", String(contextLines), pattern], {
      encoding: "utf-8",
      timeout: 5000,
    });
    // spawnSync does NOT throw when the binary is simply missing (e.g. `rg`
    // not installed/on PATH, common on Windows) — it returns normally with
    // `error` set and empty stdout. Explicitly detect that and fall back to
    // the manual JS search below instead of silently reporting no matches.
    if (result.error) {
      throw result.error;
    }
    const out = result.stdout;
    return out ? out.slice(0, 3000) : "No matches found.";
  } catch {
    const matches: string[] = [];
    let rx: RegExp;
    try {
      rx = new RegExp(pattern);
    } catch {
      return "No matches found.";
    }
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(p);
        } else if (e.isFile()) {
          try {
            const lines = fs.readFileSync(p, "utf-8").split("\n");
            lines.forEach((line, i) => {
              if (rx.test(line)) {
                matches.push(`${p}:${i + 1}:${line.trim()}`);
              }
            });
          } catch {
            // ignore unreadable files
          }
        }
      }
    };
    walk(".");
    return matches.slice(0, 30).join("\n") || "No matches found.";
  }
}

/** Heuristic regex-based "AST" search covering Python and JavaScript/TypeScript. */
export function toolSearchAst(filePath: string, nodeType: string): string {
  if (!fs.existsSync(filePath)) return `Error: File ${filePath} not found.`;
  const lang = detectLanguage(filePath);

  try {
    const lines = fs.readFileSync(filePath, "utf-8").split("\n");
    const results: string[] = [];

    if (lang === "python") {
      lines.forEach((line, idx) => {
        const lineNo = idx + 1;
        let m: RegExpMatchArray | null;
        switch (nodeType) {
          case "FunctionDef":
            m = line.match(/^\s*def\s+([A-Za-z_]\w*)\s*\(/);
            if (m) results.push(`Line ${lineNo}: FunctionDef -> ${m[1]}`);
            break;
          case "ClassDef":
            m = line.match(/^\s*class\s+([A-Za-z_]\w*)/);
            if (m) results.push(`Line ${lineNo}: ClassDef -> ${m[1]}`);
            break;
          case "Import":
            if (/^\s*(import|from)\s+/.test(line)) {
              m = line.match(/^\s*import\s+(\S+)/) || line.match(/^\s*from\s+(\S+)/);
              results.push(`Line ${lineNo}: Import -> ${m ? m[1] : "unnamed"}`);
            }
            break;
          case "Call":
            for (const cm of line.matchAll(/([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g)) {
              const name = cm[1];
              if (["def", "class", "if", "for", "while", "with", "except", "elif"].includes(name)) continue;
              results.push(`Line ${lineNo}: Call -> ${name}`);
            }
            break;
        }
      });
    } else if (lang === "javascript" || lang === "typescript") {
      lines.forEach((line, idx) => {
        const lineNo = idx + 1;
        let m: RegExpMatchArray | null;
        switch (nodeType) {
          case "FunctionDef":
            m =
              line.match(/\bfunction\s*\*?\s+([A-Za-z_$][\w$]*)\s*\(/) ||
              line.match(
                /\b(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=>/
              ) ||
              line.match(/^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/);
            if (m && !["if", "for", "while", "switch", "catch", "function"].includes(m[1])) {
              results.push(`Line ${lineNo}: FunctionDef -> ${m[1]}`);
            }
            break;
          case "ClassDef":
            m = line.match(/\bclass\s+([A-Za-z_$][\w$]*)/);
            if (m) results.push(`Line ${lineNo}: ClassDef -> ${m[1]}`);
            break;
          case "Import":
            if (/^\s*import\b/.test(line) || /\brequire\(/.test(line)) {
              m = line.match(/from\s+["']([^"']+)["']/) || line.match(/require\(\s*["']([^"']+)["']\s*\)/);
              results.push(`Line ${lineNo}: Import -> ${m ? m[1] : line.trim()}`);
            }
            break;
          case "Call":
            for (const cm of line.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)) {
              const name = cm[1];
              if (["function", "if", "for", "while", "switch", "catch"].includes(name)) continue;
              results.push(`Line ${lineNo}: Call -> ${name}`);
            }
            break;
        }
      });
    } else {
      return `search_ast is only implemented for Python and JavaScript/TypeScript in this lightweight agent (got ${
        path.extname(filePath) || "unknown extension"
      }).`;
    }

    return results.join("\n") || `No nodes of type ${nodeType} found.`;
  } catch (e: any) {
    return `AST Error: ${e.message ?? e}`;
  }
}

export function toolGetDependencyGraph(filePath: string): string {
  if (!fs.existsSync(filePath)) return `Error: ${filePath} not found.`;
  const lang = detectLanguage(filePath);
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (e: any) {
    return `Error reading ${filePath}: ${e.message ?? e}`;
  }

  try {
    if (lang === "python") {
      const imports = new Set<string>();
      for (const m of content.matchAll(/^\s*import\s+([^\n#]+)/gm)) {
        for (const part of m[1].split(",")) {
          const name = part.trim().split(/\s+as\s+/)[0].trim();
          if (name) imports.add(name);
        }
      }
      for (const m of content.matchAll(/^\s*from\s+(\S+)\s+import\b/gm)) imports.add(m[1].trim());
      return `Imports in ${filePath}: ` + (imports.size ? Array.from(imports).join(", ") : "(none found)");
    }
    if (lang === "javascript" || lang === "typescript") {
      const imports = new Set<string>();
      for (const m of content.matchAll(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gm)) imports.add(m[1]);
      for (const m of content.matchAll(/(?:^|[^.\w])require\(\s*["']([^"']+)["']\s*\)/g)) imports.add(m[1]);
      for (const m of content.matchAll(/^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/gm)) imports.add(m[1]);
      return `Imports in ${filePath}: ` + (imports.size ? Array.from(imports).join(", ") : "(none found)");
    }
    if (lang === "go") {
      const imports = new Set<string>();
      const block = content.match(/import\s*\(([\s\S]*?)\)/);
      if (block) for (const m of block[1].matchAll(/"([^"]+)"/g)) imports.add(m[1]);
      for (const m of content.matchAll(/^\s*import\s+"([^"]+)"/gm)) imports.add(m[1]);
      return `Imports in ${filePath}: ` + (imports.size ? Array.from(imports).join(", ") : "(none found)");
    }
    if (lang === "rust") {
      const imports = new Set<string>();
      for (const m of content.matchAll(/^\s*use\s+([\w:{}, *]+);/gm)) imports.add(m[1].trim());
      return `Imports in ${filePath}: ` + (imports.size ? Array.from(imports).join(", ") : "(none found)");
    }
    if (lang === "java") {
      const imports = new Set<string>();
      for (const m of content.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?);/gm)) imports.add(m[1]);
      return `Imports in ${filePath}: ` + (imports.size ? Array.from(imports).join(", ") : "(none found)");
    }
    if (lang === "c" || lang === "cpp") {
      const imports = new Set<string>();
      for (const m of content.matchAll(/^\s*#include\s*[<"]([^>"]+)[>"]/gm)) imports.add(m[1]);
      return `Includes in ${filePath}: ` + (imports.size ? Array.from(imports).join(", ") : "(none found)");
    }
    if (lang === "ruby") {
      const imports = new Set<string>();
      for (const m of content.matchAll(/^\s*require(?:_relative)?\s+["']([^"']+)["']/gm)) imports.add(m[1]);
      return `Requires in ${filePath}: ` + (imports.size ? Array.from(imports).join(", ") : "(none found)");
    }
    if (lang === "php") {
      const imports = new Set<string>();
      for (const m of content.matchAll(/^\s*use\s+([\w\\]+)/gm)) imports.add(m[1]);
      for (const m of content.matchAll(/\b(?:require|include)(?:_once)?\s*\(?\s*["']([^"']+)["']/gm)) imports.add(m[1]);
      return `Imports in ${filePath}: ` + (imports.size ? Array.from(imports).join(", ") : "(none found)");
    }
    return `Dependency graph not implemented for this file type (${path.extname(filePath) || "unknown"}).`;
  } catch (e: any) {
    return `Error parsing imports: ${e.message ?? e}`;
  }
}

// ---- Write / patch tools ----------------------------------------------------------

// Extensions treated as prose/documentation rather than code. Full
// (re)writes of these are low-risk — there's no existing logic that can be
// silently clobbered — so they get a much higher line ceiling than code.
const DOC_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".rst", ".adoc"]);
const DOC_WRITE_LINE_LIMIT = 4000;
const CODE_WRITE_LINE_LIMIT = 200;

export function toolWriteFile(filePath: string, content: string): string {
  const lines = content.split("\n");
  const isDoc = DOC_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  const limit = isDoc ? DOC_WRITE_LINE_LIMIT : CODE_WRITE_LINE_LIMIT;

  if (lines.length > limit) {
    return isDoc
      ? `Refused: Content is ${lines.length} lines (exceeds the ${limit}-line documentation limit). Split it into multiple files or shorten it.`
      : `Refused: Content is ${lines.length} lines (exceeds the ${limit}-line limit for code files, which write_file caps low to force surgical edits instead of full regeneration). Use line_patch or search_replace_block.`;
  }
  fs.writeFileSync(filePath, content, "utf-8");
  return `File written successfully to ${filePath} (${lines.length} lines).`;
}

export function toolSedReplace(filePath: string, pattern: string, replacement: string): string {
  if (!fs.existsSync(filePath)) return `Error: ${filePath} not found.`;
  const content = fs.readFileSync(filePath, "utf-8");
  const rx = new RegExp(pattern, "g");
  let count = 0;
  const newContent = content.replace(rx, (...args) => {
    count += 1;
    return substitutePythonBackrefs(replacement, args);
  });
  fs.writeFileSync(filePath, newContent, "utf-8");
  return `Replaced ${count} occurrence(s) in ${filePath}.`;
}

function substitutePythonBackrefs(replacement: string, matchArgs: any[]): string {
  return replacement.replace(/\\(\d+)/g, (_, num) => {
    const idx = parseInt(num, 10);
    return matchArgs[idx] ?? "";
  });
}

export async function toolSedReplaceMulti(globPattern: string, pattern: string, replacement: string): Promise<string> {
  const files = await glob(`**/${globPattern}`, { nodir: true });
  let modified = 0;
  for (const p of files) {
    if (fs.statSync(p).isFile()) {
      const res = toolSedReplace(p, pattern, replacement);
      if (!res.startsWith("Replaced 0")) modified += 1;
    }
  }
  return `Updated ${modified} file(s).`;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count += 1;
    pos = idx + needle.length;
  }
  return count;
}

export function toolSearchReplaceBlock(filePath: string, searchBlock: string, replaceBlock: string): string {
  if (!fs.existsSync(filePath)) return `Error: ${filePath} not found.`;
  const content = fs.readFileSync(filePath, "utf-8");

  const normContent = content.replace(/\r\n/g, "\n");
  const normSearch = searchBlock.replace(/\r\n/g, "\n");
  const normReplace = replaceBlock.replace(/\r\n/g, "\n");

  const matches = countOccurrences(normContent, normSearch);
  if (matches === 0) return "Error: search_block not found. Must match target file exactly.";
  if (matches > 1) return `Error: search_block matched ${matches} times. Match must be unique.`;

  const newContent = normContent.replace(normSearch, normReplace);
  fs.writeFileSync(filePath, newContent, "utf-8");
  return `Successfully applied block replacement in ${filePath}.`;
}

export function toolApplyUnifiedDiff(filePath: string, diff: string): string {
  try {
    const result = spawnSync("patch", [filePath], { input: diff, encoding: "utf-8" });
    return result.status === 0 ? result.stdout : `Patch Failed: ${result.stderr}`;
  } catch (e: any) {
    return `Execution error: ${e.message ?? e}`;
  }
}

export function toolLinePatch(filePath: string, startLine: number, endLine: number, newCode: string): string {
  if (!fs.existsSync(filePath)) return `Error: ${filePath} not found.`;
  const lines = fs.readFileSync(filePath, "utf-8").split(/(?<=\n)/);
  const sl = Math.max(0, startLine - 1);
  const el = endLine;

  const cleanCode = newCode.split("\n").map((l) => l.replace(/\r?\n?$/, ""));
  const newLines = cleanCode.map((l) => l + "\n");

  lines.splice(sl, el - sl, ...newLines);
  fs.writeFileSync(filePath, lines.join(""), "utf-8");
  return `Patched lines ${startLine}-${endLine} in ${filePath}.`;
}

function findPythonFunctionRange(content: string, functionName: string): { start: number; end: number } | null {
  const lines = content.split("\n");
  const defRegex = new RegExp(`^(\\s*)def\\s+${escapeRegExp(functionName)}\\s*\\(`);

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(defRegex);
    if (!m) continue;

    const defIndent = m[1].length;
    let end = i + 1;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "") {
        end = j + 1;
        continue;
      }
      const indentMatch = line.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1].length : 0;
      if (indent <= defIndent) break;
      end = j + 1;
    }
    return { start: i + 1, end };
  }
  return null;
}

function findBraceFunctionRange(content: string, functionName: string): { start: number; end: number } | null {
  const lines = content.split("\n");
  const name = escapeRegExp(functionName);
  const declRegex = new RegExp(
    `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:` +
      `function\\s*\\*?\\s+${name}\\s*\\(|` +
      `(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*(?::\\s*[^=]+)?=>|` +
      `(?:public\\s+|private\\s+|protected\\s+|static\\s+)*${name}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{` +
      `)`
  );

  for (let i = 0; i < lines.length; i++) {
    if (!declRegex.test(lines[i])) continue;

    let braceLine = i;
    let braceCol = lines[braceLine].indexOf("{");
    while (braceCol === -1 && braceLine < lines.length - 1) {
      braceLine += 1;
      braceCol = lines[braceLine].indexOf("{");
    }
    if (braceCol === -1) continue;

    let depth = 0;
    for (let ln = braceLine; ln < lines.length; ln++) {
      const startCol = ln === braceLine ? braceCol : 0;
      for (let c = startCol; c < lines[ln].length; c++) {
        if (lines[ln][c] === "{") depth += 1;
        else if (lines[ln][c] === "}") {
          depth -= 1;
          if (depth === 0) return { start: i + 1, end: ln + 1 };
        }
      }
    }
    return { start: i + 1, end: lines.length };
  }
  return null;
}

export function toolUpdateFunction(filePath: string, functionName: string, newCode: string): string {
  if (!fs.existsSync(filePath)) return `Error: ${filePath} not found.`;
  const lang = detectLanguage(filePath);

  if (lang === "python") {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const range = findPythonFunctionRange(content, functionName);
      if (!range) return `Error: Function '${functionName}' not found in ${filePath}.`;
      return toolLinePatch(filePath, range.start, range.end, newCode);
    } catch (e: any) {
      return `AST Exception during update_function: ${e.message ?? e}`;
    }
  }

  if (lang === "javascript" || lang === "typescript") {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const range = findBraceFunctionRange(content, functionName);
      if (!range) return `Error: Function '${functionName}' not found in ${filePath}.`;
      return toolLinePatch(filePath, range.start, range.end, newCode);
    } catch (e: any) {
      return `Exception during update_function: ${e.message ?? e}`;
    }
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const range = findBraceFunctionRange(content, functionName);
    if (range) return toolLinePatch(filePath, range.start, range.end, newCode);
  } catch {
    // fall through
  }
  return toolSedReplace(filePath, `function\\s+${escapeRegExp(functionName)}\\s*\\([\\s\\S]*?\\n\\}`, newCode);
}

export function toolAwkTransform(filePath: string, program: string): string {
  const result = spawnSync("awk", [program, filePath], { encoding: "utf-8" });
  const res = result.stdout;
  return res ? res.slice(0, 2000) : "AWK transform completed with empty output.";
}

export async function toolRenameSymbol(oldName: string, newName: string): Promise<string> {
  return toolSedReplaceMulti("*", `\\b${escapeRegExp(oldName)}\\b`, newName);
}
