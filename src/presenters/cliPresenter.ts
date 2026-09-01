import chalk from "chalk";
import ora, { Ora } from "ora";
import { AgentEvent } from "../types";

type SectionColor = "blue" | "yellow" | "green" | "red" | "magenta";

const SECTION_STYLES: Record<
  SectionColor,
  { label: (s: string) => string; body: (s: string) => string; rule: (s: string) => string }
> = {
  blue: { label: (s) => chalk.bgBlue.black.bold(s), body: (s) => chalk.cyanBright(s), rule: (s) => chalk.blue(s) },
  yellow: { label: (s) => chalk.bgYellow.black.bold(s), body: (s) => chalk.yellowBright(s), rule: (s) => chalk.yellow(s) },
  green: { label: (s) => chalk.bgGreen.black.bold(s), body: (s) => chalk.greenBright(s), rule: (s) => chalk.green(s) },
  red: { label: (s) => chalk.bgRed.white.bold(s), body: (s) => chalk.redBright(s), rule: (s) => chalk.red(s) },
  magenta: { label: (s) => chalk.bgMagenta.white.bold(s), body: (s) => chalk.magentaBright(s), rule: (s) => chalk.magenta(s) },
};

function printSection(kind: string, color: SectionColor, tag: string, body: string): void {
  const style = SECTION_STYLES[color];
  console.log(`${style.label(` ${kind} `)} ${chalk.dim(tag)}`);
  console.log(style.body(body));
  console.log(style.rule("─".repeat(60)));
}

/**
 * Builds an onEvent handler that renders a classic-mode (runYodaTask) event
 * stream to the console with the original chalk/ora look. Kept entirely
 * separate from the core module — an API layer would supply a different
 * handler (e.g. push to an SSE stream, or just collect into an array).
 */
export function createCliPresenter() {
  let stepSpinner: Ora | null = null;
  let toolSpinner: Ora | null = null;

  return function onEvent(event: AgentEvent): void {
    switch (event.kind) {
      case "init":
        console.log(`\n${chalk.cyan.bold("=================== YODA AGENT INIT ===================")}`);
        console.log(`${chalk.yellow.bold("Task: ")}${chalk.white(event.task)}`);
        console.log(
          chalk.dim(`Provider: ${event.provider} | Model: ${event.model} | Search: ${event.searchProvider}`) + "\n"
        );
        break;

      case "step_start":
        stepSpinner = ora({ text: chalk.cyan(`Step ${event.step}: YODA is thinking...`), color: "cyan", spinner: "dots" }).start();
        break;

      case "thought":
        stepSpinner?.succeed(chalk.cyan(`Step ${event.step}: model responded`));
        stepSpinner = null;
        printSection("THOUGHT", "blue", `Step ${event.step}`, event.content);
        break;

      case "recovered_pseudo_tool_call":
        stepSpinner?.succeed(chalk.cyan(`Step ${event.step}: model responded`));
        stepSpinner = null;
        console.log(
          chalk.dim(
            `[Recovered a pseudo tool-call from plain text content: '${event.toolName}'. This model/server isn't ` +
              `emitting structured tool_calls reliably — consider switching providers/models for tool-heavy tasks.]`
          )
        );
        break;

      case "action":
        stepSpinner?.succeed(chalk.cyan(`Step ${event.step}: model responded`));
        stepSpinner = null;
        printSection(
          "ACTION",
          "yellow",
          `Step ${event.step}`,
          `Executing Tool: ${chalk.green.bold(event.tool)}\n${chalk.dim(`Arguments: ${JSON.stringify(event.args)}`)}`
        );
        toolSpinner = ora({ text: chalk.yellow(`Running ${event.tool}...`), color: "yellow", spinner: "dots" }).start();
        break;

      case "observation":
        if (toolSpinner) {
          if (event.isError) toolSpinner.fail(chalk.red(`${event.tool} blocked/failed`));
          else toolSpinner.succeed(chalk.yellow(`${event.tool} finished`));
          toolSpinner = null;
        } else {
          stepSpinner?.succeed(chalk.cyan("model responded"));
          stepSpinner = null;
        }
        printSection("OBSERVATION", event.isError ? "red" : "green", `Step ${event.step}`, event.content);
        break;

      case "validation":
        console.log(
          chalk.cyan(`✓ Validation: score ${event.score}/100, aligned=${event.aligned}`)
        );
        printSection(
          "VALIDATION",
          event.aligned ? "green" : "red",
          `Step ${event.step}`,
          `Score: ${event.score}/100\nAligned: ${event.aligned}` +
            (event.issues.length > 0 ? `\nIssues:\n- ${event.issues.join("\n- ")}` : "")
        );
        break;

      case "validation_exhausted":
        console.log(
          chalk.yellow.bold(
            `\n⚠ Max validation attempts reached — accepting output as-is despite it NOT passing validation ` +
              `(last score: ${event.score}/100). Unresolved issues:\n- ${event.issues.join("\n- ")}\n`
          )
        );
        break;

      case "warning":
        console.log(chalk.yellow(`⚠ ${event.message}`));
        break;

      case "stopped":
        console.log(chalk.red.bold(`\n=================== YODA STOPPED: ${event.reason} ===================`));
        console.log(chalk.red(event.message));
        break;

      case "token_metrics":
        console.log(chalk.gray(`-- Token Metrics (Step ${event.step}): Input=${event.promptTokens}, Output=${event.outputTokens} --`) + "\n");
        break;

      case "final_answer":
        console.log(chalk.green.bold("=================== YODA FINAL ANSWER ==================="));
        console.log(chalk.whiteBright(event.content));
        console.log(`\n${chalk.magenta(`[SESSION TOTAL] Total Prompt: ${event.totalPromptTokens} | Total Output: ${event.totalOutputTokens}`)}\n`);
        break;
    }
  };
}

/** Renders swarm-mode orchestrator events (a looser event shape than classic mode's AgentEvent). */
export function createSwarmCliPresenter() {
  return function onEvent(event: any): void {
    switch (event.kind) {
      case "swarm_init":
        console.log(chalk.cyan.bold("\n=================== YODA SWARM ORCHESTRATOR ==================="));
        console.log(`${chalk.yellow.bold("Task: ")}${chalk.white(event.task)}`);
        console.log(chalk.dim(`Provider: ${event.provider} | Model: ${event.model} | Search: ${event.searchProvider}`) + "\n");
        break;
      case "plan_drafted":
        console.log(chalk.cyan(`Plan drafted with ${event.stepCount} step(s)`));
        console.log(chalk.underline.bold("Strategy:"));
        event.steps.forEach((s: any, i: number) => {
          console.log(`  ${chalk.bold(`${i + 1}.`)} ${chalk.white(s.step_goal)}`);
          console.log(`     ${chalk.dim(s.step_detailed_requirement)}`);
          console.log(`     ${chalk.dim(`Validation: ${s.step_validation}`)}`);
        });
        console.log();
        break;
      case "plan_saved":
        console.log(chalk.dim(`Plan saved to ${event.planPath}\n`));
        break;
      case "step_header":
        console.log(chalk.bold.white(`\n▶ ${event.step_id} — ${event.step_goal}`) + chalk.dim(` (attempt ${event.attempt}/${event.totalAttempts})`));
        break;
      case "swarm_event": {
        const msg = event;
        if (msg.kind === "thought") printSection("THOUGHT", "blue", event.step_id, msg.content);
        else if (msg.kind === "action")
          printSection("ACTION", "yellow", event.step_id, `Executing Tool: ${chalk.green.bold(msg.tool)}\n${chalk.dim(`Arguments: ${JSON.stringify(msg.args)}`)}`);
        else if (msg.kind === "observation") printSection("OBSERVATION", msg.isError ? "red" : "green", event.step_id, msg.content);
        else if (msg.kind === "healing") printSection("HEALING", "magenta", event.step_id, msg.content);
        break;
      }
      case "isolated":
        console.log(chalk.bgRed.white.bold(" ISOLATED ") + " " + chalk.dim(event.step_id));
        console.log(chalk.redBright(event.message));
        console.log(chalk.red("─".repeat(60)));
        break;
      case "healing_notice":
        printSection("HEALING", "magenta", `${event.step_id} · retry ${event.attempt}`, `Previous attempt failed: ${event.reason}\nRe-spawning an isolated swarm agent with corrective context for another attempt.`);
        break;
      case "step_completed":
        console.log(chalk.green(`✓ ${event.step_id} completed — ${event.summary}\n`));
        break;
      case "step_failed":
        console.log(chalk.red(`✗ ${event.step_id} failed after ${event.attempts} attempt(s) — ${event.summary}\n`));
        break;
      case "swarm_done": {
        const plan = event.plan;
        const ok = plan.status === "completed";
        console.log("\n" + (ok ? chalk.bgGreen.black.bold(" TASK COMPLETE ") : chalk.bgRed.white.bold(" TASK FAILED ")));
        console.log(chalk.bold("Goal:       ") + plan.task_goal);
        console.log(chalk.bold("Status:     ") + (ok ? chalk.green(plan.status) : chalk.red(plan.status)));
        console.log(chalk.bold("Validation: ") + plan.task_validation);
        console.log(chalk.bold("LLM Score:  ") + `${plan.llm_score ?? "n/a"}`);
        console.log(chalk.bold("Elapsed:    ") + `${(event.elapsedMs / 1000).toFixed(1)}s`);
        console.log(chalk.bold("Plan file:  ") + event.planPath);
        console.log(chalk.underline("\nSteps:"));
        for (const s of plan.steps) {
          const icon = s.step_status === "completed" ? chalk.green("✓") : s.step_status === "failed" ? chalk.red("✗") : chalk.yellow("•");
          console.log(`  ${icon} ${s.step_id}  ${s.step_goal}  ${chalk.dim(`[${s.step_status}]`)}`);
        }
        console.log();
        break;
      }
    }
  };
}
