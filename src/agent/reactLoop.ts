import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  AgentEvent,
  ChatMessage,
  OutputValidation,
  RunYodaTaskOptions,
  RunYodaTaskResult,
  ToolCall,
} from "../types";
import { llmChat } from "../llm/providers";
import { TOOLS_SCHEMA } from "../tools/schema";
import { buildToolMap, GROUNDING_TOOLS, TOOLS_REQUIRING_GROUNDING } from "../tools/registry";
import { validateOutputAgainstTask } from "./validate";

const MAX_VALIDATION_ATTEMPTS = 2;

function normalizePath(f: string): string {
  return path.resolve(f).toLowerCase();
}

/**
 * Runs the classic single-agent ReAct loop (Thought -> Action -> Observation)
 * to completion for one task. Pure library function: no console/chalk/ora,
 * no process.exit, no shared mutable module state — every dependency
 * (LLM config, search provider, cwd) is passed in explicitly, and progress
 * is reported via the optional onEvent callback. Safe to call concurrently
 * from multiple requests in a long-lived server.
 */
export async function runYodaTask(
  taskDescription: string,
  options: RunYodaTaskOptions
): Promise<RunYodaTaskResult> {
  const { llmConfig, searchProvider, onEvent, maxSteps = 40 } = options;
  const cwd = options.cwd ?? process.cwd();
  const priorCwd = process.cwd();
  if (cwd !== priorCwd) process.chdir(cwd);

  const emit = (e: AgentEvent) => onEvent?.(e);
  const TOOL_MAP = buildToolMap(searchProvider);

  try {
    // Detect files mentioned in the task that exist locally (read targets)
    // vs. ones that don't exist yet (presumed output targets).
    const mentionedFileCandidates = Array.from(
      new Set(taskDescription.match(/[A-Za-z0-9_.\-\/]+\.[A-Za-z0-9]{1,6}/g) ?? [])
    );
    const localFilesFound = mentionedFileCandidates.filter((f) => {
      try {
        return fs.existsSync(f) && fs.statSync(f).isFile();
      } catch {
        return false;
      }
    });
    const expectedOutputFiles = mentionedFileCandidates.filter((f) => !localFilesFound.includes(f));
    const writtenFiles = new Set<string>();

    const systemPrompt = [
      "You are YODA, an autonomous system engineer agent capable of using tools.",
      "Follow the ReAct framework strictly (Thought -> Action -> Observation).",
      "Rules:",
      "1. Never read full files sequentially if search or outline works, but ALWAYS read something real first — read_outline, read_file_range, read_multiple_files, read_full_file, search_code, search_ast, or get_dependency_graph.",
      "2. Batch file reads when inspecting dependencies.",
      "3. Keep code edits minimal and precise.",
      "4. Before calling write_file, sed_replace, search_replace_block, apply_unified_diff, line_patch, update_function, awk_transform, or rename_symbol, you MUST have already called a read/search tool in this session on the relevant file(s). Never write documentation, code, or edits based on assumption, memory, or general knowledge of what a file 'probably' contains — only on content you actually observed via a tool call this session.",
      "5. Output clear explanations upon task completion.",
      "6. If a filename appears in the task, ALWAYS check the current working directory first with list_directory, find_files, or read_outline before assuming it refers to an external/unfamiliar project and web-searching for it. Local files always take priority over web search.",
      "7. Do web searches only for information that cannot be found locally — unfamiliar library/API behavior, version-specific details, or anything that may have changed since training.",
      "8. Never repeat an identical tool call (same tool name and same arguments) you have already made this session — the result will not change. If your last few actions haven't made progress, stop and try a materially different approach instead of retrying variations of the same failed idea.",
      ...(localFilesFound.length > 0
        ? [
            `9. The following file(s) mentioned in the task already exist in the current working directory: ${localFilesFound.join(
              ", "
            )}. These are local files — read them directly with read_outline/read_file_range/read_full_file. Do NOT web-search for them.`,
          ]
        : []),
      ...(expectedOutputFiles.length > 0
        ? [
            `10. The task requires actually CREATING the file(s): ${expectedOutputFiles.join(", ")}. ` +
              `Composing the content and stating it in your final chat answer is NOT sufficient and does NOT ` +
              `count as completing the task — you MUST call the write_file tool with that exact path and the ` +
              `content, and see a successful observation back, before you are done. Do not give a final answer ` +
              `with no tool calls until you have done this.`,
          ]
        : []),
    ].join("\n");

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: taskDescription },
    ];

    emit({
      kind: "init",
      task: taskDescription,
      provider: llmConfig.provider,
      model: llmConfig.model,
      searchProvider,
    });

    let step = 1;
    let totalPromptTokens = 0;
    let totalEvalTokens = 0;
    let hasGrounded = false;
    const callHistory = new Map<string, number>();
    let consecutiveIdenticalCalls = 0;
    let consecutiveMalformedJson = 0;
    let consecutiveMissingWrite = 0;
    let consecutiveEmptyResponses = 0;
    let validationAttempts = 0;
    let lastValidation: OutputValidation | null = null;

    while (true) {
      if (step > maxSteps) {
        emit({
          kind: "stopped",
          reason: "step_limit",
          message: `Step limit (${maxSteps}) reached without converging on a final answer.`,
        });
        return finalizeResult("step_limit");
      }

      emit({ kind: "step_start", step });

      const response = await llmChat(llmConfig, messages, TOOLS_SCHEMA);

      const pTokens = response.prompt_eval_count ?? 0;
      const eTokens = response.eval_count ?? 0;
      totalPromptTokens += pTokens;
      totalEvalTokens += eTokens;

      const message = response.message;
      messages.push(message);

      const content: string = message.content ?? "";
      if (content) emit({ kind: "thought", step, content: content.trim() });

      let toolCalls: ToolCall[] = message.tool_calls ?? [];
      let malformedToolCallJson: string | null = null;

      // Fallback for models/servers that don't reliably emit structured
      // tool_calls: they print a tool-call-shaped JSON blob as plain
      // message content instead. Recover it as a real tool call rather
      // than silently accepting it as the final answer.
      if (toolCalls.length === 0 && content) {
        const trimmed = content.trim();
        const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const candidate = JSON.parse(jsonMatch[0]);
            if (
              candidate &&
              typeof candidate.name === "string" &&
              candidate.name in TOOL_MAP &&
              typeof candidate.arguments === "object"
            ) {
              emit({ kind: "recovered_pseudo_tool_call", step, toolName: candidate.name });
              toolCalls = [
                {
                  id: `recovered_${crypto.randomBytes(4).toString("hex")}`,
                  function: { name: candidate.name, arguments: candidate.arguments },
                },
              ];
            }
          } catch {
            const looksLikeAttemptedToolCall = /"name"\s*:\s*"/.test(trimmed) && /"arguments"\s*:/.test(trimmed);
            if (looksLikeAttemptedToolCall) malformedToolCallJson = jsonMatch[0];
          }
        }
      }

      if (malformedToolCallJson) {
        consecutiveMalformedJson += 1;
        const errMsg =
          "Error: your last response looked like an attempted tool call but was not valid JSON " +
          "(a bracket or brace was likely missing or mismatched), so no tool was executed and " +
          "nothing was written or changed. Re-emit the SAME intended tool call as strictly valid, " +
          "well-formed JSON: exactly one top-level object with a \"name\" string and an \"arguments\" " +
          "object, with all brackets/braces balanced and closed. Do not explain the mistake — just " +
          "retry the call correctly.";
        emit({ kind: "observation", step, tool: "(json_parse)", content: errMsg, isError: true });
        messages.push({ role: "user", content: errMsg });
        emit({ kind: "token_metrics", step, promptTokens: pTokens, outputTokens: eTokens });
        step += 1;

        if (consecutiveMalformedJson >= 3) {
          emit({
            kind: "stopped",
            reason: "malformed_json_loop",
            message: "The model kept producing invalid JSON for its tool calls and isn't recovering.",
          });
          return finalizeResult("malformed_json_loop");
        }
        continue;
      }
      consecutiveMalformedJson = 0;

      if ((!toolCalls || toolCalls.length === 0) && !content.trim()) {
        consecutiveEmptyResponses += 1;
        const errMsg =
          "Error: your last response had no content and no tool call. An empty response is never a " +
          "valid way to finish — either call a tool to make progress, or provide an actual final answer " +
          "summarizing what was done.";
        emit({ kind: "observation", step, tool: "(empty_response)", content: errMsg, isError: true });
        messages.push({ role: "user", content: errMsg });
        emit({ kind: "token_metrics", step, promptTokens: pTokens, outputTokens: eTokens });
        step += 1;

        if (consecutiveEmptyResponses >= 3) {
          emit({
            kind: "stopped",
            reason: "empty_response_loop",
            message: "The model stopped producing any content or tool calls and isn't recovering.",
          });
          return finalizeResult("empty_response_loop");
        }
        continue;
      }
      consecutiveEmptyResponses = 0;

      if (!toolCalls || toolCalls.length === 0) {
        const stillMissingOutputs = expectedOutputFiles.filter((f) => !writtenFiles.has(normalizePath(f)));

        if (stillMissingOutputs.length > 0) {
          consecutiveMissingWrite += 1;
          const errMsg =
            `Error: you gave a final answer with no tool calls, but the required output file(s) ` +
            `${stillMissingOutputs.join(", ")} were never actually written via write_file this session. ` +
            `Writing the content out in your chat answer does not save it to disk. Call write_file now ` +
            `with the exact path (${stillMissingOutputs.join(", ")}) and the full document content as ` +
            `'content'.`;
          emit({ kind: "observation", step, tool: "(missing_write)", content: errMsg, isError: true });
          messages.push({ role: "user", content: errMsg });
          emit({ kind: "token_metrics", step, promptTokens: pTokens, outputTokens: eTokens });
          step += 1;

          if (consecutiveMissingWrite >= 3) {
            emit({
              kind: "stopped",
              reason: "missing_write_loop",
              message: `The model kept answering in chat instead of calling write_file for ${stillMissingOutputs.join(", ")}.`,
            });
            return finalizeResult("missing_write_loop");
          }
          continue;
        }

        // Files exist on disk now — but do they actually satisfy the task,
        // or just technically exist? Run an independent QA pass before
        // accepting completion.
        if (expectedOutputFiles.length > 0 && validationAttempts < MAX_VALIDATION_ATTEMPTS) {
          const validation = await validateOutputAgainstTask(llmConfig, taskDescription, expectedOutputFiles);
          validationAttempts += 1;
          lastValidation = validation;

          emit({ kind: "validation", step, score: validation.score, aligned: validation.aligned, issues: validation.issues });

          if (!validation.aligned && validation.score >= 0) {
            const errMsg =
              `The output was written to disk but did NOT pass validation against the task ` +
              `(score ${validation.score}/100). Issues found:\n- ${validation.issues.join("\n- ")}\n` +
              `Revise the file content to address these issues, grounding any claims in the actual source ` +
              `you already read this session, then call write_file again with the corrected content.`;
            messages.push({ role: "user", content: errMsg });
            emit({ kind: "token_metrics", step, promptTokens: pTokens, outputTokens: eTokens });
            step += 1;
            continue;
          }
        } else if (expectedOutputFiles.length > 0 && lastValidation && !lastValidation.aligned && lastValidation.score >= 0) {
          emit({
            kind: "validation_exhausted",
            score: lastValidation.score,
            issues: lastValidation.issues,
          });
        }

        emit({
          kind: "final_answer",
          content,
          totalPromptTokens: totalPromptTokens,
          totalOutputTokens: totalEvalTokens,
        });
        return finalizeResult("completed");
      }

      let forceStop = false;

      for (const call of toolCalls) {
        const fnName: string = call.function.name;
        const fnArgs: any = call.function.arguments;

        emit({ kind: "action", step, tool: fnName, args: fnArgs });

        const callKey = `${fnName}::${JSON.stringify(fnArgs)}`;
        const priorCount = callHistory.get(callKey) ?? 0;
        callHistory.set(callKey, priorCount + 1);

        let obsResult: string;
        let skipExecution = false;

        if (priorCount > 0) {
          consecutiveIdenticalCalls += 1;
          obsResult =
            `Refused: identical call to '${fnName}' with the same arguments was already made ` +
            `${priorCount} time(s) this session — the result will not change. Stop repeating this ` +
            `exact call. Try a materially different tool, different arguments, or a different approach ` +
            `entirely.`;
          skipExecution = true;

          if (consecutiveIdenticalCalls >= 3) {
            emit({ kind: "observation", step, tool: fnName, content: obsResult, isError: true });
            messages.push({ role: "tool", content: obsResult, tool_call_id: call.id });
            emit({
              kind: "stopped",
              reason: "duplicate_loop",
              message: "The agent is stuck repeating identical tool calls without making progress.",
            });
            forceStop = true;
            break;
          }
        } else {
          consecutiveIdenticalCalls = 0;
          obsResult = "";
        }

        if (!skipExecution && TOOLS_REQUIRING_GROUNDING.has(fnName) && !hasGrounded) {
          obsResult =
            `Refused: '${fnName}' was blocked because no file has been read or ` +
            `searched yet this session. Call one of: ${[...GROUNDING_TOOLS].join(", ")} ` +
            `on the actual relevant file(s) first, then retry '${fnName}' using only ` +
            `content you observed from that call.`;
        } else if (!skipExecution) {
          try {
            if (fnName in TOOL_MAP) {
              obsResult = await TOOL_MAP[fnName](fnArgs);
              if (GROUNDING_TOOLS.has(fnName) && !/^Error:|^Refused:/i.test(obsResult.trim())) {
                hasGrounded = true;
              }
              if (fnName === "write_file" && typeof fnArgs?.path === "string" && !/^Error:|^Refused:/i.test(obsResult.trim())) {
                writtenFiles.add(normalizePath(fnArgs.path));
                consecutiveMissingWrite = 0;
              }
            } else {
              obsResult = `Error: Tool '${fnName}' does not exist.`;
            }
          } catch (ex: any) {
            obsResult = `Tool Execution Error: ${ex.message ?? ex}`;
          }
        }

        const isError = /^Error:|^Refused:|Execution error|Tool Execution Error|SyntaxError|AST Error|Patch Failed/i.test(
          obsResult.trim()
        );
        emit({ kind: "observation", step, tool: fnName, content: obsResult.trim(), isError });
        messages.push({ role: "tool", content: obsResult, tool_call_id: call.id });
      }

      if (forceStop) return finalizeResult("duplicate_loop");

      emit({ kind: "token_metrics", step, promptTokens: pTokens, outputTokens: eTokens });
      step += 1;
    }

    function finalizeResult(stoppedReason: RunYodaTaskResult["stoppedReason"]): RunYodaTaskResult {
      return {
        finalAnswer: stoppedReason === "completed" ? messages[messages.length - 1]?.content ?? "" : "",
        filesWritten: Array.from(writtenFiles),
        totalPromptTokens,
        totalOutputTokens: totalEvalTokens,
        steps: step,
        stoppedReason,
        lastValidation,
      };
    }
  } finally {
    if (cwd !== priorCwd) process.chdir(priorCwd);
  }
}
