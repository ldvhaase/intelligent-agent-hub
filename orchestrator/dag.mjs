// Wave scheduler: turn per-service tasks with dependsOn edges into
// topological "waves". Every task in a wave has all its in-story
// dependencies satisfied by earlier waves, so a wave can run fully in
// parallel. Dependencies pointing outside the task set are ignored
// (they're external services, not work items). Cycles are returned, not
// hidden — the orchestrator fails closed on them.

export function computeWaves(tasks) {
  const ids = new Set(tasks.map((t) => t.service));
  const deps = new Map(
    tasks.map((t) => [t.service, (t.dependsOn ?? []).filter((d) => ids.has(d) && d !== t.service)])
  );

  const waves = [];
  const done = new Set();
  let remaining = new Set(ids);
  while (remaining.size) {
    const ready = [...remaining].filter((id) => deps.get(id).every((d) => done.has(d))).sort();
    if (!ready.length) break; // cycle among whatever is left
    waves.push(ready);
    for (const id of ready) {
      done.add(id);
      remaining.delete(id);
    }
  }
  return { waves, cyclic: [...remaining].sort() };
}

// Given completed/failed sets, which tasks are permanently blocked because an
// upstream dependency failed?
export function blockedBy(tasks, failed) {
  const ids = new Set(tasks.map((t) => t.service));
  const deps = new Map(tasks.map((t) => [t.service, (t.dependsOn ?? []).filter((d) => ids.has(d))]));
  const blocked = new Map(); // service -> failing dependency
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tasks) {
      if (blocked.has(t.service) || failed.has(t.service)) continue;
      const bad = deps.get(t.service).find((d) => failed.has(d) || blocked.has(d));
      if (bad) {
        blocked.set(t.service, bad);
        changed = true;
      }
    }
  }
  return blocked;
}

// Minimal concurrency limiter for wave execution.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
