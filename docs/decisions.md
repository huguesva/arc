# arc decisions

Why arc works the way [DESIGN.md](DESIGN.md) describes. Append a row when a design choice changes; never rewrite an old
row (a later row supersedes it). "advisor" in early rows is the auditor's old name (row 26).

| # | Decision | Source |
|---|---|---|
| 1 | Campaign directories live on scratch (`runs_root` in `site.mjs`) | user |
| 2 | Two model roles; the controller is not an LLM; the advisor is optional | recommended, accepted |
| 3 | "Register before release" = durable `study.json` (+ spool copy) written while held; no helper job | recommended, accepted |
| 4 | The advisor audits claims against raw evidence with a fixed checklist; "no material issues" is a valid result | user request |
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
| 16 | Enforce in code only what protects the record and the resources; agent behaviour is set by prompts (principle 8). The advisor report is passed to the worker unfiltered, as nonbinding | user |
| 17 | `arc review` requires the claim hash shown by `arc claims` | review of arc v1 |
| 18 | Advisor re-runs only for claim texts it has not answered; prompt carries per-request evidence; read-only git for the Claude advisor | review of arc v1 |
| 19 | Unit uses `KillMode=mixed`; `arc run` checks it holds the lock; turn units named `arc-<id>.<role>-NNNN` | review of arc v1 |
| 20 | Adoption always records the study and finishes terminal jobs; a queued request found in the queue is adopted, never resubmitted | review of arc v1 |
| 21 | Only accepted, rejected, dropped and finished requests wake the worker; a job starting to run does not | user |
| 22 | Busy-timer wake-ups with no news are short check-in turns, optionally with cheaper settings (worker.checkin) | user |
| 23 | An infeasible procedure, gate or criterion in the brief never idles the campaign: the worker substitutes, labels it exploratory and carries on (prompt rule); briefs state priorities, not gates | review of the order-free-causal campaign, accepted by user |
| 24 | Idle-timer wake-ups with no news back off: `idle_min` doubling to `idle_max_min` (default 240); any other turn resets | review of the order-free-causal campaign, accepted by user |
| 25 | Notifications only through an optional `site.notify` hook, once per new alert; the engine sends nothing by default | user |
| 26 | The advisor is renamed auditor; `advisor` stays accepted as an old name (config, turns state, pause marker, CLI); every non-worker role is read-only | user |
| 27 | The auditor checks claims, metric gaming in the code diffs, and finished runs' logs; at most one suggestion, only as the fix for a cited issue; no repeats without new evidence | user, from the prior-work review |
| 28 | The auditor also wakes on completed runs it has not checked (oldest first, 20 per turn), not only on changed claims | user |
| 29 | Withdrawing a submitted request, pending or running, makes the controller cancel its job (exact token match, reason recorded); replaces "cancellation stays a human action" | user |
| 30 | The human's interactive assistant may steer, pause, restart, reconcile and withdraw superseded or broken requests without asking; it asks before withdrawing a healthy running job, changing budget or deadline, or stopping. Agents never touch the controller, arc's code or its units, and never run scheduler commands on campaign jobs | user |
| 31 | DESIGN.md describes only the current design; the reasons live here; the docs point to the code (`FIELDS`, `arc help`, `status.json`) instead of copying it | user |
