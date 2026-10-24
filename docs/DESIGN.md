# arc design

arc (Autonomous Research Controller) runs autonomous research campaigns on a Slurm cluster. An AI **worker** does the
research. A deterministic **controller** decides whether and how each experiment runs, and writes everything down. An
optional AI **auditor** checks the work against raw evidence. The human **coordinator** sets the goal and gives the
verdict. One engine serves every project; a campaign is a directory with no code in it.

Everything below follows one split: **the AI decides what to try; plain code decides whether and how it runs.**

Setting up and running a campaign: [quickstart.md](quickstart.md). Why each choice was made:
[decisions.md](decisions.md).

## 1. Roles

| Role | What it is | Does | Runs |
|---|---|---|---|
| **Worker** | Coding agent (Codex or Claude) with full access to its worktree | Edits and commits code, files and withdraws requests, reads results, keeps `findings.md` | One turn at a time, when the controller wakes it |
| **Auditor** (optional) | Second model, read-only | Checks claims, code diffs and finished runs against raw evidence (§8) | On new claims or completed runs, at most every `auditor.every_min` |
| **Controller** | Node process, no AI | Validates, budgets, freezes source, submits, cancels, reconciles, schedules turns, writes status | systemd user service, one tick every 30 s |
| **Coordinator** | The human | Writes the brief, sets budget and deadline, steers, reviews claims, starts and stops | Whenever they look |
| **Assistant** (optional) | Interactive agent session working for the coordinator, using `skills/arc-coordinator` | Reads everything; acts through `arc` commands within the authority the skill grants | Only while the coordinator is in the session |

Only the controller calls the scheduler. Agents act on a campaign through files: the worker through `requests/` and
`withdraw/`, the auditor not at all. No agent touches the controller, arc's code or its systemd units.

## 2. Principles

1. **A campaign is one directory**, on scratch. It holds the definition and all runtime state; the project only gains a
   git worktree and a branch.
2. **One writer per file** (§3).
3. **No state in memory that matters.** Each tick re-reads small files, and turns run in their own systemd units, so
   crash, restart and upgrade are the same safe operation.
4. **Status is recomputed every tick.** Alerts are derived conditions; they clear themselves.
5. **Engine and site are separate.** Cluster policy lives only in a local `site.mjs` (§4) that is never committed.
6. **Every manual operation is a CLI verb.** No reload scripts, no editing state by hand.
7. **Small.** Node ≥ 20, ESM, no npm dependencies, `node:test`.
8. **Code protects the record and the resources; prompts guide the rest.** Code enforces a rule only if breaking it
   would be irreversible, spend real resources or corrupt the record: submission, budget, cancellation scope,
   provenance, immutable requests. How agents think, write and talk is set in `prompts/` and stays visible in `turns/`;
   drift is fixed by editing the prompt, not by adding enforcement. Agents run as the same Unix user, so the files they
   must not write are protected by their prompts and by visibility (git, `events.jsonl`), not by permissions.

## 3. Files and owners

```
~/.config/arc/site.mjs                cluster policy, local (template: templates/site.example.mjs)
~/.config/arc/campaigns/<id>          registry: symlink to the campaign directory
~/.config/arc/locks/<id>.lock         single-instance lock
~/.config/systemd/user/arc@.service   rendered by arc start

<runs_root>/<id>/                     one campaign
  campaign.json brief.md steering.md  coordinator
  control/                            coordinator, through the CLI: STOP, PAUSE_{SUBMISSIONS,WORKER,AUDITOR},
                                      priority.json, reviews.jsonl, reconcile/<request>.json (applied once, renamed)
  requests/<id>.json                  worker, create-only
  withdraw/<id>                       worker or arc withdraw; the content is the reason
  findings.md notes.md blocked.md     worker
  worktree/                           worker: git worktree on branch arc/<id>
  state/                              controller: requests/<id>.json (one record each), turns.json, claims.json,
                                      notified.json
  artifacts/<id>/                     controller (request.json provenance.json study.json source.tar run.sh), then the
                                      job (source/ slurm-<job>.log execution.json and its outputs)
  turns/<role>-NNNN.*, <role>-latest.md   controller and turn runner: prompt, transcript, report, exit record
  events.jsonl                        controller: every transition
  status.json                         controller: rewritten every tick
```

## 4. Configuration

**`campaign.json`** (template `templates/campaign.json`, validated by `src/campaign.mjs`):

- Required: `id`, `repo`, `base_commit`, `gpu_cap` (simultaneous GPUs, pending and held jobs included), `worker`, and
  `deadline`: an ISO time or the literal `"none"`, so it is always a conscious choice.
- A role (`worker`, `auditor`) names an `agent` (`codex` or `claude`) and an exact `model`; a turn that reports a
  different model fails. Optional: `bin` (a wrapper script), `profile`, `effort`, `args`, `env`; the worker's `checkin`
  (cheaper settings for check-ins); the auditor's `every_min`. `advisor` is accepted as the auditor's old name.
- Optional: `job_prefix`, `job_env` (exported in the job under `set -u`, so write `${VAR:-}` for unset variables),
  `evaluator` (§6), `cadence` (§7), `ledger_md`, `study_spool`.

**`brief.md`** states the question, baseline, evaluation, budget and priorities, as predictions and preferences rather
than go/no-go gates (`templates/brief.md`). **`steering.md`** collects dated entries appended by `arc steer`; later
entries supersede earlier ones. Both are read fresh by every turn.

**`site.mjs`** (local, `$ARC_SITE` or `~/.config/arc/site.mjs`):

| Export | Purpose |
|---|---|
| `runs_root`, `path`, `prompt` | Where campaigns live; PATH for turns and jobs; cluster rules shown to both agents |
| `route(request, {campaign, exec})` | sbatch arguments (partition, account, QoS, nodes, CPUs, memory, time, GRES) with a `note`, or `{wait: reason}`. May read live inventory for shared pools |
| `validate(request)` | Throws for shapes the cluster can never run: the request is rejected |
| `forbidden(request)` | Extra commands blocked inside jobs |
| `notify(alert, {campaign, exec})` | Optional; see §10 |

The engine owns `--hold`, `--parsable`, `--no-requeue`, `--job-name`, `--comment`, `--chdir` and `--output`, and
rejects a route that sets them.

## 5. Requests

A request is one file, `requests/<id>.json`, asking for one job: what to run (`source_commit`, `script`), on what
(`gpus`, `cpus`, `mem_gb`, `minutes`, optional `partition`), why (`hypothesis`, `baseline`, `evaluation`,
`data_provenance`, `config_description`, `seed`), what it produces (`expected_outputs`) and in what order (`after`,
`priority`, `supersedes`), plus free-form `ext`. The exact rules live in the `FIELDS` table in `src/request.mjs`, which
generates both the validator and the schema in the worker's prompt; `arc check-request` runs the same checks.

- The file name is the id; ids are never reused; unknown fields are rejected.
- The script must be a regular file committed in `source_commit`, and may not mention `sbatch`, `salloc`, `scancel`,
  `scontrol` or the site's `forbidden` names.
- **Immutable.** On first sight the controller snapshots the request and its hash. Later edits are ignored and raise
  `request_mutated`; a retry or change is a new id.

**Lifecycle.**

```
queued ──admit──▶ submitting ──receipt──▶ submitted ──terminal state──▶ finished
  │  ▲                 │                   (held → released)
  │  └ transient error,│ crash or ambiguous sbatch
  │    retry later,    ▼
  │    same id     uncertain ──exactly one match──▶ submitted
  │                    └─ arc reconcile --adopt <job> | --abandon
  ├─ invalid ──────────▶ rejected
  └─ withdrawn, dependency failed, abandoned ──▶ dropped
```

A submitted request that is withdrawn has its job cancelled and finishes `CANCELLED` (see Withdrawal).

**Errors.**

| Class | Examples | Effect |
|---|---|---|
| Permanent | any validation failure | `rejected`; the id is spent; the worker sees why |
| Transient | git or tar failure or timeout, a release failure, a definite `sbatch: error` | Same state, retried after `min(60, 2^attempts)` minutes, forever |
| Ambiguous | `sbatch` timed out or was killed, or the controller crashed while `submitting` | `uncertain` (see Reconciliation) |

**Admission**, each tick unless STOP, PAUSE_SUBMISSIONS or the deadline applies. Queued requests go in order of
effective priority (an `arc priority` override, else the request's own), then first seen, then id. A request waits for
its retry time and for its `after` dependencies; it is dropped if a dependency was rejected or dropped, or ended other
than `COMPLETED`. If its GPUs don't fit (`reserved + gpus > gpu_cap`) or `site.route` says wait, it waits, and so
does every request of lower priority; requests at the same priority may backfill. `reserved` counts submitting,
uncertain and unfinished submitted requests, plus orphan jobs. Shared pools across campaigns are the site's job, from
live inventory.

**Submission**, in order; each step is idempotent, so a crash anywhere is repaired by the next tick:

1. **Freeze** into `artifacts/<id>/`: `git archive` of the commit, hashes of archive and script, the worktree's
   uncommitted changes (recorded, never run), the evaluator label (§6), `request.json`, `provenance.json`, `run.sh`.
2. **Record intent** (`submitting`).
3. **Submit held**, tagged with the exact token `--comment=arc:<campaign>:<id>` and `--job-name=<prefix>-<id>`.
4. **Record the receipt** (`submitted`, job id).
5. **Record the study**: `study.json` (and a copy in `study_spool`, if set) and a ledger line.
6. **Release.**

Provenance therefore exists before a job can run, and a request is submitted at most once. `run.sh` exports
`ARC_CAMPAIGN`, `ARC_REQUEST_ID`, `ARC_RUN_DIR`, `ARC_SOURCE`, `ARC_SEED` and `job_env`; sets thread counts from
`SLURM_CPUS_PER_TASK`; puts failing shims for the scheduler commands first on PATH; extracts the source on the compute
node, which keeps slow filesystem work out of the tick; runs the script from it; and on exit writes `execution.json`
with the exit code, times and a hash of each expected output.

**Reconciliation**, each tick:

- **Observe.** `sacct` on unfinished jobs; a terminal state finishes the record and writes a ledger line.
- **Adopt.** A `submitting` or `uncertain` request whose token appears exactly once in `squeue` (or whose job name
  appears once in `sacct` since its intent) is adopted, study included; so is a queued request already in the queue,
  which is never submitted twice. Otherwise it stays `uncertain`: its GPUs stay
  reserved, it is never resubmitted, and it blocks only itself until `arc reconcile`.
- **Cancel** withdrawn jobs (below).
- **Release** anything submitted but not yet released.
- **Orphans.** Jobs tagged `arc:<campaign>:` that match no record count against the budget and raise `orphan_job`.

**Withdrawal.** The worker, or `arc withdraw`, writes `withdraw/<id>` with a reason. A queued request is dropped. A
submitted one, pending or running, is cancelled by the controller, only if `squeue` shows its job under its exact
token; it finishes `CANCELLED`, and the reason goes into its record, the events, the ledger and the worker's digest. A
failed cancel is retried after 5 minutes. Requests that depend on it are then dropped. A `submitting` or `uncertain`
request raises `withdraw_uncertain` and waits for `arc reconcile`. When to stop a running job is the worker's judgement
(§8).

## 6. Fair measurement

Provenance shows what ran, not that it was measured fairly; the worker writes both the method and, by default, the code
that scores it. Two layers make unfair measurement visible. They detect rather than prevent, since the worker runs as
the same Unix user.

- **Pinned evaluator (code).** `evaluator: {commit, paths}` pins the evaluation code and split definitions the human
  vetted. At freeze time `git diff --quiet <pin> <commit> -- <paths>` labels the run `unmodified` or `modified` in its
  provenance, study and ledger line. It is a label, not a gate. Headline claims cite unmodified runs; changing the pin
  is the human's decision.
- **Auditor (prompt).** Reads the code diffs for gaming the label cannot see (§8).

## 7. Agent turns

**Execution.** The controller writes `turns/<role>-NNNN.prompt.md`, records the turn as active, then starts it with
`systemd-run --user --unit=arc-<campaign>.<role>-NNNN … arc turn`. Recording first means a crash can never run two
turns at once; campaign ids cannot contain `.`, so `arc-<campaign>.*` matches only this campaign's units. The runner
pipes the prompt into the agent CLI, saves the transcript, and writes the report (`.md`) and the exit record
(`.exit.json`: ok, model, usage, error). Turns are not children of the controller, so a restart never touches them. A
unit that is gone (systemd says inactive or failed) without an exit record is a failed turn.

**Adapters** (`src/agents.mjs`). `codex exec`: the worker gets `danger-full-access` in its worktree, every other role a
read-only sandbox. `claude --print`: the worker gets Bash, Read, Edit, Write, Glob and Grep; every other role gets Read,
Glob, Grep and read-only `git show`, `git diff` and `git log`. Both roles share one credentials home unless a role sets
`env`.

**Cadence.** News is a request accepted, rejected, dropped or finished, or a change to the brief, the steering, the
auditor's report or a review. A job starting to run is not news.

| The worker is woken by | When | Turn |
|---|---|---|
| News | `changed_min` (2) after the last turn started | Full |
| The idle timer: no job active, no news | `idle_min` (20), doubling after each such turn up to `idle_max_min` (240); any other turn resets it | Full |
| The busy timer: jobs running, no news | `busy_min` (60) | Short check-in (`prompts/worker-checkin.md`), optionally with `worker.checkin` settings |
| A failed turn | `min(60, 2^failures)` minutes after it, forever | Full |

After the deadline only news wakes the worker. There are no turn timeouts and no caps. The auditor is due when
`every_min` has passed and there is something it has not yet answered in a successful turn: a live claim without a
valid audit, or a completed run it has not checked (oldest first, at most 20 per turn). The two roles run independently.

**Prompt**, composed fresh every turn and archived: the role protocol from `prompts/` (the worker's includes the
request schema), `site.prompt`, campaign facts (id, budget, deadline, base commit, paths, evaluator pin), the brief, the
steering, and a digest: live status, queue, jobs, recent rejections, alerts, the role's own health, `blocked.md` and
`findings.md` (with a nudge above 150 lines). The worker also gets each claim's audit and review state and the auditor's
latest report; the auditor gets the claims and runs to check, with their evidence, and its own previous report.

## 8. Agent protocols

The prompts in `prompts/` are the source of truth; these are the design commitments they carry.

**Worker** (`prompts/worker.md`):

- Memory is files: `findings.md` is the current best answer, rewritten each turn, with claims in the §9 format and a
  soft limit of 150 lines; `notes.md` is an append-only lab notebook; `blocked.md` tells the human about a blocker and
  stops nothing.
- A step in the brief that can't be carried out, or can't tell the arms apart, never idles the campaign: the worker
  writes `blocked.md`, adopts the most defensible substitute, labels what depends on it exploratory and carries on.
  "Fixed criteria" means criteria are not moved to flatter a result.
- It stops a job through `withdraw/` when steering has superseded it or it is clearly broken, never to avoid a
  disappointing result; a stopped run counts in "Variants tried".
- It ends its turn while waiting for jobs, and commits only on its campaign branch: merging is the human's decision.

**Auditor** (`prompts/auditor.md`) checks the work and never plans it. It reads raw evidence, never the worker's turn
reports, and `notes.md` only for the worker's answers to its points. Three checks:

1. **Claims.** Does the number match the artifact? Same protocol and denominator? Enough seeds for the effect? Evaluator
   unmodified? Is a failed or discarded variant left out in a way that biases the claim? Could test data leak?
2. **Metric gaming** in the code diffs: scoring, filtering or post-processing changed (inside or outside the pinned
   paths), outputs dropped or selected before scoring, failures left out of the denominator, a changed panel, seed,
   sample count or reference set, copied or hard-coded answers, disabled checks, a test panel reused for selection.
3. **Finished runs**: NaN, loss or gradient-norm spikes, a late rise in validation loss, restart or out-of-memory loops,
   code imported from outside `$ARC_SOURCE`, the wrong checkpoint or data, missing outputs. Running jobs belong to the
   worker's check-ins, since the worker is the one who can act.

It answers one line per claim, `C<n>: supported | unsupported | can't tell — <evidence>`, then `Material issues: none`
or a list where each item cites a file, job id or number, then at most one `Suggestion:`, which must fix an issue it
cited. "No material issues" is the expected result: every point costs the worker a turn, so only points that would
change a claim or the next decision count, and none is repeated without new evidence. The worker acts on a point when it
would change the current answer or its next decision, and otherwise declines in one line in `notes.md`. The audit flag
rate in `status.json` is the calibration signal: near 100% means nagging, near 0% over many audits may mean
rubber-stamping.

## 9. Claims and review

Review is per claim, not per job: a finished job says nothing about whether a conclusion is true, and a per-job review
queue does not scale (one legacy notebook reached 15,000 unticked entries). A claim is a block in `findings.md` with a
stable id:

```
### C3 — 2k warmup lowers final val loss by 0.03 ± 0.01 vs 500 steps
Evidence: warmup-2k-seed1..3 vs warmup-500-seed1..3; artifacts/<id>/metrics.json
Evaluator: unmodified
Variants tried: 4
```

Ids are never reused; a retracted claim moves under `## Superseded`. Each tick the controller parses the claims and
hashes each block. Audit verdicts and human reviews bind to that hash. `arc review <id> C3 accept|reject|needs-more
--hash <h> -m "note"` takes the hash shown by `arc claims` and is refused if the claim changed since, so a verdict never
binds to text the human did not read; once the worker edits a claim, its review stops counting. States: `new`,
`audited`, `reviewed:accept|reject|needs-more`, `stale`, `superseded`. Only the human writes reviews, by convention.

## 10. Status, ledger and alerts

- **`status.json`** (schema `arc.status/2`) is rebuilt every tick with every key present: controller (pid, version,
  heartbeat, phase), deadline, budget, counts, the queue with what each request waits for, active and recent jobs, each
  role's health and next turn, `blocked`, claim counts and alerts. `arc status` reports the controller as dead if the
  heartbeat is older than 3 minutes.
- **`events.jsonl`** records every transition. If `ledger_md` is set, one plain line per submission and per finish is
  appended to it; point it at a file only arc writes.
- **Alerts** are derived each tick and clear themselves:

| Code | Raised when |
|---|---|
| `uncertain_submission` | A submission's outcome is unknown; its GPUs stay reserved until it is resolved |
| `orphan_job` | A campaign-tagged job matches no record; its GPUs count against the budget |
| `request_mutated`, `bad_request_file` | A request file changed after first sight; a file in `requests/` is not `<id>.json` |
| `withdraw_uncertain` | A withdrawal waits for an uncertain submission to be resolved |
| `role_failing` | A role failed 3 or more turns in a row; carries the provider's message |
| `controller_error` | The last tick, or a phase of it, threw |
| `evaluator_modified` | An active run changed the pinned evaluator |
| `findings_long` | `findings.md` is over 150 lines |
| `blocked` | `blocked.md` is not empty |
| `duplicate_claim_id` | A claim id appears more than once |

- **Notifications** are opt-in. If `site.notify` exists, it is called once when an alert appears (keyed by code and
  ids, kept in `state/notified.json`) and again only after the alert clears and returns. Its errors are logged, never
  fatal. Without it, arc sends nothing: files are the channel.

## 11. Process model

- **Unit.** `arc@<id>.service`, rendered by `arc start`, runs `flock --no-fork --nonblock <lock> node arc run <id>`
  with `Restart=on-failure` and `KillMode=mixed`: SIGTERM reaches only the controller, which finishes its current step,
  so an sbatch is never cut off mid-flight. `arc run` refuses to start without holding the lock, so one controller runs
  per campaign; run each campaign from one node only.
- **Start** is the coordinator's step wherever cluster policy forbids agents from leaving services running; an assistant
  prepares everything with `arc start --no-enable`.
- **Restart.** `arc restart` restarts only the controller; turns and jobs continue. It is how a campaign picks up a new
  arc version. Prompt changes need nothing, since prompts are read every turn.
- **Stop.** `arc stop` writes STOP, stops the unit and the turn units, cancels jobs only with `--cancel-jobs`, then
  checks that no unit or lock holder remains and reports what is left in Slurm.
- **Finish.** After the deadline, once no job or turn is active and the worker has seen the latest news, the controller
  marks the campaign `finished` and exits.

## 12. Guarantees and non-goals

| Guarantee | Mechanism |
|---|---|
| One controller per campaign | systemd instance and `flock`, checked by `arc run` |
| A request is submitted at most once; an uncertain one is never resubmitted | Intent recorded before sbatch; adoption only on an exact token match |
| Provenance exists before a job can run | Held submit; release only after the study and ledger line |
| Requests are immutable; retries get new ids | Snapshot and hash on first sight; file name = id |
| Exact source, settings, hashes, seed and purpose for every attempt | `artifacts/<id>/` |
| The budget counts pending and held jobs | `reserved` (§5) |
| Jobs cannot submit or cancel jobs | Static scan and PATH shims |
| Only this campaign's jobs are cancelled, always with a recorded reason | `withdraw/` → cancel on an exact `squeue` token match |
| Every transition is recorded | `events.jsonl` (and `ledger_md`) |
| A verdict binds to the text the human read | `arc review --hash` |
| Unfair measurement is visible | Evaluator label (§6) and the auditor (§8) |

**Never added** (each was tried or proposed in the legacy campaigns and rejected): pilot or go/no-go gates; caps on
turns, calls, jobs or job duration; turn timeouts; approval steps by the auditor; stopping rules the human did not ask
for; permanent failure after N retries; built-in notifications.

**Not yet**: a project layer above campaigns; validation of `ext`; a cross-campaign submit lock (the site's live
inventory is the guard); importing legacy campaigns.

## 13. Code map

| Path | Responsibility |
|---|---|
| `bin/arc`, `src/cli.mjs` | The CLI; `arc help` lists every verb |
| `src/controller.mjs` | The tick: observe, scan, reconcile, cancel, release, admit, turns, status, notify |
| `src/request.mjs` | `FIELDS`: request validation and the worker's schema text |
| `src/freeze.mjs` | Archive, provenance, evaluator label, `run.sh` |
| `src/slurm.mjs` | The only module that calls the scheduler |
| `src/turns.mjs`, `src/agents.mjs` | Cadence, prompts, launch, harvest and the turn runner; the Codex and Claude adapters |
| `src/claims.mjs`, `src/status.mjs` | Claims, audits and reviews; status and alerts |
| `src/campaign.mjs` | `campaign.json`, paths, registry, site loading |
| `src/systemd.mjs`, `src/git.mjs`, `src/fsutil.mjs` | systemd, git and atomic-file helpers |
| `prompts/` | Worker, worker check-in and auditor protocols |
| `templates/` | `campaign.json`, `brief.md`, `steering.md`, `arc@.service`, `site.example.mjs` |
| `skills/arc-coordinator/` | How an assistant session reads and operates a campaign |

`npm test` runs the controller against an in-memory fake Slurm, real git in temporary repositories and a stub agent: no
jobs, no tokens. Checks against real Slurm and real systemd are run by hand, with approval.
