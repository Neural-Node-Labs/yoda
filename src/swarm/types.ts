import { LLMConfig, SearchProvider } from "../types";

export interface PlanStep {
  step_id: string;
  step_goal: string;
  step_detailed_requirement: string;
  step_validation: string;
  step_status: "pending" | "in_progress" | "completed" | "failed";
}

export interface TaskPlan {
  task_goal: string;
  timestamp: string;
  status: "planning" | "in_progress" | "completed" | "failed";
  task_validation: string;
  llm_score: number | null;
  steps: PlanStep[];
}

export interface StepResult {
  status: "completed" | "failed";
  summary: string;
  iterations: number;
  isolated: boolean;
}

export interface SwarmAssignment {
  step: PlanStep;
  taskGoal: string;
  priorFailureContext?: string;
  maxIterations: number;
  llmConfig: LLMConfig;
  searchProvider: SearchProvider;
  cwd: string;
}

export interface SwarmOrchestratorOptions {
  stepTimeoutMs: number;
  maxRetries: number;
  maxIterations: number;
  llmConfig: LLMConfig;
  searchProvider: SearchProvider;
  cwd?: string;
  /** Path to the entry script fork() should re-execute as an isolated worker. Defaults to process.argv[1]. */
  workerEntryPath?: string;
  onEvent?: (event: any) => void;
}
