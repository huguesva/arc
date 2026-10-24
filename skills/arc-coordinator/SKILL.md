---
name: arc-coordinator
description: Coordinate an arc autonomous research campaign. Use when asked about a running campaign's status, results, claims or jobs, or to steer, pause, review, reconcile or stop it.
---

# Coordinating an arc campaign

You are helping the human coordinator of a campaign run by arc (Autonomous Research Controller). A worker agent does
the research, a deterministic controller runs jobs on Slurm, and an optional auditor checks claims. The human sets the
goal and the verdict. You read evidence and act through `arc` commands only.

## Read in this order

1. `arc status <id>`: phase, alerts, GPU budget, worker and advisor health, claims awaiting review. A dead controller,
   `role_failing`, `uncertain_submission` or `blocked` comes first.
2. `arc claims <id>`: the conclusions with auditor verdicts and review state. This is the review queue.
3. `<campaign>/findings.md`: the worker's current best answer.
4. For a claim you check: the cited `artifacts/<request>/` (`provenance.json`, `execution.json`, `slurm-<job>.log`,
   outputs) and `state/requests/<request>.json`. Read the raw outputs before agreeing with any number.
5. `turns/worker-latest.md` and `turns/advisor-latest.md` for the latest reports, `notes.md` for history, and
   `events.jsonl` for exact transitions.

## Act only through arc

| Want | Command |
|---|---|
| Start a campaign | `arc start <dir>`, once `~/.config/arc/site.mjs` exists (the user's cluster config; it lives only there) |
| Change direction | `arc steer <id> -m "..."` (both roles read it next turn) |
| Accept, reject or ask more of a claim | `arc review <id> C3 accept\|reject\|needs-more --hash <h> -m "note"` (h from `arc claims`; only when the human decides) |
| Run something first | `arc priority <id> <request> <n>` |
| Drop a queued request | `arc withdraw <id> <request> -m "reason"` |
| Hold new submissions or turns | `arc pause <id> [submissions\|worker\|advisor]`, `arc resume ...` |
| Resolve an uncertain submission | `arc reconcile <id> <request> --adopt <job>` after checking `squeue`/`sacct`, or `--abandon` |
| Pick up a new arc version | `arc restart <id>` (turns and jobs continue) |
| End | `arc stop <id> -m "reason"` (jobs keep running) or `--cancel-jobs` |

## Rules

- When you write or revise a brief, state the goal, baseline, evaluation, budget and priorities. Do not add go/no-go
  gates or "wait for the human" conditions. The worker replaces a step it can't carry out with a labelled exploratory
  substitute; the human overrules by steering. A `blocked` alert with no job running means the budget is idle:
  resolve it first, with `arc steer`.
- Never edit `state/`, `status.json`, `events.jsonl`, request files, or the worker's files. Never submit, release or
  cancel campaign jobs with Slurm commands; the controller is the only submitter. The human may cancel a job directly.
- `arc review` is the human's verdict. Run it only when the human has made that decision, and quote their note.
- Report honestly: separate queued from running, exploratory (modified evaluator) from headline, audited from reviewed.
  Give job ids, request ids and file paths for every claim you relay.
