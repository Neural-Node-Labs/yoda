import chalk from "chalk";
import minimist from "minimist";
import { runYodaTask, runSwarmTask, runSwarmWorker, resolveLLMConfig, resolveSearchProvider, LLMConfigError } from "./index";
import { createCliPresenter, createSwarmCliPresenter } from "./presenters/cliPresenter";

export function main(): void {
  const argv = minimist(process.argv.slice(2), {
    string: ["task", "mode", "llm", "model", "search"],
    boolean: ["__swarm-worker"],
    alias: { t: "task", m: "mode" },
    default: { mode: "classic" },
  });

  // Hidden internal entry point: this same entry file re-execs itself via
  // child_process.fork() to run a single isolated swarm sub-agent. The
  // worker gets its assignment (including its LLM provider config and
  // search provider) over IPC from the parent orchestrator, not from argv.
  if (argv["__swarm-worker"]) {
    runSwarmWorker();
    return;
  }

  if (!argv.task) {
    console.error("Error: --task <string> is required");
    console.error(
      'Usage: yoda --task "Task prompt" [--mode classic|swarm] [--llm ollama|deepseek|claude|openai|<path/to/config.yaml>] [--model <name>] [--search tavily|serper|brave|duckduckgo] [--step-timeout ms] [--max-retries n] [--max-iterations n]'
    );
    process.exit(1);
  }

  let llmConfig;
  try {
    llmConfig = resolveLLMConfig(argv.llm, argv.model);
  } catch (err: any) {
    if (err instanceof LLMConfigError) {
      console.error(chalk.red(`Error: ${err.message}`));
    } else {
      console.error(chalk.red(`Error: ${err.message ?? err}`));
    }
    process.exit(1);
  }
  const searchProvider = resolveSearchProvider(argv.search);

  if (argv.mode === "swarm") {
    runSwarmTask(argv.task, {
      stepTimeoutMs: Number(argv["step-timeout"] ?? 5 * 60 * 1000),
      maxRetries: Number(argv["max-retries"] ?? 2),
      maxIterations: Number(argv["max-iterations"] ?? 10),
      llmConfig,
      searchProvider,
      onEvent: createSwarmCliPresenter(),
    }).catch((err) => {
      console.error("Fatal error:", err);
      process.exit(1);
    });
  } else {
    runYodaTask(argv.task, {
      llmConfig,
      searchProvider,
      onEvent: createCliPresenter(),
    }).catch((err) => {
      console.error("Fatal error:", err);
      process.exit(1);
    });
  }
}
