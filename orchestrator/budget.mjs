// Budget control plane: pessimistic reservation before dispatch.
//
// The failure mode this prevents: an orchestrator fans out N sub-agents in
// parallel and only finds out afterwards what they cost. Here every dispatch
// must reserve its ceiling FIRST; if cap - (spent + reserved) can't cover it,
// the reservation throws and the call never happens. After completion,
// settle() records the actual cost and credits the difference back, so later
// waves get the headroom that earlier tasks didn't use.
//
// All movements are recorded to the decision ledger when one is attached.

export class BudgetExceededError extends Error {
  constructor(msg, details) {
    super(msg);
    this.name = "BudgetExceededError";
    this.details = details;
  }
}

const round = (n) => Math.round(n * 1e6) / 1e6;

// pricing: { "<model-id>": { input, output }, default: { input, output } }
// prices are USD per million tokens.
export function costUsd(usage, model, pricing) {
  const p = pricing[model] ?? pricing.default;
  if (!p) throw new Error(`no pricing for model ${model} and no default`);
  return round(((usage.inputTokens ?? 0) * p.input + (usage.outputTokens ?? 0) * p.output) / 1e6);
}

// Ceiling estimate for one task: full prompt as input plus the worst-case
// output, clamped by the agent's explicit per-task cap when one is set.
export function estimateCeilingUsd({ promptChars = 0, maxOutputTokens = 8192, model, pricing, maxUsdPerTask = null }) {
  const inputTokens = Math.ceil(promptChars / 4); // ~4 chars per token, deliberately generous
  const est = costUsd({ inputTokens, outputTokens: maxOutputTokens }, model, pricing);
  return maxUsdPerTask !== null ? round(Math.min(est, maxUsdPerTask)) : est;
}

export function createBudget({ capUsd, run = null, ledger = null }) {
  if (!(capUsd > 0)) throw new Error("capUsd must be > 0");
  const reservations = new Map(); // id -> ceilingUsd
  const settled = new Map(); // id -> { ceilingUsd, actualUsd, estimated }
  let spentUsd = 0;

  const reservedUsd = () => round([...reservations.values()].reduce((a, b) => a + b, 0));
  const remainingUsd = () => round(capUsd - spentUsd - reservedUsd());

  const record = (action, data, extra = {}) =>
    ledger?.append({ run, actor: "orchestrator", action, data, ...extra });

  return {
    capUsd,

    // Reserve the ceiling before the call happens. Throws BudgetExceededError
    // (fail closed) when the cap cannot cover it.
    reserve(id, ceilingUsd, { causes = [] } = {}) {
      if (reservations.has(id)) throw new Error(`duplicate reservation: ${id}`);
      if (!(ceilingUsd >= 0)) throw new Error(`invalid ceiling for ${id}: ${ceilingUsd}`);
      if (spentUsd + reservedUsd() + ceilingUsd > capUsd) {
        const details = { id, ceilingUsd, capUsd, spentUsd, reservedUsd: reservedUsd(), remainingUsd: remainingUsd() };
        record("budget-reservation-denied", details, { causes });
        throw new BudgetExceededError(
          `budget cap would be exceeded: ${id} needs $${ceilingUsd} but only $${remainingUsd()} of $${capUsd} remains`,
          details
        );
      }
      reservations.set(id, round(ceilingUsd));
      const entry = record("budget-reserved", { id, ceilingUsd: round(ceilingUsd), remainingUsd: remainingUsd() }, { causes });
      return entry ?? { id, ceilingUsd };
    },

    // Release an unused reservation (e.g. wave aborted before dispatch).
    release(id, { causes = [] } = {}) {
      if (!reservations.has(id)) throw new Error(`no reservation to release: ${id}`);
      const ceilingUsd = reservations.get(id);
      reservations.delete(id);
      record("budget-released", { id, ceilingUsd, remainingUsd: remainingUsd() }, { causes });
    },

    // Settle a completed task: move reservation -> actual spend and credit
    // back the difference. `estimated: true` marks costs derived from
    // heuristics rather than reported usage (then we charge the ceiling —
    // pessimistic by construction).
    settle(id, actualUsd, { estimated = false, causes = [] } = {}) {
      if (!reservations.has(id)) throw new Error(`no reservation to settle: ${id}`);
      const ceilingUsd = reservations.get(id);
      reservations.delete(id);
      const charged = estimated ? ceilingUsd : round(actualUsd);
      spentUsd = round(spentUsd + charged);
      settled.set(id, { ceilingUsd, actualUsd: charged, estimated });
      record("budget-settled", {
        id,
        ceilingUsd,
        actualUsd: charged,
        creditedBackUsd: round(ceilingUsd - charged),
        estimated,
        overrun: charged > ceilingUsd,
        spentUsd,
        remainingUsd: remainingUsd(),
      }, { causes });
      return { ceilingUsd, actualUsd: charged, creditedBackUsd: round(ceilingUsd - charged) };
    },

    report() {
      return {
        capUsd,
        spentUsd,
        reservedUsd: reservedUsd(),
        remainingUsd: remainingUsd(),
        tasks: [...settled.entries()].map(([id, s]) => ({ id, ...s })),
      };
    },
  };
}
