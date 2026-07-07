# agent-hub — instructions for Copilot

This repo orchestrates multi-service work for LLM agents. It consumes a
committed knowledge bundle from the `knowledge-network` wiki and turns user
stories into bounded, auditable per-service tasks. Read `README.md` for the
full picture; these are the rules that always apply.

## Ground rules

- **Facts about services come from the knowledge bundle only.** Use
  `npm run knowledge -- <card|deps|impact|search|context-pack> ...`. Never
  guess a service's APIs, events, or dependencies, and never scrape service
  repos for them.
- **The approval gate is human-only.** Never set `approved: true` in any
  `stories/*/service-tasks.yaml` and never run `hub approve` on a user's
  behalf without their explicit instruction naming the story.
- **Never edit generated or append-only artifacts by hand**: anything under
  `stories/` (regenerate via the planner), `stories/*/ledger.jsonl`
  (hash-chained; edits are tamper), `evals/baselines.json` (written by
  `eval-gate --record/--accept` only), service cards/bundles in the wiki.
- **Fail closed is intentional.** Budget aborts, model-swap halts, and
  `no-baseline` eval failures are controls doing their job — surface them to
  the human; do not work around them.
- Config lives in `agent-hub.config.yaml` (paths, default runner) and
  `orchestrator/config.yaml` (model pins, budgets, pricing). Prefer editing
  those over hardcoding paths or model IDs.

## The task flow (one command surface)

```
npm run hub -- plan --title "..." --story "..."   # story -> plan + context packs
npm run hub -- status                              # where is every story in the pipeline
npm run hub -- approve --story <slug> --all        # HUMAN records approval (ledger entry)
npm run hub -- execute --story <slug>              # branches + TASK.md briefings in service repos
npm run hub -- orchestrate --story <slug>          # parallel agent run (budget/ledger/handoff/model controls)
npm run hub -- ledger verify --story <slug>        # audit trail
npm test                                           # node --test suite
```

## Custom agents in this repo (`.github/agents/`)

| Agent | Use for |
| --- | --- |
| `planner` | Turning a story into a plan and briefing the human reviewer |
| `implementer` | Executing one `.story/<slug>/TASK.md` briefing on a story branch |
| `reviewer` | Reviewing a story-branch diff for contract/scope/merge-order issues |
| `ledger-auditor` | Compliance review of ledgers, run reports, budgets |

Pick the matching agent instead of doing its job ad hoc — their prompts encode
the handoff output format and the controls above. The orchestrator invokes the
same agents programmatically via `orchestrator/adapters/copilot.mjs`.
