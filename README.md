# agent-hub

Agent orchestration for the platform. Consumes the knowledge bundle produced by the [`knowledge-network`](../knowledge-network) wiki repo and turns it into:

- **compact context packs** for agent tasks (token-budgeted, source-backed)
- **blast-radius / impact analysis** across services
- **story plans** that decompose a user story into per-service tasks with merge-order guidance
- **story execution**: one service, one bounded task, one branch, one (draft) PR — behind a human approval gate
- **orchestrated runs**: approved tasks executed as a parallel DAG with four controls around every dispatch — pre-dispatch budget reservation, a hash-chained decision ledger, compacted handoffs between stages, and model-swap detection
- **audit logging**: append-only JSONL metering of token usage, cost, and outcomes per request

Agents never scrape the Docusaurus site or re-analyze service repos: everything is answered from the wiki's `knowledge/` bundle through the client in this repo.

## Setup

```bash
npm install
```

The client locates the wiki checkout via `KNOWLEDGE_WIKI_PATH` (default: `../knowledge-network`). All commands read the **committed** bundle there — refresh the wiki first if it is stale (`npm run knowledge:refresh-all` in the wiki repo, or the automated dispatch flow).

## Repository layout

| Path | Contents |
| --- | --- |
| `knowledge-client/client.mjs` | Library: typed accessors over the bundle (see API below) |
| `knowledge-client/cli.mjs` | CLI wrapper (`npm run knowledge -- …`) |
| `story-planner/plan-story.mjs` | Story → per-service plan + context packs |
| `story-planner/execute-story.mjs` | Approved plan → branches + task briefings in service repos |
| `orchestrator/orchestrate.mjs` | Approved tasks → parallel DAG run behind budget/ledger/handoff/model controls |
| `orchestrator/eval-gate.mjs` | Model-swap regression gate for CI (per agent × observed model) |
| `orchestrator/ledger-cli.mjs` | Verify / inspect / trace / override the decision ledger |
| `orchestrator/config.yaml` | Agent model pins, per-task cost caps, pricing, thresholds (committed) |
| `evals/probes/*.yaml` | Deterministic probes scored per (agent, model-version) pair |
| `evals/baselines.json` | Model pins + recorded baseline scores (committed) |
| `audit/audit-log.mjs` | Lightweight append-only JSONL audit logger (`audit()` + helpers) |
| `audit/cost-catalog.json` | Per-model token pricing for audit cost estimates (edit to add real rates) |
| `audit/audit-summary.mjs` | Reads the audit log and prints token / cost / outcome totals |
| `.audit/audit.jsonl` | Runtime audit log — created on first write, gitignored |
| `stories/` | Planner/executor/orchestrator working output (gitignored) |
| `test/` | `node --test` suite for the orchestration modules |
| `.github/workflows/request-knowledge-refresh.yml` | Reusable workflow service repos call to request a wiki refresh |
| `.github/workflows/model-regression.yml` | Scheduled CI job running tests + the eval gate |

## Knowledge client

### CLI

```bash
npm run knowledge -- <command> [args]
```

| Command | Returns |
| --- | --- |
| `manifest` | bundle version + indexed services |
| `get-service <id>` | merged export summary |
| `card <id>` | service card markdown |
| `deps <id>` | outgoing + reverse dependencies |
| `apis <id>` | REST APIs |
| `events <id>` | published/consumed events |
| `datastores <id>` | datastores |
| `impact <id>` | blast radius (transitive callers ∪ consumers of published events) |
| `search <query>` | top matching RAG chunks (keyword-scored) |
| `context-pack --service <id> --task "<task>"` | compact context pack |

### Library API (`knowledge-client/client.mjs`)

- `getManifest()`, `getServiceCard(id)`, `getServiceExport(id)`
- `getApis(id)`, `getEvents(id)`, `getDatastores(id)`
- `getDependencies(id)` / `getReverseDependencies(id)` — from graph edges, so reverse lookups are free
- `getBlastRadius(id)` — BFS over reverse CALLS edges plus event pub/sub coupling
- `searchChunks(query, limit)` — keyword scoring over `bundle/chunks.jsonl`
- `buildContextPack({ service, task })` — budgeted pack: **1 service card + up to 10 graph edges + up to 5 relevant chunks** (excluding chunks that duplicate the service's own card), stamped with bundle version and provenance (`repo @ commit (branch)`)

Context packs are the unit agents should receive: enough to work on one service-scoped task without loading whole repos.

## Story planner

```bash
npm run plan-story -- --title "Surge pricing on fare estimates" \
  --story "pricing-service must apply a surge multiplier ... rider-service must display it ..." \
  [--services pricing-service,rider-service] [--out dir]
```

Deterministic pipeline (no LLM calls):

1. **Candidate services** = explicit `--services` + literal service-id mentions in the story + services whose chunks match the story text
2. **Impact expansion** via `getBlastRadius` per candidate
3. **Merge order** = topological sort of CALLS edges (callees first; cycles flagged rather than hidden)
4. **Event contract pairs** — publisher/consumer couples relevant to the story

Output in `stories/<slug>/`:

| File | Purpose |
| --- | --- |
| `story.yaml` | title, story, slug, bundle version, services |
| `impact-analysis.md` | per-service blast radius + event contracts — **the thing a human reviews** |
| `implementation-plan.md` | merge-order guidance |
| `service-tasks.yaml` | one task per service, `status: proposed`, **`approved: false`** |
| `context-packs/<service>.md` | ready-to-inject pack per task |

## Story executor

```bash
npm run execute-story -- --story <slug> [--repos-root dir] [--push] [--dry-run]
```

`--repos-root` defaults to this repo's parent directory, expecting checkouts at `<repos-root>/<service>`.

### Human approval gate

The executor only touches tasks with `approved: true` **and** `status: proposed`. Fresh plans are entirely `approved: false`, so nothing runs until a human reviews `impact-analysis.md` and flips the flag per task. Re-running an executed story is refused (`status` is no longer `proposed`).

### Validate everything, then mutate

Before touching **any** repo, every approved task is validated:

- checkout exists at `<repos-root>/<service>` (has `.git`)
- worktree is clean (`git status --porcelain`)
- story branch does not already exist
- context pack file exists

Any failure aborts the whole run: *"preconditions failed; no repositories were modified"*.

### Per task (in merge order)

1. Record the current branch + `HEAD` (base commit)
2. `git checkout -b story/<slug>/<service>`
3. Commit `.story/<slug>/TASK.md` — the full briefing: task, story, service, branch, base commit, bundle version, and the entire context pack. An agent (or human) picking up the branch has everything in-repo.
4. Check the original branch back out (always, even on failure)
5. With `--push`: `git push -u origin` + `gh pr create --draft`

Afterwards `service-tasks.yaml` is updated in place (`status: branched|pr-opened`, `baseCommit`, `prUrl`) and `execution-report.md` summarizes the run.

## End-to-end example

```bash
# 1. plan
npm run plan-story -- --title "Surge pricing on fare estimates" --story "..."

# 2. human review
#    read stories/surge-pricing-on-fare-estimates/impact-analysis.md
#    set approved: true per task in service-tasks.yaml

# 3. execute (local branches only; add --push for draft PRs)
npm run execute-story -- --story surge-pricing-on-fare-estimates

# result:
#   pricing-service: branch story/.../pricing-service with .story/<slug>/TASK.md
#   rider-service:   branch story/.../rider-service  with .story/<slug>/TASK.md
#   both repos back on main, worktrees clean
#   execution-report.md + statuses written back
```

Merge in the planned order (callees before callers) so contract changes land before their consumers.

## Orchestrator

```bash
npm run orchestrate -- --story <slug> [--runner dry-run|cmd] [--cmd "..."] \
  [--max-parallel N] [--budget-usd X] [--on-swap fail|warn]
```

Runs a planned story's **approved** tasks (same gate as the executor: `approved: true` in `service-tasks.yaml`) as a dependency-ordered DAG. The planner now writes `dependsOn` per task from CALLS edges, so the orchestrator needs only the story directory — tasks whose callees are complete run **in parallel** within a wave (`--max-parallel`, default 4).

Runners are pluggable: `dry-run` (default) is deterministic and offline; `cmd` runs any agent CLI per task — the prompt path arrives in `$TASK_PROMPT_PATH`, stdout is the output, and the command may write `$TASK_RESULT_PATH` as `{"model": "...", "usage": {"inputTokens": n, "outputTokens": n}, "confidence": x}`. Without a result file, usage is estimated and the budget charges the full reserved ceiling (pessimistic). See [Connecting a real agentic system](#connecting-a-real-agentic-system) for step-by-step Claude/Copilot/Codex adapters.

Each run writes `stories/<slug>/runs/<runId>/` with per-task outputs, handoffs, `orchestration-report.md` and `budget-report.md`, and appends to the story's `ledger.jsonl`.

Four controls wrap every dispatch:

### 1. Budget control plane (spend capped *before* the calls happen)

Every wave is fully reserved before anything is dispatched: per-task ceiling = pessimistic token estimate priced from `orchestrator/config.yaml`, clamped by the agent's `maxUsdPerTask`. If the run cap (`budget.runCapUsd` / `--budget-usd`) can't cover the wave, the reservations are released and the run aborts — *no calls were made*. After each task, `settle()` records the actual cost and credits the unused ceiling back so later waves get the headroom. Failed or unverifiable tasks are charged their full ceiling.

### 2. Decision ledger (`stories/<slug>/ledger.jsonl`)

Append-only, hash-chained JSONL: every dispatch, completion, budget movement, model observation, handoff and human override is an entry with `actor`, `evidence` (context pack, bundle version, prompt hash), `confidence`, and `causes` (hashes of the entries it depended on). Chained hashes make edits and deletions detectable; overrides are appended, never rewritten.

```bash
npm run ledger -- verify   --story <slug>                 # recompute the chain
npm run ledger -- show     --story <slug> [--run id] [--action a]
npm run ledger -- trace    --story <slug> --entry <hash>  # why did the system decide this?
npm run ledger -- override --story <slug> --entry <hash> --by <name> --reason "..."
```

### 3. Context compaction between handoffs

Downstream tasks receive a structured handoff of each dependency's output, not the full transcript. File paths, code symbols, decision lines, contract lines (routes/events), and open questions are preserved **verbatim**; the rest is compressed extractively under a character budget. Deterministic — no LLM in the loop — and the compaction stats land in the ledger.

### 4. Model-swap detection

Each agent has a pinned model (`orchestrator/config.yaml`, superseded by `evals/baselines.json` pins). If a dispatch's observed model differs from the pin, the run records `model-swap-observed` and — under the default `onModelSwap: fail` — halts before the next wave.

## Model-swap regression gate (CI)

```bash
npm run eval-gate                 # score every agent's probes, compare to baselines
npm run eval-gate -- --record     # first run: establish pin + baseline per agent
npm run eval-gate -- --accept     # after review: re-pin to the swapped model
```

Platforms silently substitute the model behind an identical prompt (plan-tier swaps, deprecation rollovers). An eval harness that only gates on code changes never sees it, so this gate snapshots quality per **(agent, observed-model)** pair:

- same model, score within `driftThreshold` of baseline → pass
- same model, score dropped → **fail** (prompt/harness regression)
- observed ≠ pinned model → **fail closed** until a human runs `--accept`, even if quality holds; a drop vs the *pin's* baseline always fails

Probes live in `evals/probes/<agent>.yaml` (prompt + deterministic checks: `must-contain`, `must-not-contain`, `matches`, `min/max-chars`). `.github/workflows/model-regression.yml` runs the gate **on a schedule**, not just on pushes — the thing it watches changes without any commit landing. Set the repo variable `EVAL_RUNNER_CMD` to wire a real agent CLI; without it the deterministic dry-run runner validates the harness. To rehearse a swap locally: `ORCH_SIMULATE_MODEL=claude-opus-4-7 npm run eval-gate`.

## Connecting a real agentic system

The `--runner cmd` contract above is the only integration point, and it's the same one for both the orchestrator and the eval gate: any executable that reads `$TASK_PROMPT_PATH`, prints the task's output to stdout, and optionally writes `$TASK_RESULT_PATH` as `{"model": "...", "usage": {"inputTokens": n, "outputTokens": n}}` works with `--runner cmd --cmd "..."` (orchestrator) and `EVAL_RUNNER_CMD` (CI eval gate). Wiring in Claude, Copilot, or Codex is the same five steps each time:

1. install and authenticate the CLI
2. write an adapter script that reads `$TASK_PROMPT_PATH`, invokes the CLI, and prints only the final answer to stdout
3. have the adapter write `$TASK_RESULT_PATH` with whatever usage/model info the CLI actually reports — **never fabricate a `model` value**; omit the field if the CLI doesn't expose one, so `modelVerified` stays honestly `false` instead of a false pass
4. point the relevant agent's `pinnedModel` in `orchestrator/config.yaml` at what that CLI actually reports (a real model ID) or a label you control (if it doesn't report one)
5. run `orchestrate`/`eval-gate` with `--runner cmd --cmd "<path to your script>"`

Save each script under `orchestrator/adapters/<system>.sh` and `chmod +x` it (the directory isn't created by default — `mkdir -p orchestrator/adapters` first).

### Claude

1. **Install & auth** — install Claude Code (`npm install -g @anthropic-ai/claude-code`, or your platform's installer), then run `claude` once and complete `/login`, or set `ANTHROPIC_API_KEY`.
2. **Adapter script** (`orchestrator/adapters/claude.sh`) — Claude Code's headless mode (`-p`/`--print`) takes a prompt and, with `--output-format json`, returns one JSON object on stdout carrying the final text plus cost/usage. Exact field names have shifted across CLI releases, so confirm them once for your installed version — `claude -p "hi" --output-format json | jq` — before trusting the paths below:

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   prompt="$(cat "$TASK_PROMPT_PATH")"
   raw="$(claude -p "$prompt" --model "$TASK_MODEL_PIN" --output-format json)"

   echo "$raw" | jq -r '.result // .message // empty'   # -> task output on stdout

   echo "$raw" | jq \
     '{model: (.model // env.TASK_MODEL_PIN),
       usage: {inputTokens: (.usage.input_tokens // 0),
               outputTokens: (.usage.output_tokens // 0)}}' \
     > "$TASK_RESULT_PATH"
   ```
3. **Pin** — `orchestrator/config.yaml`'s agent pins are already Anthropic model IDs (`claude-opus-4-8`, etc.), so nothing to change unless an agent should route through a different Claude tier.
4. **Run**:
   ```bash
   npm run orchestrate -- --story <slug> --runner cmd --cmd "orchestrator/adapters/claude.sh"
   npm run eval-gate    -- --runner cmd --cmd "orchestrator/adapters/claude.sh"
   ```
5. **Swap-detection note** — passing `--model "$TASK_MODEL_PIN"` explicitly means Claude Code answers with that exact model or errors outright; it isn't the opaque per-tier routing this layer was built to catch. Leaving the swap detector on here still catches wrapper bugs (wrong ID, stale CLI) — the real payoff is on the next two systems.

### GitHub Copilot

1. **Install & auth** — `npm install -g @github/copilot` (Homebrew/WinGet/install-script variants also exist); run `copilot` and complete `/login`, or authenticate with a fine-grained PAT scoped to "Copilot Requests".
2. **Adapter script** — as of this writing, GitHub does not publicly document a non-interactive/scripted invocation, nor a way to read back which underlying model actually served a request (model choice is the interactive `/model` slash command). Confirm what your installed version supports before wiring anything in:
   ```bash
   copilot --help   # look for a print/prompt/stdin-style flag
   ```
   This is precisely the silent-substitution scenario the model-swap layer exists for — GitHub's own docs describe per-plan-tier model routing with no confirmed way to observe it from the CLI. Once you've found the real invocation, adapt this stub without inventing a `model` value:
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   prompt="$(cat "$TASK_PROMPT_PATH")"
   output="$(copilot --REPLACE-WITH-CONFIRMED-FLAG "$prompt")"   # confirm against --help first
   echo "$output"
   # Copilot does not confirm-report usage/model -> omit "model", estimate tokens.
   jq -n --arg out "$output" \
     '{usage: {inputTokens: (($out | length) / 4 | floor), outputTokens: (($out | length) / 4 | floor)}}' \
     > "$TASK_RESULT_PATH"
   ```
3. **Pin** — set the agent's `pinnedModel` in `orchestrator/config.yaml` to a label you control (e.g. `copilot-default`), not a real model ID — Copilot doesn't echo one back, so this is bookkeeping, not verification.
4. **Run**: same two commands as Claude, pointed at the Copilot adapter.
5. **Swap-detection note** — expect `modelVerified: false` on every dispatch through this adapter; that's the harness correctly refusing to assert something it can't confirm, not a bug. Re-check `copilot --help` periodically in case a future release adds model reporting, at which point step 2's script should populate `model` for real and the swap detector starts doing its actual job here.

### OpenAI Codex

1. **Install & auth** — `curl -fsSL https://chatgpt.com/codex/install.sh | sh` (npm/Homebrew/binary release also available); run `codex` once to sign in, or set `OPENAI_API_KEY`.
2. **Adapter script** — `codex exec` is the confirmed non-interactive entry point: it takes the prompt as an argument (or `-` for stdin), `--json` streams JSONL events (each carrying `type`, `thread_id`, `item`, and sometimes a `usage` object of `input_tokens`/`cached_input_tokens`/`output_tokens`/`reasoning_output_tokens`), and `-o <path>` writes just the final message. Model selection wasn't confirmed in the fetched docs — check `codex exec --help` for a `-m`/`--model`-style flag in your installed version and pass `$TASK_MODEL_PIN` through it if one exists.
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   prompt="$(cat "$TASK_PROMPT_PATH")"
   final="$(mktemp)"
   events="$(mktemp)"
   codex exec "$prompt" --json -o "$final" > "$events"

   cat "$final"   # -> task output on stdout

   usage="$(jq -s '[.[] | select(.usage != null)] | last | .usage // {}' "$events")"
   jq -n --argjson u "$usage" \
     '{usage: {inputTokens: ($u.input_tokens // 0), outputTokens: ($u.output_tokens // 0)}}' \
     > "$TASK_RESULT_PATH"
   ```
   The `--json` stream reports token usage but not which model served the request — same caveat as Copilot: omit `model` rather than guess.
3. **Pin** — same pattern as Copilot: a label pin in `config.yaml` (e.g. `codex-default`) rather than a real model ID, since Codex doesn't confirm-report one.
4. **Run**: same two commands, pointed at the Codex adapter.
5. **Swap-detection note** — identical to Copilot's: `modelVerified: false` is the expected, honest state here, not a harness failure.

### Mixing systems per agent

`config.yaml`'s agents are independent — nothing stops `implementer` running through Claude while `reviewer` runs through Codex. The orchestrator and eval gate each take one `--cmd`, so route per-agent by dispatching on `$TASK_AGENT` inside a top-level adapter:
```bash
#!/usr/bin/env bash
set -euo pipefail
case "$TASK_AGENT" in
  reviewer) exec orchestrator/adapters/codex.sh ;;
  *)        exec orchestrator/adapters/claude.sh ;;
esac
```

## Audit logging

Lightweight, append-only JSONL metering for agent/orchestrator requests — token usage, estimated cost, retrieval volume, artifacts, and outcomes — without a database. It answers "how many tokens did this request use, which agent/phase/model dominated, what did it cost, did it succeed?" One JSON object per line lands in `.audit/audit.jsonl` (created automatically on first write, gitignored).

**This is metering, distinct from the [decision ledger](#2-decision-ledger-storiesslugledgerjsonl).** The ledger is the tamper-evident *accountability* record (hash-chained, causal links, one per story); the audit log is disposable *observability* (flat counters, one per repo). Different questions, deliberately separate files.

### Emit events

```js
import { audit, createRequestId, estimateCostUsd } from "./audit/audit-log.mjs";

const requestId = createRequestId("story");

audit({ requestId, eventType: "request_started", requestType: "story_plan", status: "started",
        metadata: { userStoryId: "US-1234" } });

audit({ requestId, eventType: "llm_call", agent: "story-orchestrator", phase: "impact-analysis",
        model: "gpt-5.5-thinking", status: "success",
        inputTokens: 5200, outputTokens: 1800, totalTokens: 7000,
        estimatedCostUsd: estimateCostUsd({ model: "gpt-5.5-thinking", inputTokens: 5200, outputTokens: 1800 }) });

audit({ requestId, eventType: "request_completed", requestType: "story_plan", status: "completed" });
```

Event types: `request_started`, `tool_call`, `llm_call`, `artifact_created`, `request_completed`, `request_failed`. The logger auto-stamps an ISO timestamp and fills `totalTokens` when absent. **It never stores prompts or responses** — record hashes, artifact paths, chunk/service/request IDs, and `metadata` instead.

Exports from `audit/audit-log.mjs`:

- `audit(event)` — validate (`requestId`/`eventType`/`status` required), then append one line
- `createRequestId(prefix)` — `prefix_<timestamp>_<random>` correlation id
- `calculateTotalTokens(event)` — explicit `totalTokens`, else input+output+cached+reasoning
- `estimateCostUsd({ model, inputTokens, ... })` — priced from `audit/cost-catalog.json` (edit that file to add real per-1M-token rates; ships at `0`)

### Fail-open by default

Audit failures never crash the caller — they `console.warn` and continue, so metering can't take down a run. Set `AUDIT_STRICT=true` to make failures throw instead (useful in tests).

### Summarize

```bash
npm run audit:summary   # totals: started/completed/failed, LLM & tool calls, tokens,
                        # estimated cost, most expensive request / agent / model
npm run audit:clear     # delete .audit/ (cross-platform)
```

> Not yet auto-emitted by `orchestrate.mjs` — this is the logging library plus its summary CLI. Instrument `runTask()` to emit `llm_call` / `artifact_created` events if you want orchestrated runs to populate the audit log automatically.

## Tests

```bash
npm test   # node --test: ledger chain/tamper, budget reserve/settle, compaction, DAG waves, drift assessment
```

## Keeping knowledge fresh

Service repos call this repo's reusable workflow on pushes to main:

```yaml
jobs:
  request-knowledge-refresh:
    uses: enterprise-org/agent-hub/.github/workflows/request-knowledge-refresh.yml@main
    with:
      service_id: <id>
      wiki_repository: enterprise-org/knowledge-network
    secrets:
      KNOWLEDGE_DISPATCH_TOKEN: ${{ secrets.KNOWLEDGE_DISPATCH_TOKEN }}
```

It sends `repository_dispatch: knowledge-refresh-requested` to the wiki with the exact commit; the wiki scans that ref and opens a knowledge-update PR. `KNOWLEDGE_DISPATCH_TOKEN` must be a PAT — the default `GITHUB_TOKEN` cannot trigger workflows across repos.

## Design principles

- **Bundle-first**: answers come from committed, hash-versioned knowledge — reproducible and reviewable.
- **Bounded units of work**: one service, one task, one branch, one PR.
- **Humans stay in the loop**: plans are proposals; execution requires explicit approval; pushes/PRs are opt-in (`--push`); model swaps and overrides require a named human.
- **Fail closed**: any precondition failure means no repo is modified; any budget or model-pin violation means no dispatch is made.
- **Accountable by construction**: every agent action carries evidence, confidence and causal links in a tamper-evident ledger — reconstructable, auditable, overridable.
