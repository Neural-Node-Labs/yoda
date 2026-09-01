import * as crypto from "crypto";
import { ChatMessage, ToolCall } from "../types";
import { llmChat, safeJsonParse } from "../llm/providers";
import { TOOLS_SCHEMA } from "../tools/schema";
import { buildToolMap } from "../tools/registry";
import { SwarmAssignment } from "./types";

function makeSignature(content: string, toolCalls: any[]): string {
  const normalizedThought = (content || "").trim().toLowerCase().replace(/\s+/g, " ");
  const normalizedActions = (toolCalls || [])
    .map((c) => `${c.function?.name}:${JSON.stringify(c.function?.arguments)}`)
    .sort()
    .join("|");
  return crypto.createHash("sha1").update(`${normalizedThought}::${normalizedActions}`).digest("hex");
}

function workerSend(msg: any): void {
  if (process.send) process.send(msg);
}

/** The isolated ReAct loop a single swarm sub-agent runs to complete exactly one plan step. */
export async function executeSwarmStep(
  assignment: SwarmAssignment
): Promise<{ status: "completed" | "failed"; summary: string; iterations: number }> {
  const { step, taskGoal, priorFailureContext, maxIterations, llmConfig, searchProvider, cwd } = assignment;
  if (cwd) process.chdir(cwd);
  const TOOL_MAP = buildToolMap(searchProvider);

  const systemPrompt = [
    "You are a YODA swarm sub-agent. You exist only to accomplish ONE specific step, then stop.",
    "Follow ReAct strictly (Thought -> Action -> Observation) using the available tools.",
    `Overall task (context only, do not exceed scope): ${taskGoal}`,
    `Step goal: ${step.step_goal}`,
    `Step requirement: ${step.step_detailed_requirement}`,
    `Step validation (must be objectively true before you finish): ${step.step_validation}`,
    priorFailureContext ? `Note — a previous attempt at this step failed: ${priorFailureContext}` : "",
    "Never repeat an identical thought and action that already failed in this conversation — treat that as a signal to change strategy.",
    "If you're unsure about a library/API's current behavior, an unfamiliar error message, or a procedure that might have changed since your training, use web_search (and web_fetch for a full page) rather than guessing.",
    'When the validation criteria are met, or you determine the step cannot be completed, respond with NO tool calls and a final message that is ONLY raw JSON: {"status": "completed" | "failed", "summary": "..."}.',
  ]
    .filter(Boolean)
    .join("\n");

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Begin working on: ${step.step_goal}` },
  ];

  const seenSignatures = new Map<string, number>();
  const DUPLICATE_WARN_THRESHOLD = 2;
  const DUPLICATE_ABORT_THRESHOLD = 3;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const response = await llmChat(llmConfig, messages, TOOLS_SCHEMA);
    const message = response.message;
    messages.push(message);

    const content: string = message.content ?? "";
    const toolCalls: ToolCall[] = message.tool_calls ?? [];

    if (content) {
      workerSend({ type: "event", kind: "thought", step_id: step.step_id, content: content.trim() });
    }

    const signature = makeSignature(content, toolCalls);
    const seenCount = (seenSignatures.get(signature) ?? 0) + 1;
    seenSignatures.set(signature, seenCount);

    if (seenCount >= DUPLICATE_ABORT_THRESHOLD) {
      workerSend({
        type: "event",
        kind: "healing",
        step_id: step.step_id,
        content: `Duplicate thought/action detected ${seenCount} times in a row — aborting step to avoid an infinite failure loop.`,
      });
      return {
        status: "failed",
        summary: "Aborted: repeated identical thought/action loop without progress.",
        iterations: iteration,
      };
    }

    if (toolCalls.length === 0) {
      const parsed = safeJsonParse(content);
      if (parsed && (parsed.status === "completed" || parsed.status === "failed")) {
        return { status: parsed.status, summary: String(parsed.summary ?? content), iterations: iteration };
      }
      return {
        status: "completed",
        summary: content.trim() || "Step finished with no further actions.",
        iterations: iteration,
      };
    }

    if (seenCount >= DUPLICATE_WARN_THRESHOLD) {
      const notice =
        "SYSTEM NOTICE: You already attempted this exact thought/action combination and it did not resolve the step. Do not repeat it — analyze the last observation and choose a different approach.";
      workerSend({ type: "event", kind: "healing", step_id: step.step_id, content: notice });
      messages.push({ role: "user", content: notice });
    }

    for (const call of toolCalls) {
      const fnName: string = call.function.name;
      const fnArgs: any = call.function.arguments;

      workerSend({ type: "event", kind: "action", step_id: step.step_id, tool: fnName, args: fnArgs });

      let obsResult: string;
      try {
        obsResult = fnName in TOOL_MAP ? await TOOL_MAP[fnName](fnArgs) : `Error: Tool '${fnName}' does not exist.`;
      } catch (ex: any) {
        obsResult = `Tool Execution Error: ${ex.message ?? ex}`;
      }

      const isError = /^Error:|^Refused:|Execution error|Tool Execution Error|SyntaxError|AST Error|Patch Failed/i.test(
        String(obsResult).trim()
      );
      workerSend({ type: "event", kind: "observation", step_id: step.step_id, content: String(obsResult).trim(), isError });
      messages.push({ role: "tool", content: String(obsResult), tool_call_id: call.id });
    }
  }

  return {
    status: "failed",
    summary: `Exceeded max iterations (${maxIterations}) without resolving the step.`,
    iterations: maxIterations,
  };
}

/** Entry point when this same compiled/interpreted entry file is forked as an isolated swarm worker process. */
export function runSwarmWorker(): void {
  process.on("message", async (assignment: SwarmAssignment) => {
    try {
      const result = await executeSwarmStep(assignment);
      workerSend({ type: "result", status: result.status, summary: result.summary, iterations: result.iterations });
    } catch (err: any) {
      workerSend({ type: "result", status: "failed", summary: `Unhandled worker exception: ${err?.message ?? err}`, iterations: 0 });
    } finally {
      process.exit(0);
    }
  });

  process.on("uncaughtException", (err) => {
    try {
      workerSend({ type: "result", status: "failed", summary: `Uncaught exception: ${err.message}`, iterations: 0 });
    } catch {
      /* parent will detect the dead process via 'exit' */
    }
    process.exit(1);
  });

  process.on("unhandledRejection", (err: any) => {
    try {
      workerSend({ type: "result", status: "failed", summary: `Unhandled rejection: ${err?.message ?? err}`, iterations: 0 });
    } catch {
      /* parent will detect the dead process via 'exit' */
    }
    process.exit(1);
  });
}
