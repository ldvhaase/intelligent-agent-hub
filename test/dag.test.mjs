import assert from "node:assert/strict";
import test from "node:test";
import { blockedBy, computeWaves, mapLimit } from "../orchestrator/dag.mjs";

test("independent tasks form a single parallel wave", () => {
  const { waves, cyclic } = computeWaves([{ service: "a" }, { service: "b" }, { service: "c" }]);
  assert.deepEqual(waves, [["a", "b", "c"]]);
  assert.deepEqual(cyclic, []);
});

test("dependsOn produces topological waves (callees first)", () => {
  const tasks = [
    { service: "rider", dependsOn: ["pricing"] },
    { service: "pricing", dependsOn: [] },
    { service: "notify", dependsOn: ["pricing"] },
    { service: "gateway", dependsOn: ["rider", "notify"] },
  ];
  const { waves } = computeWaves(tasks);
  assert.deepEqual(waves, [["pricing"], ["notify", "rider"], ["gateway"]]);
});

test("dependencies outside the task set are ignored", () => {
  const { waves } = computeWaves([{ service: "a", dependsOn: ["external-thing", "a"] }]);
  assert.deepEqual(waves, [["a"]]);
});

test("cycles are reported, not hidden", () => {
  const { waves, cyclic } = computeWaves([
    { service: "a", dependsOn: ["b"] },
    { service: "b", dependsOn: ["a"] },
    { service: "c" },
  ]);
  assert.deepEqual(waves, [["c"]]);
  assert.deepEqual(cyclic, ["a", "b"]);
});

test("blockedBy propagates failures transitively", () => {
  const tasks = [
    { service: "a" },
    { service: "b", dependsOn: ["a"] },
    { service: "c", dependsOn: ["b"] },
    { service: "d" },
  ];
  const blocked = blockedBy(tasks, new Set(["a"]));
  assert.equal(blocked.get("b"), "a");
  assert.equal(blocked.get("c"), "b");
  assert.equal(blocked.has("d"), false);
});

test("mapLimit honors the concurrency ceiling", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12]);
  assert.ok(peak <= 2, `peak concurrency ${peak}`);
});
