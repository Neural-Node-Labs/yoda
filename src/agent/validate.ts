import * as fs from "fs";
import { LLMConfig, OutputValidation } from "../types";
import { requestJson } from "../llm/providers";

/**
 * Post-hoc QA check: reads back the actual content of the file(s) the task
 * was supposed to produce and asks the model — as a fresh, independent
 * call with no tool-use context to get confused by — whether that content
 * genuinely satisfies the task description. Catches the case where
 * write_file succeeded (so the earlier "was anything written" guard is
 * satisfied) but the content itself is off-target: too generic, missing
 * requested sections, hallucinated instead of grounded, etc.
 */
export async function validateOutputAgainstTask(
  config: LLMConfig,
  taskDescription: string,
  filePaths: string[]
): Promise<OutputValidation> {
  const fileContents = filePaths.map((f) => {
    try {
      const raw = fs.readFileSync(f, "utf-8");
      return `--- ${f} ---\n${raw.slice(0, 8000)}${raw.length > 8000 ? "\n[...truncated...]" : ""}`;
    } catch (e: any) {
      return `--- ${f} ---\n[Could not read file: ${e.message ?? e}]`;
    }
  });

  const validationSystemPrompt = [
    "You are YODA's QA reviewer. You are given a task description and the ACTUAL content of the file(s)",
    "produced for it. Judge, strictly and skeptically, whether the content genuinely satisfies the task —",
    "not whether a file merely exists. Look for: generic/templated content that doesn't reflect the real",
    "subject matter, missing sections the task implied, wrong file addressed, or claims not backed by the",
    "actual source (hallucination).",
    'Respond with ONLY raw JSON: {"aligned": boolean, "score": number, "issues": string[]}',
    "where score is 0-100 (100 = fully satisfies the task) and issues is a short list of concrete problems",
    "(empty array if none). Set aligned to false if score < 60 or there is any major gap.",
  ].join("\n");

  const validationUserPrompt = [`TASK: ${taskDescription}`, "", "PRODUCED FILE(S):", fileContents.join("\n\n")].join("\n");

  try {
    const result = await requestJson(config, validationSystemPrompt, validationUserPrompt);
    return {
      aligned: Boolean(result?.aligned),
      score: typeof result?.score === "number" ? result.score : 0,
      issues: Array.isArray(result?.issues) ? result.issues.map((i: any) => String(i)) : [],
    };
  } catch (e: any) {
    // If the validator itself fails (e.g. JSON repair exhausted), don't
    // block completion on a broken QA step — just note it couldn't verify.
    return { aligned: true, score: -1, issues: [`Validation step failed to run: ${e.message ?? e}`] };
  }
}
