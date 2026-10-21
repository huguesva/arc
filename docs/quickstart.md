# Quickstart

## Once per machine

1. Node 20 or newer, git, Slurm client commands, and the agent CLI you want (`codex` or `claude`) on PATH.
2. Copy `templates/site.example.mjs` to `~/.config/arc/site.mjs` and adapt partitions, accounts and limits. Keep it out
   of version control.
3. Optional: put `~/arc/bin` on PATH, or call `node ~/arc/bin/arc`.
4. User systemd with lingering enabled, so campaigns keep running after you log out (`loginctl show-user $USER`).

## Start a campaign

```bash
dir=/scratch/$USER/arc/warmup-study            # one directory per campaign, on scratch
mkdir -p "$dir"
cp ~/arc/templates/{campaign.json,brief.md,steering.md} "$dir"/
$EDITOR "$dir/campaign.json" "$dir/brief.md"   # repo, base commit, GPU cap, deadline, models; the question
arc start "$dir"                                # checks, creates the worktree and unit, starts the controller
arc status warmup-study
```

`arc start` refuses to start if the base commit, an agent binary, the scheduler or the brief is missing. With
`--no-enable` it only sets things up.

## Day to day

```bash
arc status                                   # all campaigns
arc claims warmup-study                      # what the worker concludes, with audit verdicts
arc review warmup-study C3 accept -m "checked 3 seeds"
arc steer warmup-study -m "Drop the 4k arm; add a cosine-decay arm."
arc stop warmup-study -m "done"              # jobs keep running unless --cancel-jobs
```

## Run the tests

```bash
cd ~/arc && npm test      # or: node --test test/*.test.mjs
```

The tests use a fake scheduler and a stub agent: no jobs, no tokens.
