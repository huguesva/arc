# arc

A generic harness for autonomous research campaigns on Slurm. Before changing behaviour, read
[docs/DESIGN.md](docs/DESIGN.md); to operate a running campaign, follow
[skills/arc-coordinator/SKILL.md](skills/arc-coordinator/SKILL.md).

## Personal config lives outside the repo

All user- and cluster-specific settings (scratch paths, PATH, partitions, accounts, QoS, GPU and CPU limits, cluster
rules text) live in one file: `~/.config/arc/site.mjs`, or the path in `$ARC_SITE`. arc reads only that file.

- To change any of those settings, edit `~/.config/arc/site.mjs`. If it is missing, copy
  `templates/site.example.mjs` there and adapt it.
- Everything committed stays generic: templates, docs and tests use placeholder values such as `your-account`.

## Changing arc

- Code enforces only what protects the record and the resources; agent behaviour belongs in `prompts/` (DESIGN.md §2,
  principle 8). Weigh every new rule against that line.
- When a design choice changes, update DESIGN.md and add a row to its decision log (§22).
- The tests run against a fake Slurm and a stub agent: they submit no jobs and spend no tokens.
