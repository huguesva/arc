# Quickstart

## Once per machine

1. Node 20 or newer, git, the Slurm client commands, and the agent CLI you want (`codex` or `claude`) on PATH.
2. Copy `templates/site.example.mjs` to `~/.config/arc/site.mjs` and adapt partitions, accounts and limits. Keep it out
   of version control. Export `notify` there only if you want alerts pushed to you; by default arc sends nothing.
3. Optional: put `~/arc/bin` on PATH, or call `~/arc/bin/arc`.
4. Enable user systemd lingering, so campaigns survive logout and reboot: `loginctl enable-linger $USER`, checked with
   `loginctl show-user $USER -p Linger`.

## Start a campaign

```bash
arc init warmup-study --repo /path/to/project   # creates <runs_root>/warmup-study; base commit = the repo's HEAD
$EDITOR <runs_root>/warmup-study/{campaign.json,brief.md}   # models, GPU cap, deadline; the question
arc start warmup-study                          # checks, creates the worktree and the unit, starts the controller
arc status warmup-study
```

- `arc start` refuses if the base commit, an agent binary, the scheduler or the brief is missing, and is safe to rerun.
  `--no-enable` sets everything up without starting: an assistant session uses it where cluster policy forbids agents
  from leaving services running, and you then run `arc start` yourself.
- Write the brief as priorities and predictions, not go/no-go gates (see `templates/brief.md`).
- arc runs the `codex` or `claude` CLI and never handles keys. Choose the account with `profile` (Codex), `bin` (a
  wrapper script), `args` or `env`. Never put keys in `campaign.json`.

## Day to day

| Want | Command |
|---|---|
| See what is happening | `arc status [<id>]` |
| See the conclusions to review | `arc claims <id>` |
| Accept, reject or ask more of a claim | `arc review <id> C3 accept --hash 1a2b3c4d -m "checked 3 seeds"` (hash from `arc claims`) |
| Change direction | `arc steer <id> -m "..."` (the worker reads it within a few minutes) |
| Stop an experiment | `arc withdraw <id> <request> -m "reason"` (queued: dropped; pending or running: cancelled) |
| Run something first | `arc priority <id> <request> <n>` |
| Hold submissions or turns | `arc pause <id> [submissions\|worker\|auditor]`, then `arc resume` |
| Pick up a new arc version | `arc restart <id>` (turns and jobs keep running) |
| End | `arc stop <id> -m "done"` (jobs keep running unless `--cancel-jobs`), then `arc archive <id>` |

`arc help` lists every verb. An assistant session (`skills/arc-coordinator`) can run most of these for you.

## What keeps a campaign running

- The controller is the systemd user service `arc@<id>`. It restarts after a crash and starts again at boot (with
  lingering). The agents are not long-running: each turn is a short-lived unit, and their memory is the campaign's
  files.
- A failed turn is retried with growing delays, up to every hour, forever; three failures in a row raise `role_failing`
  in `arc status`.
- A campaign stops only when the deadline has passed and nothing is left running, when you run `arc stop`, or when
  its node goes away (run `arc start` on another node: all state is on scratch). `arc pause` holds it without stopping.
- To check: `arc status <id>`, `systemctl --user status arc@<id>`, `journalctl --user -u arc@<id>`.

## Tests

```bash
cd ~/arc && npm test   # fake scheduler and stub agent: no jobs, no tokens
```
