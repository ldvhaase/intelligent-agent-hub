import assert from "node:assert/strict";
import test from "node:test";
import { BudgetExceededError, costUsd, createBudget, estimateCeilingUsd } from "../orchestrator/budget.mjs";

const pricing = {
  "claude-opus-4-8": { input: 5, output: 25 },
  default: { input: 10, output: 50 },
};

test("costUsd prices per million tokens with default fallback", () => {
  assert.equal(costUsd({ inputTokens: 1_000_000, outputTokens: 100_000 }, "claude-opus-4-8", pricing), 7.5);
  assert.equal(costUsd({ inputTokens: 100_000 }, "some-unknown-model", pricing), 1);
});

test("estimateCeilingUsd clamps to maxUsdPerTask", () => {
  const unclamped = estimateCeilingUsd({ promptChars: 400_000, maxOutputTokens: 8192, model: "claude-opus-4-8", pricing });
  assert.ok(unclamped > 0.5);
  const clamped = estimateCeilingUsd({ promptChars: 400_000, maxOutputTokens: 8192, model: "claude-opus-4-8", pricing, maxUsdPerTask: 0.25 });
  assert.equal(clamped, 0.25);
});

test("reservation beyond the cap fails closed before any spend", () => {
  const budget = createBudget({ capUsd: 1.0 });
  budget.reserve("a", 0.6);
  assert.throws(() => budget.reserve("b", 0.5), BudgetExceededError);
  const r = budget.report();
  assert.equal(r.spentUsd, 0);
  assert.equal(r.reservedUsd, 0.6);
});

test("settle credits back the unused ceiling for later reservations", () => {
  const budget = createBudget({ capUsd: 1.0 });
  budget.reserve("a", 0.6);
  const s = budget.settle("a", 0.1);
  assert.equal(s.creditedBackUsd, 0.5);
  // the credited-back headroom is available again
  budget.reserve("b", 0.85);
  assert.equal(budget.report().remainingUsd, 0.05);
});

test("estimated settlements charge the full ceiling (pessimistic)", () => {
  const budget = createBudget({ capUsd: 1.0 });
  budget.reserve("a", 0.4);
  const s = budget.settle("a", 0.05, { estimated: true });
  assert.equal(s.actualUsd, 0.4);
  assert.equal(budget.report().spentUsd, 0.4);
  assert.equal(budget.report().tasks[0].estimated, true);
});

test("release frees a reservation without spend", () => {
  const budget = createBudget({ capUsd: 1.0 });
  budget.reserve("a", 0.9);
  budget.release("a");
  assert.equal(budget.report().remainingUsd, 1.0);
  budget.reserve("b", 0.9); // does not throw
});

test("duplicate reservations and unknown settlements are rejected", () => {
  const budget = createBudget({ capUsd: 1.0 });
  budget.reserve("a", 0.1);
  assert.throws(() => budget.reserve("a", 0.1), /duplicate/);
  assert.throws(() => budget.settle("nope", 0.1), /no reservation/);
});
