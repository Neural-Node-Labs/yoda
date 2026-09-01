import { SearchProvider } from "../types";
import {
  toolApplyUnifiedDiff,
  toolAwkTransform,
  toolGetDependencyGraph,
  toolLinePatch,
  toolReadFileRange,
  toolReadFullFile,
  toolReadMultipleFiles,
  toolReadOutline,
  toolRenameSymbol,
  toolSearchAst,
  toolSearchCode,
  toolSearchReplaceBlock,
  toolSedReplace,
  toolSedReplaceMulti,
  toolUpdateFunction,
  toolWriteFile,
} from "./fileTools";
import { toolExecuteShellCommand, toolFindFiles, toolGitDiff, toolGitLog, toolListDirectory } from "./shellTools";
import { toolValidateSyntax } from "./validate";
import { toolWebFetch, toolWebSearch } from "../search/providers";

export type ToolFn = (...args: any[]) => string | Promise<string>;

/** Builds the tool router. web_search is bound to whichever search provider this run is using. */
export function buildToolMap(searchProvider: SearchProvider): Record<string, ToolFn> {
  return {
    execute_shell_command: ({ command }: any) => toolExecuteShellCommand(command),
    list_directory: ({ path = ".", depth = 2 }: any) => toolListDirectory(path, depth),
    find_files: ({ pattern }: any) => toolFindFiles(pattern),
    get_dependency_graph: ({ path }: any) => toolGetDependencyGraph(path),
    search_code: ({ pattern, context_lines = 2 }: any) => toolSearchCode(pattern, context_lines),
    search_ast: ({ path, node_type }: any) => toolSearchAst(path, node_type),
    read_outline: ({ path }: any) => toolReadOutline(path),
    read_file_range: ({ path, start, end }: any) => toolReadFileRange(path, start, end),
    read_multiple_files: ({ requests }: any) => toolReadMultipleFiles(requests),
    read_full_file: ({ path }: any) => toolReadFullFile(path),
    git_diff: ({ ref = "HEAD~1" }: any) => toolGitDiff(ref),
    git_log: ({ path = "", max_count = 5 }: any) => toolGitLog(path, max_count),
    sed_replace: ({ path, pattern, replacement }: any) => toolSedReplace(path, pattern, replacement),
    sed_replace_multi: ({ glob_pattern, pattern, replacement }: any) =>
      toolSedReplaceMulti(glob_pattern, pattern, replacement),
    search_replace_block: ({ path, search_block, replace_block }: any) =>
      toolSearchReplaceBlock(path, search_block, replace_block),
    apply_unified_diff: ({ path, diff }: any) => toolApplyUnifiedDiff(path, diff),
    line_patch: ({ path, start_line, end_line, new_code }: any) => toolLinePatch(path, start_line, end_line, new_code),
    update_function: ({ path, function_name, new_code }: any) => toolUpdateFunction(path, function_name, new_code),
    awk_transform: ({ path, program }: any) => toolAwkTransform(path, program),
    rename_symbol: ({ old_name, new_name }: any) => toolRenameSymbol(old_name, new_name),
    write_file: ({ path, content }: any) => toolWriteFile(path, content),
    validate_syntax: ({ path }: any) => toolValidateSyntax(path),
    web_search: ({ query, max_results = 5 }: any) => toolWebSearch(searchProvider, { query, max_results }),
    web_fetch: ({ url, max_chars = 6000 }: any) => toolWebFetch({ url, max_chars }),
  };
}

// Tools that count as "grounding" — actually observing real file content
// before writing/editing/documenting anything about it.
export const GROUNDING_TOOLS = new Set<string>([
  "read_outline",
  "read_file_range",
  "read_multiple_files",
  "read_full_file",
  "search_code",
  "search_ast",
  "get_dependency_graph",
]);

// Tools that mutate or produce content about files and therefore require at
// least one grounding tool call earlier in the same session. This is what
// stops a model from hallucinating a write_file/edit call for a file it
// never actually looked at.
export const TOOLS_REQUIRING_GROUNDING = new Set<string>([
  "write_file",
  "sed_replace",
  "sed_replace_multi",
  "search_replace_block",
  "apply_unified_diff",
  "line_patch",
  "update_function",
  "awk_transform",
  "rename_symbol",
]);
