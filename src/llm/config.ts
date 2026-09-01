import * as fs from "fs";
import * as yaml from "js-yaml";
import { KNOWN_PROVIDERS, LLMConfig, LLMConfigError, LLMProvider } from "../types";

export const DEFAULT_MODELS: Record<LLMProvider, string> = {
  ollama: "qwen2.5:7b",
  deepseek: "deepseek-chat",
  claude: "claude-sonnet-4-5-20250929",
  openai: "gpt-4o-mini",
};

export const DEFAULT_BASE_URLS: Partial<Record<LLMProvider, string>> = {
  deepseek: "https://api.deepseek.com/v1",
  claude: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
};

export function apiKeyEnvVarName(provider: LLMProvider): string | undefined {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "deepseek":
      return "DEEPSEEK_API_KEY";
    case "claude":
      return "ANTHROPIC_API_KEY";
    default:
      return undefined;
  }
}

export function apiKeyFromEnv(provider: LLMProvider): string | undefined {
  const varName = apiKeyEnvVarName(provider);
  return varName ? process.env[varName] : undefined;
}

/** Loads a full LLM config from a YAML file, e.g. `.agent/config.yaml`. Throws LLMConfigError on any problem. */
export function loadLLMConfigFromFile(filePath: string): LLMConfig {
  if (!fs.existsSync(filePath)) {
    throw new LLMConfigError(`LLM config file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = yaml.load(raw) as any;
  if (!parsed || typeof parsed !== "object") {
    throw new LLMConfigError(`LLM config file is empty or invalid: ${filePath}`);
  }

  const providerRaw = String(parsed.provider ?? "ollama").toLowerCase();
  if (!KNOWN_PROVIDERS.includes(providerRaw as LLMProvider)) {
    throw new LLMConfigError(
      `Unknown provider '${parsed.provider}' in ${filePath}. Must be one of: ${KNOWN_PROVIDERS.join(", ")}.`
    );
  }
  const provider = providerRaw as LLMProvider;

  return {
    provider,
    model: parsed.model ? String(parsed.model) : DEFAULT_MODELS[provider],
    apiKey: parsed.apiKey ? String(parsed.apiKey) : apiKeyFromEnv(provider),
    baseUrl: parsed.baseUrl ? String(parsed.baseUrl) : DEFAULT_BASE_URLS[provider],
  };
}

/**
 * Resolves the LLM config from CLI-style inputs:
 *   llmArg = <provider>     one of ollama|deepseek|claude|openai
 *   llmArg = <path.yaml>    a YAML file with provider/model/apiKey/baseUrl
 *   modelArg                overrides whichever model the above resolved to
 * Falls back to local Ollama with no arguments at all.
 *
 * Throws LLMConfigError instead of exiting the process — callers embedding
 * this in a long-lived server (or any non-CLI context) must be able to
 * catch and handle a bad config without the whole process dying. Only the
 * CLI entry point should catch LLMConfigError and call process.exit.
 */
export function resolveLLMConfig(llmArg: string | undefined, modelArg: string | undefined): LLMConfig {
  let config: LLMConfig;

  if (llmArg && KNOWN_PROVIDERS.includes(llmArg.toLowerCase() as LLMProvider)) {
    const provider = llmArg.toLowerCase() as LLMProvider;
    config = {
      provider,
      model: DEFAULT_MODELS[provider],
      apiKey: apiKeyFromEnv(provider),
      baseUrl: DEFAULT_BASE_URLS[provider],
    };
  } else if (llmArg) {
    config = loadLLMConfigFromFile(llmArg);
  } else {
    config = { provider: "ollama", model: DEFAULT_MODELS.ollama };
  }

  if (modelArg) {
    config.model = modelArg;
  }

  if (config.provider !== "ollama" && !config.apiKey) {
    throw new LLMConfigError(
      `No API key found for provider '${config.provider}'. Set ${apiKeyEnvVarName(
        config.provider
      )} in your environment, or set 'apiKey' in the --llm config file.`
    );
  }

  return config;
}

export function resolveSearchProviderName(explicit?: string): "tavily" | "serper" | "brave" | "duckduckgo" {
  const requested = (explicit ?? "").toLowerCase();
  if (requested === "tavily" || requested === "serper" || requested === "brave" || requested === "duckduckgo") {
    return requested;
  }
  if (process.env.TAVILY_API_KEY) return "tavily";
  if (process.env.BRAVE_API_KEY) return "brave";
  if (process.env.SERPER_API_KEY) return "serper";
  return "duckduckgo";
}
