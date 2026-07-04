# agent-hub

Agent orchestration for the platform. Consumes the knowledge bundle produced by the [`knowledge-network`](../knowledge-network) wiki repo and turns it into:

- **compact context packs** for agent tasks (token-budgeted, source-backed)
- **blast-radius / impact analysis** across services
- **story plans** that decompose a user story into per-service tasks with merge-order guidance
- **story execution**: one service, one bounded task, one branch, one (draft) PR — behind a human approval gate

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
| `stories/` | Planner/executor working output (gitignored) |
| `.github/workflows/request-knowledge-refresh.yml` | Reusable workflow service repos call to request a wiki refresh |

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
- **Humans stay in the loop**: plans are proposals; execution requires explicit approval; pushes/PRs are opt-in (`--push`).
- **Fail closed**: any precondition failure means no repo is modified.
