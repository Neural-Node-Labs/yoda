import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { commandExists, detectLanguage } from "./language";

let cachedTs: any = null;
let triedLoadingTs = false;

function loadTypeScript(): any | null {
  if (triedLoadingTs) return cachedTs;
  triedLoadingTs = true;
  const candidates = [path.join(__dirname, "..", "..", "node_modules", "typescript"), "typescript"];
  for (const candidate of candidates) {
    try {
      cachedTs = require(candidate);
      return cachedTs;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function checkTypeScriptSyntax(filePath: string, content: string): string {
  const ts = loadTypeScript();
  if (!ts) {
    return "Syntax validation skipped: the 'typescript' package isn't available. Run 'npm install -D typescript' in this project.";
  }

  const isJsx = /\.(jsx|tsx)$/i.test(filePath);
  const compilerOptions: any = {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    allowJs: true,
    checkJs: false,
    noEmit: true,
  };
  if (isJsx) compilerOptions.jsx = ts.JsxEmit.React;

  const result = ts.transpileModule(content, { compilerOptions, fileName: filePath, reportDiagnostics: true });
  const diagnostics = (result.diagnostics ?? []).filter((d: any) => d.category === ts.DiagnosticCategory.Error);
  if (diagnostics.length === 0) return `Syntax valid for ${filePath}`;

  const messages = diagnostics.slice(0, 10).map((d: any) => {
    const text = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.file && d.start !== undefined) {
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
      return `Line ${line + 1}, Col ${character + 1}: ${text}`;
    }
    return text;
  });
  return `SyntaxError in ${filePath}:\n` + messages.join("\n");
}

/**
 * Best-effort syntax validation across several languages. Prefers zero-
 * dependency, syntax-only checks and falls back to shelling out to the
 * language's own compiler/linter in "syntax only" mode where available.
 */
export function toolValidateSyntax(filePath: string): string {
  if (!fs.existsSync(filePath)) return `Error: ${filePath} not found.`;
  const lang = detectLanguage(filePath);

  const readSource = (): string | null => {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  };

  switch (lang) {
    case "python": {
      const result = spawnSync(
        "python3",
        [
          "-c",
          `import ast,sys; ast.parse(open(${JSON.stringify(filePath)}, encoding="utf-8").read(), filename=${JSON.stringify(
            filePath
          )})`,
        ],
        { encoding: "utf-8" }
      );
      return result.status === 0 ? `Syntax valid for ${filePath}` : `SyntaxError in ${filePath}: ${(result.stderr || "").trim()}`;
    }
    case "javascript": {
      if (/\.jsx$/i.test(filePath)) {
        const src = readSource();
        return src === null ? `Error reading ${filePath}` : checkTypeScriptSyntax(filePath, src);
      }
      const result = spawnSync(process.execPath, ["--check", filePath], { encoding: "utf-8" });
      return result.status === 0
        ? `Syntax valid for ${filePath}`
        : `SyntaxError in ${filePath}:\n${(result.stderr || "").trim()}`;
    }
    case "typescript": {
      const src = readSource();
      return src === null ? `Error reading ${filePath}` : checkTypeScriptSyntax(filePath, src);
    }
    case "json": {
      const src = readSource();
      if (src === null) return `Error reading ${filePath}`;
      try {
        JSON.parse(src);
        return `Syntax valid for ${filePath}`;
      } catch (e: any) {
        return `SyntaxError in ${filePath}: ${e.message ?? e}`;
      }
    }
    case "go": {
      if (!commandExists("gofmt")) return "Syntax validation skipped: 'gofmt' not found on PATH (install the Go toolchain).";
      const result = spawnSync("gofmt", ["-e", filePath], { encoding: "utf-8" });
      return result.status === 0
        ? `Syntax valid for ${filePath}`
        : `SyntaxError in ${filePath}:\n${(result.stderr || result.stdout || "").trim()}`;
    }
    case "rust": {
      if (!commandExists("rustc")) return "Syntax validation skipped: 'rustc' not found on PATH (install the Rust toolchain).";
      const result = spawnSync(
        "rustc",
        ["--edition", "2021", "--crate-type", "lib", "--emit=metadata", "-o", path.join(os.tmpdir(), "yoda-rustc-check"), filePath],
        { encoding: "utf-8" }
      );
      return result.status === 0
        ? `Syntax valid for ${filePath}`
        : `SyntaxError/compile error in ${filePath}:\n${(result.stderr || "").trim().slice(0, 2000)}`;
    }
    case "java": {
      if (!commandExists("javac")) return "Syntax validation skipped: 'javac' not found on PATH (install a JDK).";
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoda-javac-"));
      const result = spawnSync("javac", ["-d", tmpDir, filePath], { encoding: "utf-8" });
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return result.status === 0
        ? `Syntax valid for ${filePath}`
        : `SyntaxError/compile error in ${filePath}:\n${(result.stderr || "").trim().slice(0, 2000)}`;
    }
    case "c": {
      const compiler = commandExists("gcc") ? "gcc" : commandExists("clang") ? "clang" : null;
      if (!compiler) return "Syntax validation skipped: neither 'gcc' nor 'clang' found on PATH.";
      const result = spawnSync(compiler, ["-fsyntax-only", filePath], { encoding: "utf-8" });
      return result.status === 0
        ? `Syntax valid for ${filePath}`
        : `SyntaxError in ${filePath}:\n${(result.stderr || "").trim()}`;
    }
    case "cpp": {
      const compiler = commandExists("g++") ? "g++" : commandExists("clang++") ? "clang++" : null;
      if (!compiler) return "Syntax validation skipped: neither 'g++' nor 'clang++' found on PATH.";
      const result = spawnSync(compiler, ["-fsyntax-only", filePath], { encoding: "utf-8" });
      return result.status === 0
        ? `Syntax valid for ${filePath}`
        : `SyntaxError in ${filePath}:\n${(result.stderr || "").trim()}`;
    }
    case "ruby": {
      if (!commandExists("ruby")) return "Syntax validation skipped: 'ruby' not found on PATH.";
      const result = spawnSync("ruby", ["-c", filePath], { encoding: "utf-8" });
      return result.status === 0
        ? `Syntax valid for ${filePath}`
        : `SyntaxError in ${filePath}:\n${(result.stderr || result.stdout || "").trim()}`;
    }
    case "php": {
      if (!commandExists("php")) return "Syntax validation skipped: 'php' not found on PATH.";
      const result = spawnSync("php", ["-l", filePath], { encoding: "utf-8" });
      return result.status === 0
        ? `Syntax valid for ${filePath}`
        : `SyntaxError in ${filePath}:\n${(result.stdout || result.stderr || "").trim()}`;
    }
    case "shell": {
      const shell = commandExists("bash") ? "bash" : "sh";
      const result = spawnSync(shell, ["-n", filePath], { encoding: "utf-8" });
      return result.status === 0
        ? `Syntax valid for ${filePath}`
        : `SyntaxError in ${filePath}:\n${(result.stderr || "").trim()}`;
    }
    default:
      return `Syntax validation skipped: no checker configured for '${path.extname(filePath) || "this file type"}'.`;
  }
}
