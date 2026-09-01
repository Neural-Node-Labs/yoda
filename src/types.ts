// =====================================================================
// Shared types — the vocabulary every layer of the core module speaks.
// Nothing in this file touches the filesystem, the network, or the
// console; it's pure data shape.
// =====================================================================

export type LLMProvider = "ollama" | "deepseek" | "claude" | "openai";

export const KNOWN_PROVIDERS: LLMProvider[] = ["ollama", "deepseek", "claude", "openai"];

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export type SearchProvider = "tavily" | "serper" | "brave" | "duckduckgo";

export interface ToolCall {
  id: string;
  function: { name: string; arguments: any };
}

export interface ChatMessage {
  role: string;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface NormalizedChatResponse {
  message: { role: string; content: string; tool_calls?: ToolCall[] };
  prompt_eval_count: number;
  eval_count: number;
}

export interface ChatRequestOptions {
  /** Ask the provider for strict JSON output where it natively supports it. */
  format?: "json";
}

/**
 * Thrown by LLM config resolution instead of calling process.exit(), so the
 * core module is safe to embed inside a long-lived API server — one bad
 * request must never be able to kill the whole process. Only the CLI entry
 * point is allowed to catch this and exit.
 */
export class LLMConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMConfigError";
  }
}

// ---- Agent execution events --------------------------------------------
//
// The core agent loop never touches console/chalk/ora directly. Instead it
// emits a stream of these events via an optional onEvent callback. A CLI
// presenter renders them with colors and spinners; an API layer can collect
// them into a JSON array, forward them over SSE/WebSocket, or ignore them
// entirely and just await the final TaskResult.

export type AgentEvent =
  | { kind: "init"; task: string; provider: LLMProvider; model: string; searchProvider: SearchProvider }
  | { kind: "step_start"; step: number }
  | { kind: "thought"; step: number; content: string }
  | { kind: "recovered_pseudo_tool_call"; step: number; toolName: string }
  | { kind: "action"; step: number; tool: string; args: any }
  | { kind: "observation"; step: number; tool: string; content: string; isError: boolean }
  | { kind: "validation"; step: number; score: number; aligned: boolean; issues: string[] }
  | { kind: "validation_exhausted"; score: number; issues: string[] }
  | { kind: "warning"; step: number; message: string }
  | { kind: "stopped"; reason: string; message: string }
  | { kind: "token_metrics"; step: number; promptTokens: number; outputTokens: number }
  | { kind: "final_answer"; content: string; totalPromptTokens: number; totalOutputTokens: number };

export type AgentEventHandler = (event: AgentEvent) => void;

export interface OutputValidation {
  aligned: boolean;
  score: number;
  issues: string[];
}

export interface RunYodaTaskOptions {
  /** LLM config to use for this run. Required — the core never falls back to a hidden default. */
  llmConfig: LLMConfig;
  /** Search provider for the web_search/web_fetch tools. */
  searchProvider: SearchProvider;
  /** Optional event subscriber; omit for silent/headless use. */
  onEvent?: AgentEventHandler;
  /** Working directory tools should operate relative to. Defaults to process.cwd(). */
  cwd?: string;
  /** Hard ceiling on ReAct steps. Defaults to 40. */
  maxSteps?: number;
}

export interface RunYodaTaskResult {
  finalAnswer: string;
  filesWritten: string[];
  totalPromptTokens: number;
  totalOutputTokens: number;
  steps: number;
  stoppedReason: "completed" | "step_limit" | "duplicate_loop" | "malformed_json_loop" | "empty_response_loop" | "missing_write_loop";
  lastValidation: OutputValidation | null;
}
