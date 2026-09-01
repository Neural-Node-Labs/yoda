#!/usr/bin/env node
/**
 * YODA - ReAct Filesystem Agent — CLI entry point.
 *
 * This file is intentionally thin. All real logic lives in src/ as a
 * reusable module (see src/index.ts) that both this CLI and any HTTP API
 * (see api.ts for a minimal example) import from.
 *
 * Run with:
 *   npx tsx yoda.ts --task "some task"
 *
 * Note: this is also the file child_process.fork() re-executes (with
 * --__swarm-worker) to run an isolated swarm sub-agent — see src/cli.ts.
 */
import { main } from "./src/cli";

main();
