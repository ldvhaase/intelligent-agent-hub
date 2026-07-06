// Pluggable agent runners. The orchestrator and eval gate never talk to a
// model provider directly — they hand a prompt to a runner and get back
// { output, model, usage, confidence, estimated }.
//
//   dry-run  deterministic, no network. Echoes the prompt back and reports
//            the agent's pinned model — unless ORCH_SIMULATE_MODEL is set,
//            which simulates the platform silently swapping the model under
//            us (output degrades, observed model differs from the pin).
//            This is how the swap-detection path is exercised end to end.
//
//   cmd      runs a shell command per task (any agent CLI, e.g. `claude -p`).
//            The prompt is written to a file, its path passed via env vars;
//            stdout is the output. The command may write TASK_RESULT_PATH as
//            JSON {model, usage:{inputTokens,outputTokens}, confidence} —
//            without it usage is estimated from character counts and the
//            budget charges the full reserved ceiling (pessimistic).

import { exec } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const approxTokens = (chars) => Math.ceil(chars / 4);

// Deterministic degradation used when a swap is simulated: keep only the
// first 40% of the output, the shape of a quietly-worse model.
export function degradeOutput(text) {
  return text.slice(0, Math.floor(text.length * 0.4));
}

function dryRunRunner() {
  return async ({ taskId, agentId, agent, prompt }) => {
    const model = process.env.ORCH_SIMULATE_MODEL || agent.pinnedModel;
    const swapped = model !== agent.pinnedModel;
    let output = [
      `[dry-run] agent=${agentId} model=${model}`,
      "",
      "Echo of task input follows.",
      "",
      prompt,
    ].join("\n");
    if (swapped) output = degradeOutput(output);
    return {
      output,
      model,
      usage: { inputTokens: approxTokens(prompt.length), outputTokens: approxTokens(output.length) },
      confidence: swapped ? 0.5 : 0.95,
      estimated: false,
    };
  };
}

function cmdRunner(cmd) {
  return async ({ taskId, agentId, agent, prompt, workDir }) => {
    mkdirSync(workDir, { recursive: true });
    const promptPath = join(workDir, `${taskId}.prompt.md`);
    const resultPath = join(workDir, `${taskId}.result.json`);
    writeFileSync(promptPath, prompt);

    const { stdout } = await execAsync(cmd, {
      env: {
        ...process.env,
        TASK_ID: taskId,
        TASK_AGENT: agentId,
        TASK_MODEL_PIN: agent.pinnedModel,
        TASK_PROMPT_PATH: promptPath,
        TASK_RESULT_PATH: resultPath,
      },
      maxBuffer: 64 * 1024 * 1024,
    });

    const output = stdout;
    if (existsSync(resultPath)) {
      const r = JSON.parse(readFileSync(resultPath, "utf8"));
      return {
        output,
        model: r.model ?? agent.pinnedModel,
        usage: {
          inputTokens: r.usage?.inputTokens ?? approxTokens(prompt.length),
          outputTokens: r.usage?.outputTokens ?? approxTokens(output.length),
        },
        confidence: r.confidence ?? null,
        estimated: !r.usage,
      };
    }
    // No structured result: model unverifiable, usage estimated. Callers
    // treat estimated=true pessimistically (charge the reserved ceiling).
    return {
      output,
      model: null,
      usage: { inputTokens: approxTokens(prompt.length), outputTokens: approxTokens(output.length) },
      confidence: null,
      estimated: true,
    };
  };
}

export function createRunner({ type = "dry-run", cmd = null } = {}) {
  if (type === "dry-run") return dryRunRunner();
  if (type === "cmd") {
    if (!cmd) throw new Error("cmd runner requires --cmd");
    return cmdRunner(cmd);
  }
  throw new Error(`unknown runner type: ${type} (expected dry-run or cmd)`);
}
