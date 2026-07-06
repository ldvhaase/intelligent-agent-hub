// Model registry: per-(agent, model-version) quality snapshots and drift
// assessment.
//
// The problem this solves: platforms silently substitute the model behind an
// identical prompt (plan-tier swaps, deprecation rollovers). A CI eval that
// only gates on prompt/code changes never sees it. Here every eval run is
// keyed by (agent, OBSERVED model id), pins record which model each agent is
// supposed to be on, and assessDrift turns "who answered, and how well" into
// a gate decision.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const baselineKey = (agentId, model) => `${agentId}::${model}`;

export function loadBaselines(path) {
  if (!existsSync(path)) return { pins: {}, baselines: {} };
  const data = JSON.parse(readFileSync(path, "utf8"));
  return { pins: data.pins ?? {}, baselines: data.baselines ?? {} };
}

export function saveBaselines(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

// Score one probe output against its checks. Returns { score, results }.
// score is the fraction of checks passed (1.0 = all pass).
export function scoreOutput(output, checks) {
  const results = checks.map((check) => {
    let pass;
    switch (check.type) {
      case "must-contain":
        pass = output.includes(check.value);
        break;
      case "must-not-contain":
        pass = !output.includes(check.value);
        break;
      case "matches":
        pass = new RegExp(check.value, "m").test(output);
        break;
      case "min-chars":
        pass = output.length >= check.value;
        break;
      case "max-chars":
        pass = output.length <= check.value;
        break;
      default:
        throw new Error(`unknown check type: ${check.type}`);
    }
    return { ...check, pass };
  });
  const score = results.length ? results.filter((r) => r.pass).length / results.length : 1;
  return { score: Math.round(score * 1000) / 1000, results };
}

// Turn an eval run into a gate decision.
//
//   pin            model this agent is pinned to (null = never pinned)
//   observedModel  model the platform actually answered with
//   score          this run's mean probe score
//   baselines      { "<agent>::<model>": { score, ... } }
//
// Statuses (gate = should CI fail):
//   ok               same model, score within threshold of its baseline
//   drift            same model, score dropped beyond threshold  -> fail
//   no-baseline      same model but nothing recorded yet         -> fail (record first)
//   swap-detected    model != pin                                -> fail when failOnSwap,
//                    else fail only if score dropped vs the PIN's baseline
export function assessDrift({ agentId, pin, observedModel, score, baselines, driftThreshold = 0.05, failOnSwap = true }) {
  const swapped = pin !== null && observedModel !== pin;
  const reference = swapped
    ? baselines[baselineKey(agentId, pin)] ?? null // compare against the quality we HAD
    : baselines[baselineKey(agentId, observedModel)] ?? null;
  const baselineScore = reference?.score ?? null;
  const delta = baselineScore === null ? null : Math.round((score - baselineScore) * 1000) / 1000;
  const dropped = delta !== null && delta < -driftThreshold;

  if (!swapped) {
    if (baselineScore === null) {
      return { status: "no-baseline", gate: true, swapped, baselineScore, delta,
        reason: `no baseline recorded for ${baselineKey(agentId, observedModel)}; run with --record to establish one` };
    }
    return dropped
      ? { status: "drift", gate: true, swapped, baselineScore, delta,
          reason: `score dropped ${delta} vs baseline ${baselineScore} (threshold ${driftThreshold})` }
      : { status: "ok", gate: false, swapped, baselineScore, delta, reason: "within threshold of baseline" };
  }

  // The platform answered with a different model than the pin.
  const swapMsg = `model swap detected: pinned ${pin}, platform answered with ${observedModel}`;
  if (dropped) {
    return { status: "swap-detected", gate: true, swapped, baselineScore, delta,
      reason: `${swapMsg}; quality dropped ${delta} vs ${pin} baseline ${baselineScore}` };
  }
  if (baselineScore === null) {
    return { status: "swap-detected", gate: true, swapped, baselineScore, delta,
      reason: `${swapMsg}; no ${pin} baseline to compare against` };
  }
  return {
    status: "swap-detected",
    gate: failOnSwap,
    swapped,
    baselineScore,
    delta,
    reason: `${swapMsg}; quality holds (delta ${delta}); ${failOnSwap ? "failing closed — re-pin with --accept after review" : "warning only (failOnSwap disabled)"}`,
  };
}
