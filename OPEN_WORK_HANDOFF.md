# OpenWork: implementation plan

Plans that agents break into tasks, claim, build and review, one task at a time.

Project page (planned): https://work.openstuff.dev

## Why this is its own project

OpenWork answers *who works on what, in which order, and is it finished?* OpenUsecase answers
*what should the product do, and do the tests prove it?* They meet at one point: a plan is only
approved when its use cases are, and a task is only finished when its scenarios pass. Everything
else differs: OpenWork has a board, a dependency graph, claims that expire, branches, pull
requests, CI checks and a review queue. Putting that into OpenUsecase would turn a tool with a
one-line promise into a project-management tool, and its trial still has to show its own value on
real work. OpenWork can be that real work.

So OpenWork is separate, and treats the other OpenStuff projects as optional integrations. Each
one is off until an admin connects it, and everything works without them.

| Project | Integration | Why |
|---|---|---|
| [OpenUsecase](https://github.com/openstuff-dev/open-usecase) | **Align** stage; task acceptance; Verify | The plan's use cases are proposed and approved there. Each task lists the scenario IDs it must prove. A task can't be approved while its scenarios are `no evidence` or `failing`. |
| [OpenPurpose](https://github.com/openstuff-dev/open-purpose) | Context for every worker; learnings from reviews | Each claim hands the worker the `get_context` call for the task's paths. A review comment that recurs across tasks becomes a proposed learning, so the next implementer gets it up front. Security paths can come from OpenPurpose scopes. |
| [OpenVersion](https://github.com/openstuff-dev/open-version) | Ship | When the umbrella branch is merged and deployed, OpenWork publishes the release with notes built from the plan. |
| [OpenAnnounce](https://github.com/openstuff-dev/open-announce) | Release news; OpenWork's own maintenance | Through OpenVersion's existing News integration, not a second path. OpenWork also shows OpenAnnounce messages in its own UI, like the other projects. |
| [OpenRelay](https://github.com/openstuff-dev/open-relay) | None | Parcels have nothing to do with this. It's listed so nobody wonders. |
| [openstuff.dev](https://github.com/openstuff-dev/openstuff.dev) | Catalog entry | A card, an icon and a preview, as for every project. |

## The model

### Words

- **Plan**: one feature, from request to release. It owns one **umbrella branch**
  (`work/<plan-id>-<slug>`) cut from the default branch.
- **Task**: one pull request's worth of work inside a plan, with acceptance criteria (scenario IDs),
  expected paths, and the tasks it depends on.
- **Worker**: any agent (Claude, Codex, Gemini, a script) with its own OpenWork token. Every worker
  has an identity, so the server can prove a reviewer is not the author.
- **Claim**: a lease on one piece of work, with an expiry that the worker extends with heartbeats.
  A crashed agent's claim runs out and the work goes back to the queue.
- **Coordinator**: whatever keeps workers running. It can be a person, a script or a long-lived
  agent. It never decides *what* to work on: the server does.

### Plan stages

| Stage | What happens | Leaves when |
|---|---|---|
| Align | The planning agent proposes use cases in OpenUsecase (or, without it, a written goal and acceptance list). | A person approves them. |
| Plan | The planning agent proposes tasks, their dependencies, paths and scenario IDs, then stops. | A person approves the task list. The server creates the umbrella branch. |
| Implement | Workers claim, build, review and rework tasks. | Every task is `approved` and merged into the umbrella branch. |
| Verify | CI runs on the umbrella branch against the default branch; OpenUsecase checks every scenario of the plan. A person reviews the umbrella pull request. | CI is green and the umbrella PR is merged. |
| Ship | Deploy, then publish the release (OpenVersion). | The release is live. |

### Task states

```
blocked ─▶ ready ─▶ in_progress ─▶ in_review ─▶ approved ─▶ merged
                        ▲               │            │
                        │               ▼            ▼
                        └──── changes_requested   security_review ─▶ approved
                                        │
                                        └─▶ escalated (after N rounds, a person decides)
```

- `blocked`: a dependency isn't `merged` yet.
- `ready`: every dependency is merged into the umbrella branch.
- `in_progress`: claimed; the claim holds the worker and the expiry.
- `in_review`: the PR is open against the umbrella branch and CI has run.
- `changes_requested`: a review with at least one **blocking** finding. Non-blocking notes don't
  send a task back.
- `security_review`: see below. Only a person, or a reviewer of another vendor if the admin allows
  it, can leave this state.
- `approved`: the server merges the PR into the umbrella branch (squash), and dependants become
  `ready`.
- `escalated`: review and rework disagreed three times (configurable). A person decides.

### What a worker gets next

A worker never chooses. It calls `claim_next`, and the server returns the first match in this
order, so finishing always beats starting:

1. The oldest task `in_review` that the worker didn't write and hasn't been the last to review.
2. The oldest `changes_requested` task, preferring its original author (it knows the code), then
   anyone, and tasks that block others first.
3. The oldest `ready` task, preferring tasks that unblock the most others.
4. Nothing: the worker is told to end its turn, not to poll.

A worker holds at most one claim. Finishing a claim (`submit_task`, `submit_review`) releases it,
and the worker either calls `claim_next` again or ends, which is what "report back to the main
agent" becomes.

### Security review

The server decides, not an agent's opinion:

- **Rules** an admin sets per project: path globs (`**/auth/**`, `**/migrations/**`,
  `.github/workflows/**`, lockfiles, `Dockerfile`), and optionally OpenPurpose scopes.
- **Flags**: the planner, implementer or reviewer can flag a task. Anyone can raise a flag; only a
  person can lower it.
- The check runs on the PR's **actual** changed files, not the planned ones.

### Ground truth

- CI on GitHub is the source of truth for "green". A worker's "tests pass locally" is a note, not a
  state change. The server reads check runs from webhooks.
- The server, not workers, creates the umbrella branch, merges task PRs and opens the umbrella PR.
  Workers can push only to their own task branches.

## Architecture

The same shape as the other OpenStuff projects, so it shares their operations and conventions.

| Folder | What's in it |
|---|---|
| `apps/server` | Fastify API, MCP server at `/mcp`, GitHub App webhooks, the scheduler (claim expiry, merges), migrations |
| `apps/web` | Angular app on `@openstuff-dev/ui` and `@openstuff-dev/ui-angular`: board, plan page, review queue, settings |
| `packages/contracts` | Types shared by the server and the web app |
| `packages/work` | The `openwork` CLI (`@openstuff-dev/work`): a coordinator loop and CI helpers |
| `site` | work.openstuff.dev |

- Postgres with row-level security per team, like OpenUsecase and OpenVersion.
- A **GitHub App** (not personal tokens) for branches, merges, check runs and webhooks. Azure DevOps
  later, behind the same interface, because OpenPurpose already speaks both.
- Tokens stored as SHA-256 hashes and shown once; integration secrets with AES-256-GCM.
- Every state change is a row in `task_events`, so the board, history and the API read the same log.
- Idempotency keys on every write an agent makes, because agents retry.

## Phases

Each phase ends with something a person can use, and with its own use cases in OpenUsecase (this
project uses OpenUsecase on itself, as OpenUsecase does).

### Phase 0: Decide and set up (1–2 days)

- Settle the open questions at the end of this file.
- Generate the Nx workspace from the OpenStuff toolkit; `npx nx g @openstuff-dev/nx:sync`.
- Register the project in OpenPurpose (`openstuff/open-work`), with scopes for `apps/server/**`,
  `apps/web/**`, `packages/work/**` and `site/**`, and a first glossary (Plan, Task, Worker,
  Claim, Coordinator, Umbrella branch).
- Write the Align use cases for phases 1–2 in OpenUsecase.

**Done when** CI runs `lint stylelint typecheck test build` on an empty app.

### Phase 1: Plans and tasks, no GitHub yet (1 week)

- Teams, members, projects, tokens (person, worker, CI), settings, export and import: copy
  OpenUsecase's patterns.
- Data: `plans`, `tasks`, `task_dependencies`, `claims`, `reviews`, `review_findings`,
  `task_events`.
- MCP tools: `propose_plan`, `revise_plan`, `get_plan`, `claim_next`, `heartbeat`,
  `release_claim`, `submit_task` (with a PR URL typed in by hand), `submit_review`
  (findings with `blocking: true|false`), `get_task`.
- The state machine as a pure module with exhaustive tests; claims expire through the scheduler.
- Web: plan page (approve, ask for changes), board with one column per state, task page with its
  events.
- The server tells an agent the workflow when it connects (as OpenUsecase does), so no project
  instructions are needed.

**Done when** two agents, by hand, can take a three-task plan with one dependency through review
and rework, and a killed agent's claim returns to the queue.

### Phase 2: GitHub (1–2 weeks)

- A GitHub App: installation per team, repository per project.
- On plan approval, the server creates the umbrella branch. On `claim_next` it returns the branch
  to base the work on.
- Webhooks: PR opened against the umbrella branch moves the task to `in_review` once checks
  finish; check runs update the task; a review comment posted by the server mirrors
  `submit_review`.
- Merging: on approval, squash-merge into the umbrella branch, then mark dependants `ready`. On a
  conflict, the task goes back to `changes_requested` with the conflict as a blocking finding.
- The umbrella PR: opened by the server when every task is merged, with the plan as its body.
  Keeps the umbrella branch up to date with the default branch daily, and reports conflicts.
- Workers get no merge rights; branch protection on `work/**` enforces it.

**Done when** a real plan on one of the OpenStuff repositories goes from approval to an umbrella PR
with no hand-copied URLs.

### Phase 3: Independent review and security (1 week)

- Reviewer independence: a review is refused if the reviewer's token wrote any commit on the task
  branch. Workers record their vendor (`claude`, `codex`, `gemini`, …), and an admin can require
  reviews from another vendor.
- Rework limit and `escalated`, with the full thread for the person deciding.
- Security rules per project, the flags, and `security_review` that only a person (or a permitted
  other-vendor reviewer) can leave.
- Web: review queue for people (security and escalations), with ↑/↓ like OpenPurpose's inbox.

**Done when** a task touching `**/auth/**` can't reach `merged` without a person, whatever the
agents say.

### Phase 4: OpenUsecase (1 week)

- Connect an OpenUsecase server in Settings (URL and a token).
- Align stage: `propose_plan` takes use case IDs; the plan waits until they're `approved` there.
- Each task lists scenario IDs. `submit_task` is refused unless the PR body has the OpenUsecase
  line (`Use cases: UC-142`), so `usecase check` works unchanged.
- Approval of a task requires its scenarios to be `passing` on the task branch's CI.
- Verify stage reads the health of every scenario in the plan.

**Done when** a plan's board shows each task's scenarios with their health, and a task with a
failing scenario can't be approved.

### Phase 5: OpenPurpose (3–5 days)

- Connect OpenPurpose in Settings.
- `claim_next` includes the `get_context` call (remote, paths) for the task, and the glossary terms
  in the plan are linked.
- Learnings from reviews: when the same kind of blocking finding shows up in three tasks, the
  server proposes it as a learning in OpenPurpose for a person to approve. Never automatically
  approved.
- Security rules can use OpenPurpose scopes instead of globs.
- Findings: a reviewer's out-of-scope note can be filed with `report_finding` instead of becoming
  rework.

**Done when** a worker starting a task gets the project's rules without the repository's
`AGENTS.md` asking for them.

### Phase 6: The coordinator (1 week)

- `openwork run --workers 3 --agent claude --agent codex`: a loop that starts a fresh agent
  session per claim (`claude -p`, `codex exec`, `gemini`), gives it the worker token and the claim,
  waits, and starts the next. Each session handles one claim, then ends, so context stays small and
  reviewers start cold.
- Cost and time per task, from the sessions, on the task page.
- The same loop works in CI (a scheduled workflow) or on a laptop.

**Done when** a plan of ten tasks finishes with nobody at the keyboard except for plan approval,
security review and the umbrella PR.

### Phase 7: Ship (3–5 days)

- After the umbrella PR merges and the deploy workflow succeeds, publish to OpenVersion with notes
  from the plan (its title, the user-visible use cases), or show the `openversion release` command
  if no deploy token is connected.
- OpenVersion's existing OpenAnnounce integration carries the notes as News. OpenWork adds no
  second path.
- Plan moves to `shipped`.
- OpenWork's own web app uses `@openstuff-dev/version` and `@openstuff-dev/announce`, configured
  through environment variables, like OpenUsecase.

### Phase 8: Polish and launch (1 week)

- The 20 UX details from `.claude/skills/ux-details/SKILL.md`: skeletons on the board, optimistic
  moves with undo toasts for people's actions, ⌘K, tabular numbers on counts and durations, view
  transitions between board and task.
- Phone width and dark mode on the board and review queue.
- Demo seed (a plan at every stage), `docker compose up`, published image, `site/`, and the
  openstuff.dev catalog entry with icon and preview.
- A trial on a real feature, recorded in `docs/trial/` like OpenUsecase's, with criteria fixed in
  advance: review catches real bugs; rework rounds stay under the limit; no task merges red.

## Risks

- **Reviews that always find something.** Agents asked to review tend to produce findings. Only
  blocking findings send work back, and the rework limit stops loops.
- **Plans that are wrong.** A bad task split costs more than any review saves. The Plan stage has
  a person's approval, and `revise_plan` can split or merge tasks mid-way (only tasks not yet
  claimed).
- **Merge conflicts between parallel tasks.** Planned paths let the server avoid handing out two
  `ready` tasks that touch the same files at once; conflicts still become rework.
- **One giant umbrella PR.** The person reviewing it sees each task's PR and review linked from the
  plan, so the umbrella review is about the whole, not every line.
- **Cost.** A fresh session per claim is deliberate, but it isn't free; phase 6 makes the cost
  visible before anyone scales the number of workers.

## Open questions

1. Who approves a plan and the umbrella PR: any member, or a role?
2. May an agent of another vendor stand in for a person in `security_review`, or never?
3. Squash-merge task PRs into the umbrella branch, or keep their commits?
4. Should the board mirror to GitHub Issues/Projects for teams that live there, or stay in
   OpenWork only?
5. Hosted at work.openstuff.app from the start, or self-hosted only until phase 8?
