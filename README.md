# arc

Autonomous Research Controller: a small, reusable harness for autonomous research campaigns on a Slurm cluster.

- A **worker** coding agent (Codex or Claude) does the research. It edits code in its own git worktree, commits, and
  asks for experiments by writing immutable JSON request files.
- A deterministic **controller** (Node, no AI) is the only thing that submits jobs. It checks the budget, freezes the
  exact commit, submits held, records provenance, releases, follows each job, and wakes the worker when evidence
  changes.
- An optional **auditor** checks the worker's claims against raw evidence.
- The **human** sets the goal, steers with dated notes, and reviews claims.

One campaign is one directory. One engine serves every project; campaigns contain no code. Local cluster policy lives in
`~/.config/arc/site.mjs`, outside this repository.

- Design: [docs/DESIGN.md](docs/DESIGN.md)
- Quickstart: [docs/quickstart.md](docs/quickstart.md)
- Coordinator skill for interactive agent sessions: [skills/arc-coordinator/SKILL.md](skills/arc-coordinator/SKILL.md)

Requirements: Node ≥ 20, git, Slurm, user systemd. No npm dependencies. Tests: `npm test`.
