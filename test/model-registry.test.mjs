import assert from "node:assert/strict";
import test from "node:test";
import { assessDrift, baselineKey, scoreOutput } from "../orchestrator/model-registry.mjs";
import { createRunner, degradeOutput } from "../orchestrator/runner.mjs";

test("scoreOutput scores each check type", () => {
  const { score, results } = scoreOutput("hello src/app.mjs world", [
    { type: "must-contain", value: "src/app.mjs" },
    { type: "must-not-contain", value: "panic" },
    { type: "matches", value: "^hello" },
    { type: "min-chars", value: 5 },
    { type: "max-chars", value: 10 }, // fails
  ]);
  assert.equal(score, 0.8);
  assert.equal(results.filter((r) => !r.pass).length, 1);
});

test("same model within threshold passes; beyond threshold fails", () => {
  const baselines = { [baselineKey("implementer", "claude-opus-4-8")]: { score: 0.95 } };
  const common = { agentId: "implementer", pin: "claude-opus-4-8", observedModel: "claude-opus-4-8", baselines, driftThreshold: 0.05 };
  assert.equal(assessDrift({ ...common, score: 0.92 }).gate, false);
  const drift = assessDrift({ ...common, score: 0.7 });
  assert.equal(drift.status, "drift");
  assert.equal(drift.gate, true);
});

test("same model with no baseline fails closed asking for --record", () => {
  const a = assessDrift({ agentId: "x", pin: "m1", observedModel: "m1", score: 1, baselines: {} });
  assert.equal(a.status, "no-baseline");
  assert.equal(a.gate, true);
  assert.match(a.reason, /--record/);
});

test("a silent model swap gates even when quality holds (failOnSwap)", () => {
  const baselines = { [baselineKey("implementer", "claude-opus-4-8")]: { score: 0.9 } };
  const a = assessDrift({
    agentId: "implementer",
    pin: "claude-opus-4-8",
    observedModel: "claude-opus-4-7",
    score: 0.9,
    baselines,
    failOnSwap: true,
  });
  assert.equal(a.status, "swap-detected");
  assert.equal(a.swapped, true);
  assert.equal(a.gate, true);
  assert.match(a.reason, /quality holds/);
});

test("swap with quality drop compares against the PIN's baseline and always gates", () => {
  const baselines = { [baselineKey("implementer", "claude-opus-4-8")]: { score: 0.95 } };
  const a = assessDrift({
    agentId: "implementer",
    pin: "claude-opus-4-8",
    observedModel: "cheap-substitute",
    score: 0.5,
    baselines,
    failOnSwap: false, // even with swaps tolerated, a drop still gates
  });
  assert.equal(a.gate, true);
  assert.ok(a.delta < 0);
});

test("swap with quality holding and failOnSwap disabled warns without gating", () => {
  const baselines = { [baselineKey("implementer", "m-old")]: { score: 0.9 } };
  const a = assessDrift({ agentId: "implementer", pin: "m-old", observedModel: "m-new", score: 0.9, baselines, failOnSwap: false });
  assert.equal(a.status, "swap-detected");
  assert.equal(a.gate, false);
});

test("dry-run runner reports the pin; ORCH_SIMULATE_MODEL simulates the swap with degraded output", async () => {
  const runner = createRunner({ type: "dry-run" });
  const agent = { pinnedModel: "claude-opus-4-8" };
  const base = { taskId: "t", agentId: "implementer", agent, prompt: "keep this token: NEEDLE_AT_THE_END" };

  const normal = await runner(base);
  assert.equal(normal.model, "claude-opus-4-8");
  assert.ok(normal.output.includes("NEEDLE_AT_THE_END"));

  process.env.ORCH_SIMULATE_MODEL = "cheap-substitute";
  try {
    const swapped = await runner(base);
    assert.equal(swapped.model, "cheap-substitute");
    assert.equal(swapped.output, degradeOutput(normal.output.replace("claude-opus-4-8", "cheap-substitute")));
    assert.ok(!swapped.output.includes("NEEDLE_AT_THE_END"), "degraded output should lose late content");
  } finally {
    delete process.env.ORCH_SIMULATE_MODEL;
  }
});
