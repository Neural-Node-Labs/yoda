// =====================================================================
// yoda-core — the reusable agent module.
//
// This is the ONLY file other code (the CLI, an HTTP API, tests, another
// tool) should import from. Everything under src/ besides this file and
// src/types.ts is an implementation detail and may change shape freely.
//
// Design rules this module follows so it's safe to embed anywhere:
//   - No process.exit() — config/validation problems throw typed errors.
//   - No direct console/chalk/ora output — progress goes out via the
//     optional onEvent callback on each call.
//   - No shared mutable module-level state for request-scoped things like
//     LLMConfig — every call takes its config explicitly, so concurrent
//     calls with different providers never interfere with each other.
// =====================================================================

export { runYodaTask } from "./agent/reactLoop";
export { runSwarmTask } from "./swarm/orchestrator";
export { runSwarmWorker } from "./swarm/worker";

export { resolveLLMConfig, loadLLMConfigFromFile, DEFAULT_MODELS, DEFAULT_BASE_URLS } from "./llm/config";
export { resolveSearchProvider } from "./search/providers";

export type {
  AgentEvent,
  AgentEventHandler,
  LLMConfig,
  LLMProvider,
  SearchProvider,
  OutputValidation,
  RunYodaTaskOptions,
  RunYodaTaskResult,
} from "./types";
export { LLMConfigError } from "./types";

export type { PlanStep, TaskPlan, StepResult, SwarmOrchestratorOptions } from "./swarm/types";
