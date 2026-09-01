# YODA — modular ReAct agent

The agent logic now lives in `src/` as a reusable module. Both the CLI
(`yoda.ts`) and the example HTTP API (`api.ts`) import the same core and
add nothing but presentation on top.

## Structure

```
src/
  types.ts              Shared types: LLMConfig, ChatMessage, AgentEvent, ...
  llm/
    config.ts             resolveLLMConfig (throws LLMConfigError, never process.exit)
    providers.ts           llmChat() — Ollama / OpenAI-compatible / Claude adapters
  search/
    providers.ts           Tavily / Serper / Brave / DuckDuckGo + web_search, web_fetch
  tools/
    schema.ts               Tool definitions given to the model
    fileTools.ts            read/write/patch/search tool implementations
    shellTools.ts           shell/list_directory/find_files/git tools
    validate.ts             validate_syntax (per-language)
    registry.ts              TOOL_MAP + grounding-guard tool sets
  agent/
    reactLoop.ts           runYodaTask() — the classic ReAct loop (pure, event-driven)
    validate.ts             validateOutputAgainstTask() — QA gate on written output
  swarm/
    orchestrator.ts         runSwarmTask() — plan -> isolated steps -> healing -> score
    worker.ts                executeSwarmStep() — runs inside a forked child process
    types.ts
  index.ts                 THE public module surface — import only from here
presenters/
  cliPresenter.ts          chalk/ora rendering of AgentEvent streams (CLI-only concern)
cli.ts                     minimist parsing -> core module -> cliPresenter
yoda.ts                    thin CLI entry point
api.ts                     minimal example HTTP API using the same core module
```

## Design rules the core (`src/`) follows

- **No `process.exit`.** Config/validation problems throw `LLMConfigError`
  or a plain `Error`. Only `cli.ts` catches these and exits the process —
  an API server must never die because one request had a bad config.
- **No direct console/chalk/ora.** Progress is reported via an optional
  `onEvent` callback (`AgentEvent` for classic mode). `presenters/cliPresenter.ts`
  is the only file that renders these to a terminal; an API can instead
  collect events into JSON or forward them over SSE (see `api.ts`).
- **No shared mutable state for request-scoped config.** `LLMConfig` and
  `SearchProvider` are passed explicitly into every call, so concurrent
  requests using different providers never interfere with each other.

## Install

```bash
npm install
```

## Run the CLI (same usage as before)

```bash
npx tsx yoda.ts --task "write a design document for blueprint.md for ./yoda.ts" --llm ./config.yaml
npx tsx yoda.ts --task "..." --mode swarm --llm openai
```

## Run the example API

```bash
npx tsx api.ts
# in another terminal:
curl -X POST localhost:8787/task \
  -H 'Content-Type: application/json' \
  -d '{"task": "list the files in this directory", "llm": "ollama"}'

# streaming variant (Server-Sent Events of AgentEvents, ending in a "result" event):
curl -N -X POST localhost:8787/task/stream \
  -H 'Content-Type: application/json' \
  -d '{"task": "list the files in this directory", "llm": "ollama"}'
```

`api.ts` uses only Node's built-in `http` module on purpose, so it's clear
exactly what the core module needs from any caller — swap it for
Express/Fastify/etc. in a real deployment; the routes are just
"parse request → call `runYodaTask`/`runSwarmTask` → shape a response."

## Programmatic use (embedding directly, no HTTP)

```ts
import { runYodaTask, resolveLLMConfig, resolveSearchProvider } from "./src/index";

const result = await runYodaTask("summarize package.json", {
  llmConfig: resolveLLMConfig("ollama", undefined),
  searchProvider: resolveSearchProvider(),
  onEvent: (e) => console.log(e), // optional
});

console.log(result.finalAnswer, result.filesWritten, result.lastValidation);
```

## Typecheck

```bash
npm run typecheck
```
