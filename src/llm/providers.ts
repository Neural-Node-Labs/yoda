import * as crypto from "crypto";
import ollama from "ollama";
import {
  ChatMessage,
  ChatRequestOptions,
  LLMConfig,
  NormalizedChatResponse,
  ToolCall,
} from "../types";
import { DEFAULT_BASE_URLS } from "./config";

/**
 * Best-effort JSON extraction: strips markdown fences, then falls back to
 * grabbing the first {...} block if the model wrapped valid JSON in prose.
 */
export function safeJsonParse(text: string): any | null {
  if (!text) return null;
  const stripped = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizeOllamaToolCalls(rawCalls: any[] | undefined): ToolCall[] | undefined {
  if (!rawCalls || rawCalls.length === 0) return undefined;
  return rawCalls.map((c, i) => ({
    id: c.id ?? `call_${i}_${crypto.randomBytes(4).toString("hex")}`,
    function: { name: c.function.name, arguments: c.function.arguments },
  }));
}

async function chatViaOllama(
  model: string,
  messages: ChatMessage[],
  tools?: any[],
  options?: ChatRequestOptions
): Promise<NormalizedChatResponse> {
  const request: any = { model, messages };
  if (tools) request.tools = tools;
  if (options?.format === "json") request.format = "json";

  const response: any = await ollama.chat(request);
  const message = response.message ?? {};
  return {
    message: {
      role: message.role ?? "assistant",
      content: message.content ?? "",
      tool_calls: normalizeOllamaToolCalls(message.tool_calls),
    },
    prompt_eval_count: response.prompt_eval_count ?? 0,
    eval_count: response.eval_count ?? 0,
  };
}

function toOpenAIMessage(m: ChatMessage): any {
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
  }
  if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

async function chatViaOpenAICompatible(
  messages: ChatMessage[],
  tools: any[] | undefined,
  options: ChatRequestOptions | undefined,
  cfg: { baseUrl: string; apiKey: string; model: string }
): Promise<NormalizedChatResponse> {
  const body: any = {
    model: cfg.model,
    messages: messages.map(toOpenAIMessage),
  };
  if (tools && tools.length > 0) body.tools = tools;
  if (options?.format === "json") body.response_format = { type: "json_object" };

  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`LLM request failed (${res.status}): ${errText.slice(0, 500)}`);
  }

  const data: any = await res.json();
  const choice = data.choices?.[0]?.message ?? {};
  const toolCalls: ToolCall[] | undefined = choice.tool_calls?.map((c: any) => ({
    id: c.id,
    function: {
      name: c.function.name,
      arguments: safeJsonParse(c.function.arguments) ?? c.function.arguments,
    },
  }));

  return {
    message: { role: "assistant", content: choice.content ?? "", tool_calls: toolCalls },
    prompt_eval_count: data.usage?.prompt_tokens ?? 0,
    eval_count: data.usage?.completion_tokens ?? 0,
  };
}

async function chatViaClaude(
  messages: ChatMessage[],
  tools: any[] | undefined,
  _options: ChatRequestOptions | undefined,
  cfg: { baseUrl: string; apiKey: string; model: string }
): Promise<NormalizedChatResponse> {
  const systemText = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const converted: any[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "tool") {
      converted.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }],
      });
      continue;
    }

    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const blocks: any[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: tc.function.arguments });
      }
      converted.push({ role: "assistant", content: blocks });
      continue;
    }

    converted.push({ role: m.role, content: m.content });
  }

  const anthropicTools = (tools ?? []).map((t: any) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));

  const body: any = { model: cfg.model, max_tokens: 4096, messages: converted };
  if (systemText) body.system = systemText;
  if (anthropicTools.length > 0) body.tools = anthropicTools;

  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`LLM request failed (${res.status}): ${errText.slice(0, 500)}`);
  }

  const data: any = await res.json();
  const blocks: any[] = data.content ?? [];
  const textParts = blocks.filter((b) => b.type === "text").map((b) => b.text);
  const toolUseBlocks = blocks.filter((b) => b.type === "tool_use");
  const toolCalls: ToolCall[] | undefined =
    toolUseBlocks.length > 0
      ? toolUseBlocks.map((b) => ({ id: b.id, function: { name: b.name, arguments: b.input } }))
      : undefined;

  return {
    message: { role: "assistant", content: textParts.join("\n"), tool_calls: toolCalls },
    prompt_eval_count: data.usage?.input_tokens ?? 0,
    eval_count: data.usage?.output_tokens ?? 0,
  };
}

/**
 * Single entry point every part of the agent uses to talk to an LLM.
 * Unlike the original script, this takes the LLMConfig explicitly on every
 * call instead of reading a process-wide mutable global — that global was
 * fine for a single CLI invocation, but unsafe for an API server handling
 * concurrent requests with different configs.
 */
export async function llmChat(
  config: LLMConfig,
  messages: ChatMessage[],
  tools?: any[],
  options?: ChatRequestOptions
): Promise<NormalizedChatResponse> {
  switch (config.provider) {
    case "ollama":
      return chatViaOllama(config.model, messages, tools, options);
    case "openai":
    case "deepseek":
      return chatViaOpenAICompatible(messages, tools, options, {
        baseUrl: config.baseUrl ?? DEFAULT_BASE_URLS[config.provider]!,
        apiKey: config.apiKey!,
        model: config.model,
      });
    case "claude":
      return chatViaClaude(messages, tools, options, {
        baseUrl: config.baseUrl ?? DEFAULT_BASE_URLS.claude!,
        apiKey: config.apiKey!,
        model: config.model,
      });
    default:
      throw new Error(`Unsupported provider: ${config.provider}`);
  }
}

/** Asks the model for a single JSON object, with one repair attempt if parsing fails. */
export async function requestJson(config: LLMConfig, systemPrompt: string, userPrompt: string): Promise<any> {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await llmChat(config, messages, undefined, { format: "json" });
    const content: string = response.message.content ?? "";
    const parsed = safeJsonParse(content);
    if (parsed) return parsed;

    messages.push({ role: "assistant", content });
    messages.push({
      role: "user",
      content:
        "That was not valid JSON. Respond again with ONLY a single valid raw JSON object — no markdown fences, no commentary.",
    });
  }

  throw new Error("Model failed to produce valid JSON after a repair attempt.");
}
