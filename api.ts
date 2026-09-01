#!/usr/bin/env node
/**
 * Minimal example API server exposing YODA's core module over HTTP.
 * Uses only Node's built-in `http` module — no framework dependency — so
 * it's easy to see exactly what the core module needs from a caller. Swap
 * this for Express/Fastify/etc. in a real deployment; the important part
 * is that every route below is just: parse request -> call core module ->
 * shape a response. No agent logic lives in this file.
 *
 * Run with:
 *   npx tsx api.ts
 *
 * Endpoints:
 *   POST /task            { task, llm?, model?, search? } -> JSON RunYodaTaskResult
 *   POST /task/stream      same body -> text/event-stream of AgentEvents, ending in a "result" event
 *
 * Example:
 *   curl -X POST localhost:8787/task -H 'Content-Type: application/json' \
 *     -d '{"task": "list the files in this directory", "llm": "ollama"}'
 */
import * as http from "http";
import { runYodaTask, resolveLLMConfig, resolveSearchProvider, LLMConfigError, AgentEvent } from "./src/index";

const PORT = Number(process.env.PORT ?? 8787);

interface TaskRequestBody {
  task: string;
  llm?: string; // provider name or path to a YAML config, same as CLI --llm
  model?: string;
  search?: string;
}

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** Shared setup: parse+validate the request body into an LLM config + search provider. Throws on bad input. */
function resolveRunConfig(body: TaskRequestBody) {
  if (!body.task || typeof body.task !== "string") {
    throw new LLMConfigError("Request body must include a 'task' string.");
  }
  // resolveLLMConfig throws LLMConfigError (not process.exit) on a bad/missing
  // API key — exactly what makes it safe to call per-request in a server.
  const llmConfig = resolveLLMConfig(body.llm, body.model);
  const searchProvider = resolveSearchProvider(body.search);
  return { task: body.task, llmConfig, searchProvider };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/task") {
      const body = await readJsonBody(req);
      const { task, llmConfig, searchProvider } = resolveRunConfig(body);

      const result = await runYodaTask(task, { llmConfig, searchProvider });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result, null, 2));
      return;
    }

    if (req.method === "POST" && req.url === "/task/stream") {
      const body = await readJsonBody(req);
      const { task, llmConfig, searchProvider } = resolveRunConfig(body);

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const send = (eventName: string, data: unknown) => {
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const onEvent = (event: AgentEvent) => send("agent_event", event);

      try {
        const result = await runYodaTask(task, { llmConfig, searchProvider, onEvent });
        send("result", result);
      } catch (err: any) {
        send("error", { message: err?.message ?? String(err) });
      } finally {
        res.end();
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. Try POST /task or POST /task/stream." }));
  } catch (err: any) {
    const status = err instanceof LLMConfigError ? 400 : 500;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err?.message ?? String(err) }));
  }
});

server.listen(PORT, () => {
  console.log(`YODA API listening on http://localhost:${PORT}`);
  console.log(`  POST /task          { "task": "...", "llm": "ollama" }`);
  console.log(`  POST /task/stream   same body, text/event-stream response`);
});
