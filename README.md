# arc

Autonomous Research Controller: a small, reusable harness for autonomous research campaigns on a Slurm cluster. An AI
agent runs the experiments; plain code keeps it honest.

| Who | Does |
|---|---|
| **Worker** (Codex or Claude) | Edits code in its own git worktree, commits, and requests experiments from the controller by writing immutable JSON request files. Valid requests that fit the GPU budget run without human approval. It can stop its own experiments. |
| **Controller** (Node, no AI) | The only thing that submits or cancels jobs. It checks the budget, freezes the exact commit, submits held, records provenance, releases, follows each job, and wakes the worker when there is news. |
| **Auditor** (optional, read-only) | Checks the worker's claims, code changes and finished runs against raw evidence, including metric gaming. |
| **You**, the coordinator | Set the goal, budget and deadline, steer with dated notes, and accept or reject each claim. An assistant session can operate the campaign for you through `arc` commands. |

One campaign is one directory. One engine serves every project; campaigns contain no code. Local cluster policy lives in
`~/.config/arc/site.mjs`, outside this repository.

- [Quickstart](docs/quickstart.md): set up, start and run a campaign
- [Design](docs/DESIGN.md): how arc works and what it guarantees; [decisions](docs/decisions.md): why
- [Coordinator skill](skills/arc-coordinator/SKILL.md): for an assistant session operating a campaign

Requirements: Node ≥ 20, git, Slurm, user systemd. No npm dependencies. Tests: `npm test`.
