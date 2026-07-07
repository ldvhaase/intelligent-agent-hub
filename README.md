# agent-hub

Agent orchestration for the platform. Consumes the knowledge bundle produced by the [`knowledge-network`](../knowledge-network) wiki repo and turns it into:

- **compact context packs** for agent tasks (token-budgeted, source-backed)
- **blast-radius / impact analysis** across services
- **story plans** that decompose a user story into per-service tasks with merge-order guidance
- **story execution**: one service, one bounded task, one branch, one (draft) PR — behind a human approval gate
- **orchestrated runs**: approved tasks executed as a parallel DAG with four controls around every dispatch — pre-dispatch budget reservation, a hash-chained decision ledger, compacted handoffs between stages, and model-swap detection

Agents never scrape the Docusaurus site or re-analyze service repos: everything is answered from the wiki's `knowledge/` bundle through the client in this repo.

## Setup

```bash
npm install
```

Then review [`agent-hub.config.yaml`](agent-hub.config.yaml) — the one file a team edits when adopting this repo. All commands read the **committed** knowledge bundle in the wiki checkout it points at — refresh the wiki first if it is stale (`npm run knowledge:refresh-all` in the wiki repo, or the automated dispatch flow).

## Configuration

Central config lives in `agent-hub.config.yaml` at the repo root (loaded by `lib/project-config.mjs`). Precedence for every value: **env var > config file > built-in default**; relative paths resolve from the agent-hub root, so commands behave the same from any directory.

| Key | Env override | Default | Used by |
| --- | --- | --- | --- |
| `knowledgeWikiPath` | `KNOWLEDGE_WIKI_PATH` | `../knowledge-network` | knowledge client (everything) |
| `reposRoot` | `AGENT_HUB_REPOS_ROOT` | `..` | story executor (service checkouts) |
| `runner.type` / `runner.cmd` | — (`--runner`/`--cmd` flags win) | `dry-run` | orchestrator, eval gate |
| `copilot.bin` / `copilot.extraArgs` | `COPILOT_CLI_BIN` | `copilot` / `["--allow-all"]` | Copilot adapter |

`AGENT_HUB_CONFIG=<path>` points all tooling at an alternate config file — useful for CI or a personal override without touching the committed default. Orchestration policy (model pins, per-task cost caps, pricing, drift thresholds) stays in [`orchestrator/config.yaml`](orchestrator/config.yaml); the split is deliberate: `agent-hub.config.yaml` is *where things are for your team*, `orchestrator/config.yaml` is *what agents are allowed to do*.

## The flow (hub CLI)

`npm run hub` is the single command surface for the whole pipeline — you never need to remember which script does what:

```bash
npm run hub -- plan --title "Surge pricing" --story "pricing-service must ..."   # 1. story -> plan
npm run hub -- status                                                            # 2. where is everything + exact next command
# ... human reads stories/<slug>/impact-analysis.md ...
npm run hub -- approve --story <slug> --all                                      # 3. HUMAN gate (recorded in the ledger)
npm run hub -- orchestrate --story <slug>                                        # 4a. parallel agent run, or:
npm run hub -- execute --story <slug>                                            # 4b. branches + TASK.md briefings
npm run hub -- ledger verify --story <slug>                                      # 5. audit
```

`status` reads every story under `stories/` and prints its stage (planned → approved → orchestrated/branched, including aborted runs and why) plus the exact next command. `approve` is more than a YAML flip: it records **who** approved **which** services as a `human:<name>` entry in the story's hash-chained ledger, so every later dispatch traces back to a named human decision. `plan`/`execute`/`orchestrate`/`eval-gate`/`ledger`/`knowledge` pass through to the underlying tools unchanged.

## GitHub Copilot integration

This repo is set up to run its agent roles as **Copilot custom agents** — the same prompts serve interactive use (VS Code / Copilot CLI / coding agent) and programmatic orchestration.

### Custom agents (`.github/agents/`)

| Agent | Role | Invoked how |
| --- | --- | --- |
| `planner` | Story → plan via `hub plan`; briefs the human reviewer on blast radius, contracts, merge order. Never approves. | `copilot --agent=planner` in this repo |
| `implementer` | Executes one `.story/<slug>/TASK.md` briefing; treats context-pack contracts as authoritative; emits the handoff-compatible summary format (`Decision:`/`Contract:`/`TODO:` lines, backticked symbols) | On a story branch, or by the orchestrator |
| `reviewer` | Reviews a story-branch diff against its briefing: contract violations, scope escapes, merge-order hazards; reports everything with confidence + severity | `copilot --agent=reviewer` on a story branch |
| `ledger-auditor` | Compliance: chain integrity, approval provenance, model accountability, budget discipline, override hygiene | `copilot --agent=ledger-auditor` in this repo |

Two integration details are load-bearing:

- **The implementer's output format is machine-parsed.** Its prompt mandates exactly the line shapes the handoff compactor ([`orchestrator/handoff.mjs`](orchestrator/handoff.mjs)) preserves verbatim — so decisions, contract changes, and open questions survive into downstream agents' prompts uncompressed.
- **The auditor closes the accountability loop.** `hub approve` writes `human:<name>` approval entries; the orchestrator writes dispatch/completion/swap entries; the auditor's checklist (every dispatch traces to a named approval, every override has a reason) reads exactly what the other layers write.

`.github/copilot-instructions.md` gives every Copilot surface the repo-wide rules (bundle-only facts, human-only approval gate, never edit ledgers/generated files, fail-closed is intentional).

### Programmatic dispatch (orchestrator → Copilot)

```
hub orchestrate ──▶ cmd runner ──▶ orchestrator/adapters/copilot.mjs
                                      │  TASK_AGENT ──(config.yaml copilotAgent)──▶ --agent=<name>
                                      ▼
                    copilot --agent=implementer -p "Read <briefing path> ..." --allow-all
```

Enable it once in `agent-hub.config.yaml` (`runner: { type: cmd, cmd: node orchestrator/adapters/copilot.mjs }`); per-run override stays available via `--runner`/`--cmd` flags. Task briefings written by `hub execute` also embed the exact `copilot --agent=... -p "..."` command, so a developer picking up a story branch by hand runs the same agent the orchestrator would.

## Repository layout

| Path | Contents |
| --- | --- |
| `agent-hub.config.yaml` | Central team config: wiki path, repos root, default runner (env-overridable) |
| `hub.mjs` | The flow CLI: `plan` / `status` / `approve` / `execute` / `orchestrate` / `ledger` |
| `lib/project-config.mjs` | Config loader (env > config file > default) |
| `.github/copilot-instructions.md` | Repo-wide Copilot rules (gates, generated files, command surface) |
| `.github/agents/*.agent.md` | Copilot custom agents: `planner`, `implementer`, `reviewer`, `ledger-auditor` |
| `orchestrator/adapters/copilot.mjs` | Cross-platform Copilot CLI adapter for the cmd runner |
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
npm run hub -- plan --title "Surge pricing on fare estimates" --story "..."

# 2. human review + ledger-recorded approval
#    read stories/surge-pricing-on-fare-estimates/impact-analysis.md, then:
npm run hub -- approve --story surge-pricing-on-fare-estimates --all

# 3. execute (local branches only; add --push for draft PRs)
npm run hub -- execute --story surge-pricing-on-fare-estimates

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

### GitHub Copilot (first-class — see [GitHub Copilot integration](#github-copilot-integration))

Copilot is this repo's primary integration and ships committed, not as a stub:

1. **Install & auth** — `npm install -g @github/copilot` (Homebrew/WinGet/install-script variants also exist); run `copilot` and complete `/login`, or authenticate with a fine-grained PAT scoped to "Copilot Requests".
2. **Adapter** — already committed at [`orchestrator/adapters/copilot.mjs`](orchestrator/adapters/copilot.mjs) (cross-platform Node, no bash/jq required). It maps the task's orchestrator agent to a Copilot custom agent (`agents.<id>.copilotAgent` in `orchestrator/config.yaml` → `.github/agents/<name>.agent.md`) and invokes `copilot --agent=<name> -p "<read-the-briefing instruction>" --allow-all`. The briefing is passed by *path*, not inlined — it can exceed argv limits, and the custom agents have file tools. Sanity-check the resolved invocation without calling Copilot: `node orchestrator/adapters/copilot.mjs --check`.
3. **Enable it** — in `agent-hub.config.yaml`: `runner: { type: cmd, cmd: node orchestrator/adapters/copilot.mjs }`. Now plain `npm run hub -- orchestrate --story <slug>` dispatches through Copilot with no flags.
4. **Swap-detection note** — the Copilot CLI reports usage via the interactive `/usage` command but not programmatically, and never reports which underlying model served a request; the adapter therefore deliberately writes **no** result file. The runner charges the full reserved ceiling (pessimistic) and the ledger records `modelVerified: false` — the honest state, not a bug. GitHub's per-plan-tier model routing is exactly the silent-substitution scenario the eval gate exists for, so lean on scheduled `eval-gate` runs (behavioral drift detection) rather than model-id pins for this system.

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
