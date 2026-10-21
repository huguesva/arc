# arc design

Status: **draft for approval** (2026-10-21). Nothing is implemented until this document is approved.

arc (Autonomous Research Controller) is a small, reusable harness for autonomous research campaigns on a Slurm
cluster. One AI coding agent does the research. A deterministic controller owns scheduling, budgets and
provenance. An optional second model audits claims against raw evidence. A human sets the goal and the verdict.

It replaces per-project controllers that were copied and patched for each campaign. The semantics of
those controllers are kept; their incidental complexity is not.

## 1. Roles

| Role | Kind | Responsibility | Runs |
|---|---|---|---|
| Worker | LLM coding agent (Codex or Claude), full access to its worktree | Edits code, commits, writes immutable job requests, analyses results, maintains `findings.md` | One turn at a time, woken by the controller |
| Advisor (optional) | LLM, read-only | Audits the claims in `findings.md` against raw evidence (§12) | On new claims or results, at most every `advisor.every_min` |
| Controller | Node, no LLM | Validates, budgets, freezes source, submits, reconciles, schedules turns, writes status | systemd user service, 30 s tick |
| Coordinator | Human, optionally with an interactive agent session | Writes the brief, steers, reviews **claims** (§13) | Whenever they look |

The worker never calls Slurm. The controller never decides what to run.

## 2. Principles

1. **A campaign is one directory**, on scratch by default. It holds the definition and all runtime state; the project tree
   only gains a git worktree and a branch.
2. **One writer per file.** Every file has exactly one owner (§3). Nobody edits another owner's file.
3. **The controller holds no state in memory that matters.** Each tick re-reads small files. Agent turns run in their
   own systemd units. Crash, restart and upgrade are the same safe operation.
4. **Status is recomputed from state every tick.** Alerts are derived conditions, not stored strings; they clear
   themselves.
5. **Engine and site are separate.** All cluster policy (partitions, accounts, shared pools, fairness) lives in one local
   `site.mjs` that is never committed. No constant appears in two places.
6. **Everything done by hand before is a CLI verb.** No reload scripts, no state surgery.
7. **Small.** Node ≥ 20, ESM, zero npm dependencies, `node:test`. Target ≈ 1,100 lines of source.

## 3. Where things live

```
~/arc/                                  this repo: code, prompts, templates, docs, tests
~/.config/arc/site.mjs                  local cluster policy (not committed; template in templates/site.example.mjs)
~/.config/arc/campaigns/<id>            symlink -> campaign directory (registry)
~/.config/arc/locks/<id>.lock           single-instance lock
~/.config/systemd/user/arc@.service     rendered by `arc start`

<runs_root>/<id>/                       one campaign (runs_root from site.mjs, on scratch)
  campaign.json  brief.md  steering.md  human
  control/  STOP  PAUSE_SUBMISSIONS  PAUSE_WORKER  PAUSE_ADVISOR  priority.json  reviews.jsonl
            reconcile/<request>.json    human, via the CLI (reconcile commands are applied once, then renamed)
  requests/<id>.json                    worker, create-only
  withdraw/<id>                         worker or `arc withdraw`; content = reason
  findings.md  notes.md  blocked.md     worker
  worktree/                             worker; git worktree on branch arc/<id>
  state/requests/<request>.json         controller: one record per request
  state/turns.json                      controller: turn bookkeeping
  state/claims.json                     controller: parsed claims, audit verdicts, review validity
  artifacts/<request>/                  controller, then the job:
      request.json provenance.json study.json source.tar run.sh
      source/ (extracted by the job) slurm-<job>.log execution.json <expected outputs>
  turns/<role>-NNNN.{prompt.md,jsonl,stderr,md,exit.json}   controller and turn runner
  turns/<role>-latest.md
  events.jsonl                          controller: every transition (the machine ledger)
  status.json                           controller: fixed schema, rewritten every tick
```

## 4. Campaign definition

`campaign.json`:

```json
{
  "id": "warmup-study",
  "repo": "/path/to/project",
  "base_commit": "<40 hex>",
  "gpu_cap": 16,
  "deadline": "2026-11-01T00:00:00Z",
  "job_prefix": "ws",
  "job_env": { "PYTHONPATH": "$ARC_SOURCE/src:$ARC_SOURCE" },
  "evaluator": { "commit": "<40 hex>", "paths": ["eval/", "data/splits/test.txt"] },
  "worker":  { "agent": "codex", "model": "<model id>", "profile": "<optional>", "effort": "high", "args": [] },
  "advisor": { "agent": "claude", "model": "<model id>", "every_min": 60 },
  "cadence": { "changed_min": 2, "idle_min": 20, "busy_min": 60 },
  "ledger_md": "/path/to/notebook/runs.md",
  "study_spool": "/path/to/observer/spool"
}
```

- `deadline` is required: an ISO time or the literal `"none"`. That makes it a conscious choice, never a default.
- `advisor`, `evaluator`, `ledger_md`, `study_spool`, `cadence`, `job_prefix` (defaults to `id`) and `job_env` are
  optional.
- Each role may set `bin` (absolute path of the agent CLI, e.g. a wrapper script), `profile`, `effort`, `args` and `env`.
- Model ids must be exact. A turn whose reported model differs from the configured one fails (no silent substitution).
- `brief.md`: objective, baseline, evaluation protocol, budget and deadline in prose. Stable.
- `steering.md`: append-only dated entries, `## 2026-10-21T16:09Z — title`, written by `arc steer` or by hand. Read
  in order; later entries supersede earlier ones. Both roles read the same text.

There is no separate project layer. Two campaigns on one project copy a few lines of `campaign.json`.

## 5. Requests

A request is one file, `requests/<id>.json`. The file name must equal the `id`.

| Field | Rule |
|---|---|
| `id` | `^[a-z][a-z0-9-]{0,63}$`, never reused |
| `kind` | non-empty string, e.g. `training`, `evaluation`, `diagnostic` |
| `source_commit` | 40 hex; must exist in `repo` (any branch or worktree) |
| `script` | path relative to the commit root; a regular file in that commit (not a symlink); no `..` |
| `gpus`, `cpus`, `mem_gb`, `minutes` | integers; `gpus ≥ 0`, the others ≥ 1 |
| `partition` | optional; interpreted by the site module |
| `seed` | integer |
| `hypothesis`, `baseline`, `evaluation`, `data_provenance`, `config_description` | non-empty strings |
| `expected_outputs` | non-empty array of relative paths |
| `after` | optional array of request ids that must finish `COMPLETED` first |
| `priority` | optional integer, default 0 |
| `supersedes` | optional request id (lineage only, no effect on scheduling) |
| `ext` | optional free-form object for project fields; recorded, not interpreted |

- Unknown top-level fields are rejected. This catches typos and keeps the schema honest.
- `site.validate(request)` may reject shapes the cluster can't run.
- The static scan rejects scripts that mention `sbatch`, `salloc`, `scancel` or `scontrol`, plus any extra names from
  `site.forbidden(request)`.
- **Validation lives in one `FIELDS` table.** The validator and the request section of the worker prompt are
  both generated from it, so the documentation can't drift.
- **The worker checks before writing.** `arc check-request <file>` runs the same validation (minus commit lookup if run
  outside the campaign), so the worker can check before dropping a file.
- **Requests are immutable.** On first sight the controller copies the request and its sha256 into `state/<id>.json`.
  Later edits to the file are ignored and raise `request_mutated`. A deleted file has no effect.
- **Withdrawal.** The worker or `arc withdraw` creates `withdraw/<id>` with a reason. It takes effect only while the
  request is `queued`; after submission it raises `withdraw_after_submit`, and cancellation stays a human action.

## 6. Request lifecycle

```
queued ──submit──▶ submitting ──receipt──▶ submitted ──terminal state──▶ finished
  │  ▲                 │                   (held → released)
  │  └ transient error,│ crash or ambiguous sbatch
  │    retry later,    ▼
  │    same id     uncertain ──exactly one match──▶ submitted
  │                    └─ arc reconcile --adopt <job> | --abandon
  ├─ invalid ──────────▶ rejected
  └─ withdrawn, dependency failed, abandoned ──▶ dropped
```

Error classes:

- **Permanent**: any validation failure. The request becomes `rejected` and its id is spent. The worker sees the
  error in its next digest and files a new id.
- **Transient**: git or tar failure or timeout, `scontrol release` failure, or a definite `sbatch` error (non-zero
  exit with an `sbatch: error` message that is not a socket, timeout or connection error). The request stays in its
  state with `retry_at = now + min(60, 2^attempts)` minutes. It never gives up, and `last_error` is shown in status.
- **Ambiguous**: `sbatch` timed out, was killed, or the controller crashed while `submitting`. Recovery decides (§9).

## 7. Admission

Each tick, unless STOP, PAUSE_SUBMISSIONS or the deadline applies:

1. Sort `queued` records by (effective priority desc, first seen asc, id). Effective priority is
   `control/priority.json[id]` if set (`arc priority`), otherwise the request's `priority`.
2. For each request:
   - **Retry not due**: skip; `waiting_for: retry`.
   - **Dependencies**: if an `after` request finished other than `COMPLETED`, or was rejected or dropped, this
     request is dropped (`dependency_failed`). If a dependency is not finished yet, or is unknown: `waiting_for:
     dependency`.
   - **Budget**: `reserved + gpus > gpu_cap` → `waiting_for: budget`. This blocks every later request with a
     **lower** priority (`waiting_for: priority`). Requests at the same priority may still backfill.
   - **Site route**: `site.route(request, ctx)` returns sbatch arguments or `{wait: reason}`. A wait behaves like a
     budget block.
   - Otherwise submit (§8).

`reserved` is the sum of `gpus` over records that are `submitting`, `uncertain`, or `submitted` and not yet terminal,
plus the GPUs of orphan jobs (§9). Pending and held jobs count. Shared cluster pools (for example a per-user
ceiling across all campaigns) are the site module's job, using live `squeue` inventory.

## 8. Submission

In order. Each step is idempotent, so a crash at any point is repaired by the next tick.

1. **Freeze** into `artifacts/<id>/`:
   - Write `source.tar` with `git -C <repo> archive <commit>`, and compute the sha256 of the archive and of the script
     (read with `git show`).
   - Record the campaign worktree's uncommitted changes as `ignored_worktree_changes`.
   - Check the evaluator (§10).
   - Write `request.json`, `provenance.json` and `run.sh`.
   - If the artifact already holds a matching `provenance.json`, reuse it.
   - git calls get a 30-minute timeout; a timeout is transient.
2. **Record intent**: status `submitting`, with `intent_at`.
3. **Submit held**: `sbatch --parsable --hold --no-requeue --job-name=<prefix>-<id> --comment=arc:<campaign>:<id>
   --chdir=<artifact> --output=<artifact>/slurm-%j.log <site args> run.sh`. The request id is the exact token: a
   request is submitted at most once.
4. **Record receipt**: status `submitted`, `job_id`, `released: false`.
5. **Record the study**: write `study.json` with the job id, and copy it atomically into `study_spool` if one is set.
   Write a ledger line (§13).
6. **Release**: `scontrol release <job>`, then `released: true`.

`study.json` uses the field names existing observers read: `id`, `title`, `hypothesis`, `source_commit`,
`submitted_after`, `jobs[{id, purpose}]`, `evidence_paths`, `baseline`, `evaluation`, `seed`, `data_provenance`,
`campaign`, `evaluator_status`. An observer ingests the spool in its own cycle. arc never submits helper jobs.

`run.sh`, generated:

- exports `ARC_CAMPAIGN`, `ARC_REQUEST_ID`, `ARC_RUN_DIR`, `ARC_SOURCE`, `ARC_SEED`;
- sets `OMP/MKL/OPENBLAS_NUM_THREADS` from `$SLURM_CPUS_PER_TASK`;
- adds the `job_env` entries (expanded at run time);
- puts PATH shims first, so `sbatch`, `salloc`, `scancel`, `scontrol` and the site's extra names fail loudly;
- extracts `source.tar` into `source/` on the compute node if not already present;
- runs `bash <script>` from `source/`;
- writes `execution.json` (exit code, job id, start and end times) from an EXIT trap.

Extracting on the compute node keeps the slow filesystem work out of the controller's tick.

## 9. Reconciliation

Each tick:

- **Observe.** Run `sacct -X -n -P -j <non-terminal job ids> --format=JobIDRaw,State,ExitCode,ElapsedRaw`. A
  terminal state (`COMPLETED FAILED CANCELLED TIMEOUT OUT_OF_MEMORY NODE_FAIL BOOT_FAIL DEADLINE PREEMPTED REVOKED`)
  makes the record `finished` and writes a ledger line. A job missing from `sacct` keeps its last state.
- **Adopt.** For each `submitting` or `uncertain` record, search `squeue --me` for the exact comment
  `arc:<campaign>:<id>`, then `sacct --name=<prefix>-<id>` since `intent_at`.
  - Exactly one match: adopt it as `submitted` (released or not, as Slurm reports).
  - Otherwise `submitting` becomes `uncertain`; it is re-checked every tick.
  - An uncertain request keeps its GPUs reserved and blocks only itself. It is never resubmitted.
  - A human resolves it with `arc reconcile <id> --adopt <job>` or `--abandon` (which makes it `dropped`). The command
    is written to `control/reconcile/` and applied by the controller on its next tick, so `state/` keeps one writer.
- **Release.** `submitted` and not released: write the study if missing, then release.
- **Orphans.** Jobs in `squeue --me` whose comment starts with `arc:<campaign>:` but match no record's job id
  count toward `reserved` (GPUs parsed from `%b × %D`) and raise `orphan_job`.

## 10. Pinned evaluator

Problem: provenance guarantees *what* ran, not that the measurement was fair. The worker writes both the method
and, by default, the code that scores it.

- `campaign.json` `evaluator` pins a commit and a list of paths (evaluation code, test split definitions). The
  human vets them once.
- At freeze time the controller runs `git diff --quiet <pinned> <source_commit> -- <paths>`. It records
  `evaluator: {commit, status: unmodified|modified, tree ids}` in `provenance.json`, `study.json` and the ledger.
- The worker protocol: headline claims in `findings.md` cite runs with an unmodified evaluator. Runs with a modified
  evaluator are labelled exploratory. Changing the evaluator is a human decision: re-pin with a steering note.
- This is a label, not a gate: nothing is blocked. It detects rather than prevents, because the worker runs as the
  same Unix user.

## 11. Agent turns

**Execution.**

- The controller writes `turns/<role>-NNNN.prompt.md`, then launches
  `systemd-run --user --collect --unit=arc-<campaign>-<role>-NNNN … arc turn <campaign> <role> NNNN`.
- `arc turn` runs the agent CLI with the prompt on stdin and captures `.jsonl` and `.stderr`. It parses the
  transcript and writes `.md` (the report) and `.exit.json` (`{ok, model, usage, error, started_at, finished_at}`).
- Turns are not children of the controller. Restarting or upgrading the controller never touches a turn.
- Each tick: if `exit.json` exists, the turn is harvested. If the unit is gone without an `exit.json`, the turn
  failed.

**Adapters** (`src/agents.mjs`). Each turns role config into argv and env, and parses the transcript into
`{ok, report, model, usage, error}`.

- `codex`: `codex exec --json --output-last-message`. The worker gets `--sandbox danger-full-access --cd <worktree>
  --add-dir <campaign>`; the advisor gets `--sandbox read-only`.
- `claude`: `claude --print --output-format stream-json --verbose --no-session-persistence`. The advisor's tools are
  limited to `Read,Glob,Grep`.
- The same credentials home is used for both roles unless a role sets `env`, so a separate home can't silently run
  out of credits.

**Cadence.**

- Worker fingerprint = hash of (record id, status, slurm state, released) for all requests, `brief.md`,
  `steering.md` and the latest advisor verdict.
- **Worker** is due when no worker turn is active, PAUSE_WORKER is absent, and at least one holds:
  - the fingerprint changed since the last turn started, and `changed_min` has passed;
  - no job is active and `idle_min` has passed;
  - `busy_min` has passed.
- Failure backoff: `min(60, 2^consecutive_failures)` minutes after the failed turn. Never permanent. No turn timeouts
  and no turn caps.
- After the deadline only the first condition applies.
- **Advisor** is due when configured, no advisor turn is active, PAUSE_ADVISOR is absent, `every_min` has passed since
  its last start, and its audit fingerprint changed. The audit fingerprint is `findings.md` plus the set of finished
  requests. The advisor runs independently of the worker.

**Prompt**, composed fresh every turn and archived:

1. `prompts/<role>.md` from this repo (the role protocol). The worker's version includes the request schema
   generated from `FIELDS`.
2. `site.prompt`: cluster rules text.
3. Campaign facts: id, GPU cap, deadline, paths, evaluator pin.
4. `brief.md`.
5. `steering.md`, introduced by "chronological; later entries supersede earlier ones".
6. A digest:
   - phase and budget;
   - the queue with `waiting_for`;
   - active and recently finished jobs;
   - requests rejected since this role's last turn, with errors;
   - alerts and this role's own health;
   - `findings.md` with its line count, plus a consolidation nudge above 150 lines;
   - `blocked.md`;
   - for the worker, the audit and human review state of each claim, with notes; for the advisor, the claims that
     changed and their evidence paths.

**Worker files.**

- `findings.md`: the current best answer, rewritten each turn rather than appended to. It has sections for the
  question, the current answer with its confidence, the claims (§13), open questions and next steps, and superseded
  claims (one line each).
- `notes.md`: an append-only lab notebook.
- `blocked.md`: written when a task looks impossible, contradictory or mis-specified. It is shown at the top of
  status and to the advisor, and does not stop anything.

## 12. Advisor protocol (auditor)

The advisor checks claims; it doesn't plan research.

- **Input**: the claims in `findings.md` that are new or changed since its last audit, their evidence paths, the
  diffs of the cited commits, the request records and logs. It never reads the worker's turn report.
- **Per claim**, a fixed checklist answered yes / no / can't tell:
  - Does the number match the artifact?
  - Do the baseline and the arm use the same protocol and denominator?
  - Are there enough seeds for the claimed effect size?
  - Is the evaluator unmodified?
  - Is any failed or discarded run left out?
  - Could test data leak into training?
- **Output**, fixed shape:
  - one line per claim, `C<n>: supported | unsupported | can't tell — <evidence>`, which the controller parses into
    `state/claims.json`;
  - then `Material issues: none` or a list where every item cites a file, job id or number.
  - Only issues that would change a conclusion or the next decision count. No suggested experiments, no style notes.
- **Framing in the prompt**: "Most audits find no material issues; saying so is a correct and complete result."
- Only the verdict block reaches the worker. The worker may disagree, giving the reason in `notes.md`.
- `status.json` shows the advisor's flag rate. A rate near 100% is a prompt problem to fix.

## 13. Claims, review, ledger, status

**Human review is per claim, not per job.** A job finishing says nothing about whether a conclusion is true, and a
per-job review queue does not scale. One legacy notebook reached 15,000+ unticked "Needs analysis" job lines.

- **Claims.** In `findings.md`, each claim is a block with a stable id:

  ```
  ### C3 — 2k warmup lowers final val loss by 0.03 ± 0.01 vs 500 steps
  Evidence: warmup-2k-seed1..3 vs warmup-500-seed1..3; artifacts/<id>/metrics.json
  Evaluator: unmodified
  Variants tried: 4
  ```

  - Ids are never reused.
  - A retracted claim moves to the superseded section with its id.
- **Parsing.** Each tick the controller parses the claim blocks into `state/claims.json`, with the sha256 of each
  block's text.
- **Audit.** The advisor's verdict lines (§12) attach to a claim together with the hash they were made against.
- **Review.** `arc review <campaign> C3 accept|reject|needs-more -m "note"` appends `{claim, verdict, note, at, hash}`
  to `control/reviews.jsonl`.
  - Only a human writes that file.
  - A review counts only while the claim's hash still matches. If the worker edits the claim, it becomes `stale` and
    needs a new review.
  - The worker sees audit and review verdicts per claim in its digest.
- **Claim states**, derived each tick:
  - `new` (not audited yet), `audited`, `reviewed:accept`, `reviewed:reject`, `reviewed:needs-more`, `stale`;
  - `superseded`, for a claim moved to the superseded section.
- **Job ledger = provenance only.** `events.jsonl` records every transition
  `{at, type, request?, job?, from?, to?, detail}`. If `ledger_md` is set, a plain line (no checkbox, no review
  expectation) is inserted under `flock` on submission (with the job id) and on finish.
- `status.json` (`schema: "arc.status/1"`) has every key present on every tick:
  - `controller {pid, version, started_at, heartbeat_at, phase}`, where phase is one of `running`, `paused`,
    `deadline_closed`, `stopped`, `finished`;
  - `deadline {at, remaining_s, closed}`;
  - `budget {cap, reserved, free, orphan_gpus}`;
  - `counts` by status, and `queue [{id, priority, waiting_for}]`;
  - `jobs {active, recent}`;
  - `roles.{worker,advisor} {active, last_started, last_finished, next_due_at, consecutive_failures, last_error,
    health}`;
  - `blocked`;
  - `claims {total, awaiting_review, stale, audited_unsupported, accepted, rejected}`;
  - `alerts [{code, message, ids}]`.
- Alert codes, all derived each tick:
  - `uncertain_submission`, `orphan_job`, `request_mutated`, `withdraw_after_submit`;
  - `role_failing` (3 or more consecutive failures, with the provider's message), `controller_error` (last tick
    threw);
  - `evaluator_modified`, `findings_long`, `blocked`.
- `arc status` reports the controller as dead if the heartbeat is older than 3 minutes or the unit is inactive.

## 14. Process model

- **Unit.** `arc@.service` is rendered by `arc start` with absolute node and arc paths:
  - `ExecStart=/usr/bin/flock --no-fork --nonblock %h/.config/arc/locks/%i.lock <node> <arc>/bin/arc run %i`;
  - `Restart=on-failure`, `RestartSec=30`, `UMask=0077`, default KillMode.
  - Node is the MainPID, and only short-lived children inherit the lock fd.
- **Loop.** The tick loop is sequential (no overlap). SIGTERM finishes the current step, then exits 0.
- **End of campaign.** After the deadline, once no job is active, no turn is active and the last worker turn started
  after the last evidence change, phase becomes `finished` and the controller exits 0.
- **Stop.** `arc stop`:
  1. writes `control/STOP` with a reason;
  2. stops the unit and the `arc-<id>-*` turn units;
  3. with `--cancel-jobs`, runs `scancel` on every campaign job;
  4. verifies that no unit is active and the lock is free, then reports what is still in Slurm.
- **Preserved jobs.** Without `--cancel-jobs`, running and queued jobs are kept.
- **Restart.** `arc restart` restarts the controller only; turns and jobs continue.

## 15. CLI

```
arc init <id> --repo <path>   new campaign directory from templates (in runs_root), base_commit = repo HEAD
arc start <dir|id>            validate config, files, site, agent binaries and scheduler access; create dirs and
                              worktree (git worktree add <dir>/worktree -b arc/<id> <base_commit>); register;
                              install the unit; clear STOP; enable; wait for a heartbeat; print a summary.
                              Idempotent.
arc status [<id>] [--json]    one campaign, or all with GPU totals
arc steer <id> -m "…" | -f <file>
arc pause|resume <id> [submissions|worker|advisor]   (default: all three)
arc priority <id> <request> <n>
arc withdraw <id> <request> -m "reason"
arc claims <id>               claims with audit and review state, awaiting-review first
arc review <id> <claim> accept|reject|needs-more -m "note"
arc reconcile <id> <request> --adopt <job> | --abandon
arc restart <id>
arc stop <id> [--cancel-jobs] -m "reason"
arc archive <id>              after stop: remove the worktree (git worktree remove), unit and registry link
arc check-request <file>      for the worker
arc run <id> | arc turn <id> <role> <n>              internal entry points
```

## 16. Site module

`~/.config/arc/site.mjs`, local only. The repo ships `templates/site.example.mjs` with a generic single-partition
policy.

```
export const runs_root                          default parent for new campaigns (scratch)
export const path                               PATH for turns and jobs
export const prompt                             cluster-rules text for both roles
export function validate(request)               throw for shapes the cluster can't run (permanent)
export function route(request, {squeue, campaign}) -> {args: [...], note} | {wait: reason}
export function forbidden(request) -> [names]   extra commands to block in jobs
```

`route` returns partition, account, QoS, nodes, tasks, CPUs, memory, time and GRES arguments. It may query live
inventory for shared pools. The engine adds and owns `--hold`, `--parsable`, `--no-requeue`, `--job-name`,
`--comment`, `--chdir` and `--output`, and rejects them if `route` returns them. Its `note` goes into provenance.

## 17. Invariants and where they are enforced

| Invariant | Mechanism |
|---|---|
| One controller per campaign | systemd instance + `flock --no-fork --nonblock` |
| Intent persisted before submit; uncertain never resubmitted | §8 step 2; §9 adopt-or-uncertain |
| Provenance before the job can run | held submit; release only after study and ledger |
| Immutable requests, retries get new ids | snapshot + hash on first sight; filename = id |
| Exact source, config, hashes, seed, hypothesis, baseline, evaluation per attempt | `artifacts/<id>/` |
| Every job id recorded at submission | receipt step + events + ledger line |
| Budget counts pending and held jobs | `reserved` (§7) |
| Jobs can't submit or cancel | static scan + PATH shims |
| Prompts re-read every turn | composed per turn from files |
| Ledger entry per transition | `events.jsonl` (+ optional `runs.md` lines) |
| Only a human marks a conclusion Reviewed | per-claim reviews in human-only `control/reviews.jsonl`, tied to the claim's hash |
| Fair measurement is visible | pinned evaluator label (§10) |

## 18. Non-goals

Never added: pilot gates; caps on turns, calls, jobs or job duration; model-turn timeouts; advisor approval steps;
chat notifications (files are the channel); stopping rules the human didn't ask for; permanent failure after N
retries.

Not in v1: a separate project layer; validation of `ext`; a cross-campaign submit lock (the site's live inventory
check is the guard); migrating live legacy campaigns; importing legacy state.

## 19. Repository layout and size

```
bin/arc                      ~20   CLI entry
src/cli.mjs                  ~200  verbs
src/campaign.mjs             ~80   load and validate campaign.json, paths, registry
src/request.mjs              ~100  FIELDS, validation, schema text for the prompt
src/controller.mjs           ~250  tick: observe, scan, adopt, release, admit, turns, status
src/slurm.mjs                ~80   sbatch/squeue/sacct/scontrol wrappers and parsing (injectable)
src/freeze.mjs               ~90   archive, provenance, evaluator check, run.sh
src/turns.mjs                ~150  cadence, prompt composition, launch, harvest
src/agents.mjs               ~80   codex and claude adapters
src/status.mjs               ~100  status and alerts
prompts/worker.md  prompts/advisor.md
templates/campaign.json brief.md steering.md arc@.service site.example.mjs
skills/arc-coordinator/SKILL.md     how an interactive session reads and steers a campaign
docs/DESIGN.md quickstart.md
test/fake-slurm.mjs  test/*.test.mjs
```

## 20. Tests

The controller takes injected dependencies `{slurm, systemd, clock}`. Tests use an in-memory fake Slurm and real
git in temporary repositories. Required cases:

- crash after `sbatch` created the job, before the receipt → restart adopts it, no duplicate;
- `sbatch` timeout without a job → `uncertain`, never resubmitted, GPUs stay reserved, other requests proceed;
- definite `sbatch` error → retry with the same id; validation error → `rejected`;
- budget with held, pending, uncertain and orphan jobs; priority order; same-priority backfill; lower priority
  never overtakes;
- dependencies: wait, then proceed or drop;
- request mutation, duplicate id, file name ≠ id, unknown field;
- crash between receipt and release → release happens, study and ledger written once;
- deadline closes admission, preserves jobs, finishes cleanly;
- evaluator unmodified vs modified;
- claim parsing; audit and review attach by hash; an edited claim becomes `stale`; reused or missing ids are flagged;
- PATH shims make `sbatch` fail inside `run.sh`;
- turn harvest: success, failure with provider message, unit vanished; backoff schedule; cadence rules;
- status: every key present, alerts clear when conditions resolve;
- SIGTERM → clean exit.

Integration, run manually with explicit approval:

- one 0-GPU CPU job through real Slurm on a throwaway campaign;
- `start`, `restart` and `stop` under real systemd with a stub agent. Verify no leftover process, unit or lock
  holder, and remove everything afterwards.

## 21. Implementation plan

1. **Core** against fake Slurm: requests, records, admission, submission, reconciliation, status, events, with the
   tests above.
2. **Freeze and site**: archive, provenance, evaluator check, `run.sh`, site loader and example; the real CPU smoke
   job.
3. **Turns**: adapters, systemd-run launch, harvest, cadence, prompt composition; tested with a stub agent (no
   tokens).
4. **CLI and unit**: all verbs, `arc@.service`, stop and restart verification.
5. **Prompts and docs**: worker and advisor protocols, coordinator skill, quickstart. First real campaign: a fresh
   campaign on a project with no live controller.

Live campaigns on the legacy controllers are not touched. They finish or drain on their own controllers.

## 22. Decision log

| # | Decision | Source |
|---|---|---|
| 1 | Campaign directories live on scratch (`runs_root` in `site.mjs`) | user |
| 2 | Two model roles; the controller is not an LLM; the advisor is optional | recommended, accepted |
| 3 | "Register before release" = durable `study.json` (+ spool copy) written while held; no helper job | recommended, accepted |
| 4 | The advisor audits claims against raw evidence with a fixed checklist; "no material issues" is a valid result | user request, design §12 |
| 5 | Pinned evaluator, recorded as a label, not a gate | user |
| 6 | `arc stop` preserves jobs; `--cancel-jobs` is explicit | recommended, accepted |
| 7 | `deadline` is required: ISO time or `"none"` | recommended, accepted |
| 8 | Priority, then first seen; lower never overtakes higher; same-priority backfill | recommended, accepted |
| 9 | Uncertain: auto-adopt only an exact single match; never auto-abandon | recommended, accepted |
| 10 | Turns as transient systemd user units | recommended, accepted |
| 11 | `site.mjs` is local and never committed | user policy |
| 12 | `blocked.md` channel from the worker | recommended, accepted |
| 13 | No project layer; `ext` is free-form | recommended, accepted |
| 14 | `findings.md` soft budget of 150 lines (nudge only) | recommended, accepted |
| 15 | Human review is per claim (hash-bound, `arc review`); the job ledger is provenance only | user |
