export const TOOLS_SCHEMA = [
  {
    type: "function",
    function: {
      name: "execute_shell_command",
      description: "Execute an arbitrary shell/bash command in the system terminal.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The bash command to execute (e.g., 'ls -la', 'python3 script.py')." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "Shallow tree view of directory structure, respecting .gitignore.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", default: "." }, depth: { type: "integer", default: 2 } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_files",
      description: "Locate files matching a glob or name pattern.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string", description: "Glob pattern (e.g. '*.py' or '**/*.md')" } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_dependency_graph",
      description: "Extract imports to show dependencies of a file.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "search_code",
      description: "Regex search across codebase (wraps ripgrep/grep).",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, context_lines: { type: "integer", default: 2 } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_ast",
      description: "Search code structure (AST pattern search).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          node_type: { type: "string", description: "Node type: FunctionDef, ClassDef, Import, Call" },
        },
        required: ["path", "node_type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for information the model may not know or may know incorrectly/out of date: current library/API behavior, error messages, release notes, RFCs, best-practice procedures, or any topic that might have changed since training. Use this instead of guessing whenever you're not confident.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          max_results: { type: "integer", default: 5, description: "Max results to return (1-10)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch a URL — typically one returned by web_search — and return its readable text content. Use this to read a full documentation page, changelog, RFC, GitHub README, or Stack Overflow answer beyond the short snippet web_search gives you.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL to fetch." },
          max_chars: { type: "integer", default: 6000, description: "Truncate extracted text to this many characters." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_outline",
      description: "Returns imports and signatures, collapsing bodies.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file_range",
      description: "Read specific line range of a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } },
        required: ["path", "start", "end"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_multiple_files",
      description: "Batch read ranges across multiple files in one call.",
      parameters: {
        type: "object",
        properties: {
          requests: {
            type: "array",
            items: {
              type: "object",
              properties: { path: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } },
              required: ["path"],
            },
          },
        },
        required: ["requests"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_full_file",
      description: "Read complete file (fails if >500 lines).",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Show recent git diff.",
      parameters: { type: "object", properties: { ref: { type: "string", default: "HEAD~1" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "git_log",
      description: "Show recent commit history.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", default: "" }, max_count: { type: "integer", default: 5 } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sed_replace",
      description: "Single regex search and replace in a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, pattern: { type: "string" }, replacement: { type: "string" } },
        required: ["path", "pattern", "replacement"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sed_replace_multi",
      description: "Bulk search and replace across files matching pattern.",
      parameters: {
        type: "object",
        properties: {
          glob_pattern: { type: "string" },
          pattern: { type: "string" },
          replacement: { type: "string" },
        },
        required: ["glob_pattern", "pattern", "replacement"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_replace_block",
      description: "Exact match multi-line block replacement (Aider format).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          search_block: { type: "string" },
          replace_block: { type: "string" },
        },
        required: ["path", "search_block", "replace_block"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_unified_diff",
      description: "Apply a unified diff patch to a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, diff: { type: "string" } },
        required: ["path", "diff"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "line_patch",
      description: "Replace lines from start to end with new content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "integer" },
          end_line: { type: "integer" },
          new_code: { type: "string" },
        },
        required: ["path", "start_line", "end_line", "new_code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_function",
      description: "Replace an entire function body by function name.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, function_name: { type: "string" }, new_code: { type: "string" } },
        required: ["path", "function_name", "new_code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "awk_transform",
      description: "Field/column structural text transform via awk.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, program: { type: "string" } },
        required: ["path", "program"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rename_symbol",
      description: "Refactor/rename symbol across project.",
      parameters: {
        type: "object",
        properties: { old_name: { type: "string" }, new_name: { type: "string" } },
        required: ["old_name", "new_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write or overwrite a file. Code files are capped at 200 lines to force surgical edits (use line_patch or search_replace_block for bigger code changes) — but documentation files (.md, .markdown, .txt, .rst, .adoc) allow up to 4000 lines since a full-file write is the normal way to produce a doc, not a risky overwrite.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "validate_syntax",
      description: "Run language-specific syntax check on file.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
];
