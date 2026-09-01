import * as fs from "fs";
import * as path from "path";
import { ChildProcess, fork } from "child_process";
import { ChatMessage, LLMConfig } from "../types";
import { llmChat, requestJson, safeJsonParse } from "../llm/providers";
import { PlanStep, StepResult, SwarmAssignment, SwarmOrchestratorOptions, TaskPlan } from "./types";

const TASKS_DIR = path.join(".agent", "tasks");

function getNextPlanPath(): string {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const existing = fs.readdirSync(TASKS_DIR).filter((f) => /^task_plan_\d{4}\.json$/.test(f));
  const nums = existing.map((f) => parseInt(f.match(/\d{4}/)![0], 10));
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 0;
  return path.join(TASKS_DIR, `task_plan_${String(next).padStart(4, "0")}.json`);
}

function persistPlan(planPath: string, plan: TaskPlan): void {
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");
}

async function generatePlan(llmConfig: LLMConfig, taskGoal: string): Promise<TaskPlan> {
  const planningSystemPrompt = [
    "You are YODA's planning module — a senior software/systems architect.",
    "Break the given task into the smallest set of clear, independently-verifiable steps needed to fully accomplish it.",
    "Respond with ONLY raw JSON (no markdown fences, no commentary) matching exactly this shape:",
    '{"steps": [{"step_goal": string, "step_detailed_requirement": string, "step_validation": string}], "task_validation": string}',
    "- step_goal: short imperative description of what the step must achieve.",
    "- step_detailed_requirement: precise, actionable detail a sub-agent needs to execute the step without further clarification.",
    "- step_validation: an objective, checkable condition that proves the step succeeded.",
    "- task_validation: an objective, checkable condition that proves the ENTIRE task succeeded.",
  ].join("\n");

  const raw = await requestJson(llmConfig, planningSystemPrompt, taskGoal);
  const stepsInput: any[] = Array.isArray(raw?.steps) ? raw.steps : [];
  if (stepsInput.length === 0) {
    throw new Error("Planning failed: model did not return any steps.");
  }

  const steps: PlanStep[] = stepsInput.map((s, i) => ({
    step_id: `step_${String(i + 1).padStart(3, "0")}`,
    step_goal: String(s.step_goal ?? `Step ${i + 1}`),
    step_detailed_requirement: String(s.step_detailed_requirement ?? ""),
    step_validation: String(s.step_validation ?? ""),
    step_status: "pending",
  }));

  return {
    task_goal: taskGoal,
    timestamp: new Date().toISOString(),
    status: "planning",
    task_validation: String(raw?.task_validation ?? ""),
    llm_score: null,
    steps,
  };
}

function forkSwarmWorker(entryPath: string): ChildProcess {
  return fork(entryPath, ["--__swarm-worker"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
}

/** Runs one isolated swarm-agent attempt at a step. Never throws — a dead/hung/erroring child resolves as a failed StepResult so the orchestrator can keep going. */
function runStepAttempt(
  step: PlanStep,
  taskGoal: string,
  priorFailureContext: string | undefined,
  opts: SwarmOrchestratorOptions,
  entryPath: string
): Promise<StepResult> {
  return new Promise((resolve) => {
    let settled = false;
    const child = forkSwarmWorker(entryPath);

    const timer = setTimeout(() => {
      if (settled) return;
      opts.onEvent?.({
        kind: "isolated",
        step_id: step.step_id,
        message: `Swarm process exceeded ${opts.stepTimeoutMs}ms and was terminated. Orchestrator isolated the failure and continues.`,
      });
      finish({ status: "failed", summary: `Timed out after ${opts.stepTimeoutMs}ms`, iterations: 0, isolated: true });
    }, opts.stepTimeoutMs);

    function finish(res: StepResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already dead */
      }
      resolve(res);
    }

    child.on("message", (msg: any) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "event") {
        opts.onEvent?.({ kind: "swarm_event", step_id: step.step_id, ...msg });
      } else if (msg.type === "result") {
        finish({ status: msg.status, summary: msg.summary, iterations: msg.iterations ?? 0, isolated: false });
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      opts.onEvent?.({
        kind: "isolated",
        step_id: step.step_id,
        message: `Swarm process error: ${err.message}. Orchestrator isolated the failure and continues.`,
      });
      finish({ status: "failed", summary: `Process error: ${err.message}`, iterations: 0, isolated: true });
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      opts.onEvent?.({
        kind: "isolated",
        step_id: step.step_id,
        message: `Swarm process exited unexpectedly (code=${code}, signal=${signal}) without returning a result. Orchestrator isolated the failure and continues.`,
      });
      finish({
        status: "failed",
        summary: `Process died unexpectedly (code=${code}, signal=${signal})`,
        iterations: 0,
        isolated: true,
      });
    });

    const assignment: SwarmAssignment = {
      step,
      taskGoal,
      priorFailureContext,
      maxIterations: opts.maxIterations,
      llmConfig: opts.llmConfig,
      searchProvider: opts.searchProvider,
      cwd: opts.cwd ?? process.cwd(),
    };
    child.send(assignment);
  });
}

async function runStepWithHealing(
  plan: TaskPlan,
  step: PlanStep,
  planPath: string,
  opts: SwarmOrchestratorOptions,
  entryPath: string
): Promise<StepResult> {
  let priorContext: string | undefined;
  let result: StepResult = { status: "failed", summary: "not started", iterations: 0, isolated: false };
  const totalAttempts = opts.maxRetries + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    step.step_status = "in_progress";
    persistPlan(planPath, plan);
    opts.onEvent?.({ kind: "step_header", step_id: step.step_id, step_goal: step.step_goal, attempt, totalAttempts });

    result = await runStepAttempt(step, plan.task_goal, priorContext, opts, entryPath);

    if (result.status === "completed") {
      step.step_status = "completed";
      persistPlan(planPath, plan);
      opts.onEvent?.({ kind: "step_completed", step_id: step.step_id, summary: result.summary });
      return result;
    }

    if (attempt < totalAttempts) {
      opts.onEvent?.({ kind: "healing_notice", step_id: step.step_id, attempt, reason: result.summary });
      priorContext = `Previous attempt #${attempt} failed: ${result.summary}${
        result.isolated ? " (the previous attempt's process crashed or hung and was isolated by the orchestrator)" : ""
      }. Try a materially different approach this time.`;
    }
  }

  step.step_status = "failed";
  persistPlan(planPath, plan);
  opts.onEvent?.({ kind: "step_failed", step_id: step.step_id, attempts: totalAttempts, summary: result.summary });
  return result;
}

async function finalizeTask(llmConfig: LLMConfig, plan: TaskPlan, planPath: string): Promise<void> {
  const anyFailed = plan.steps.some((s) => s.step_status !== "completed");
  plan.status = anyFailed ? "failed" : "completed";

  try {
    const evalSystem = [
      "You are YODA's evaluation module. Given a task goal and the outcome of each step, assess overall accomplishment.",
      'Respond with ONLY raw JSON: {"task_validation": string, "llm_score": number} where llm_score is 0-100 reflecting how completely and correctly the task goal was achieved.',
    ].join("\n");
    const evalUser = JSON.stringify({
      task_goal: plan.task_goal,
      steps: plan.steps.map((s) => ({ step_goal: s.step_goal, step_validation: s.step_validation, step_status: s.step_status })),
    });
    const parsed = await requestJson(llmConfig, evalSystem, evalUser);
    if (parsed && typeof parsed.task_validation === "string") plan.task_validation = parsed.task_validation;
    if (parsed && typeof parsed.llm_score === "number") plan.llm_score = parsed.llm_score;
  } catch {
    plan.task_validation = anyFailed
      ? "One or more steps did not complete their validation criteria."
      : "All steps completed and met their validation criteria.";
    const completedCount = plan.steps.filter((s) => s.step_status === "completed").length;
    plan.llm_score = Math.round((completedCount / Math.max(1, plan.steps.length)) * 100);
  }

  persistPlan(planPath, plan);
}

/**
 * Runs the full swarm orchestrator: draft a plan, execute each step in an
 * isolated forked worker with retry/healing, then score the outcome.
 * Pure library function — progress goes out via opts.onEvent, and the
 * final TaskPlan (including its persisted file path) is returned so a
 * caller (CLI or API) can render or serve it however it likes.
 */
export async function runSwarmTask(
  taskGoal: string,
  opts: SwarmOrchestratorOptions
): Promise<{ plan: TaskPlan; planPath: string; elapsedMs: number }> {
  const startedAt = Date.now();
  const entryPath = opts.workerEntryPath ?? process.argv[1];

  opts.onEvent?.({
    kind: "swarm_init",
    task: taskGoal,
    provider: opts.llmConfig.provider,
    model: opts.llmConfig.model,
    searchProvider: opts.searchProvider,
  });

  const plan = await generatePlan(opts.llmConfig, taskGoal);
  opts.onEvent?.({ kind: "plan_drafted", stepCount: plan.steps.length, steps: plan.steps });

  const planPath = getNextPlanPath();
  plan.status = "in_progress";
  persistPlan(planPath, plan);
  opts.onEvent?.({ kind: "plan_saved", planPath });

  for (const step of plan.steps) {
    await runStepWithHealing(plan, step, planPath, opts, entryPath);
  }

  try {
    await finalizeTask(opts.llmConfig, plan, planPath);
  } catch {
    // finalizeTask already has its own fallback scoring; nothing more to do here.
  }

  const elapsedMs = Date.now() - startedAt;
  opts.onEvent?.({ kind: "swarm_done", plan, planPath, elapsedMs });
  return { plan, planPath, elapsedMs };
}
