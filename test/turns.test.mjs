import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tick} from '../src/controller.mjs';
import {isDue, loadTurns} from '../src/turns.mjs';
import {parseClaims, parseVerdicts, claimStates} from '../src/claims.mjs';
import {main} from '../src/cli.mjs';
import {tempRepo, makeCampaign, context, status, request, writeRequest, record, STUB_AGENT} from './helpers.mjs';

const MIN = 60000;
const every = {changed: 2, idle: 20, busy: 60};

test('cadence: news after 2 min, idle 20 min, busy 60 min, backoff on failure, deadline only on news', () => {
  const rs = {active: null, last_started_at: 0, last_finished_at: 0, consecutive_failures: 0};
  const due = (o) => isDue({rs: {...rs, ...o.rs}, now: o.now, every, changed: o.changed ?? false, activeJobs: o.activeJobs ?? false, closed: o.closed ?? false, paused: false}).due;
  assert.equal(due({now: 1 * MIN, changed: true}), false);
  assert.equal(due({now: 2 * MIN, changed: true}), true);
  assert.equal(due({now: 19 * MIN}), false);
  assert.equal(due({now: 20 * MIN}), true);
  assert.equal(due({now: 59 * MIN, activeJobs: true}), false);
  assert.equal(due({now: 60 * MIN, activeJobs: true}), true);
  assert.equal(due({now: 600 * MIN, closed: true}), false, 'after the deadline only news wakes the worker');
  assert.equal(due({now: 600 * MIN, closed: true, changed: true}), true);
  assert.equal(due({now: 3 * MIN, rs: {consecutive_failures: 2, last_finished_at: 0}}), false, 'backoff 4 min after 2 failures');
  assert.equal(due({now: 4 * MIN, rs: {consecutive_failures: 2, last_finished_at: 0}}), true);
  assert.equal(due({now: 59 * MIN, rs: {consecutive_failures: 9, last_finished_at: 0}}), false, 'backoff caps at 60 min');
  assert.equal(due({now: 60 * MIN, rs: {consecutive_failures: 9, last_finished_at: 0}}), true, 'never gives up');
  assert.equal(due({now: 999 * MIN, rs: {active: {n: 1}}}), false, 'one turn at a time');
});

test('cadence: idle wake-ups double with the idle streak, up to idleMax', () => {
  const due = (streak, now) => isDue({rs: {active: null, last_started_at: 0, last_finished_at: 0, consecutive_failures: 0, idle_streak: streak},
    now, every: {...every, idleMax: 240}, changed: false, activeJobs: false, closed: false, paused: false});
  assert.equal(due(0, 20 * MIN).due, true);
  assert.equal(due(2, 79 * MIN).due, false);
  assert.equal(due(2, 80 * MIN).due, true);
  assert.equal(due(9, 239 * MIN).due, false, 'capped at idleMax');
  assert.equal(due(9, 240 * MIN).due, true);
  assert.equal(isDue({rs: {active: null, last_started_at: 0, consecutive_failures: 0, idle_streak: 9}, now: 2 * MIN, every: {...every, idleMax: 240},
    changed: true, activeJobs: false, closed: false, paused: false}).due, true, 'news is not delayed by the idle streak');
});

test('idle turns with no news back off, and news resets the streak', () => {
  const {repo, commit} = tempRepo();
  const c = makeCampaign({repo, commit, pauseWorker: false});
  const ctx = context(c);
  const t0 = ctx.now;
  const turn = at => { ctx.now = at; tick(ctx); ctx.now += 1000; tick(ctx); };
  turn(t0); // first turn: the fingerprint is new
  assert.equal(loadTurns(c).worker.idle_streak, 0);
  turn(t0 + 20 * MIN);
  assert.equal(ctx.systemd.started.length, 2, 'first idle wake-up after idle_min');
  assert.equal(loadTurns(c).worker.idle_streak, 1);
  turn(t0 + 59 * MIN);
  assert.equal(ctx.systemd.started.length, 2, 'the next idle wake-up waits twice as long');
  turn(t0 + 60 * MIN);
  assert.equal(ctx.systemd.started.length, 3);
  assert.equal(status(c).roles.worker.idle_streak, 2);
  assert.equal(status(c).roles.worker.next_due_at, new Date(t0 + 140 * MIN).toISOString());
  fs.appendFileSync(c.paths.steering, '\n## 2026-10-22T01:05Z — go\n\nStart arm D.\n');
  turn(t0 + 62 * MIN);
  assert.equal(ctx.systemd.started.length, 4, 'steering still wakes the worker after changed_min');
  assert.equal(loadTurns(c).worker.idle_streak, 0, 'news resets the streak');
});

test('worker turn runs through the real turn runner and is harvested', () => {
  const {repo, commit} = tempRepo();
  const c = makeCampaign({repo, commit, pauseWorker: false});
  const ctx = context(c);
  tick(ctx); // launches (fake systemd runs it synchronously)
  assert.equal(ctx.systemd.started.length, 1);
  const prompt = fs.readFileSync(path.join(c.paths.turns, 'worker-0001.prompt.md'), 'utf8');
  for (const part of ['## Request schema', '## Cluster rules', '## Brief', '## Steering', '## Live status']) assert.ok(prompt.includes(part), part);
  ctx.now += 1000; tick(ctx); // harvest
  const t = loadTurns(c);
  assert.equal(t.worker.consecutive_failures, 0);
  assert.equal(t.worker.totals.turns, 1);
  assert.equal(t.worker.totals.input_tokens, 100);
  assert.equal(fs.readFileSync(path.join(c.paths.turns, 'worker-latest.md'), 'utf8').trim(), 'worker turn done');
  ctx.now += 1 * MIN; tick(ctx);
  assert.equal(ctx.systemd.started.length, 1, 'no news: no new turn');
  fs.appendFileSync(c.paths.steering, '\n## 2026-10-22T00:05Z — focus\n\nTry warmup 2k.\n');
  ctx.now += 2 * MIN; tick(ctx);
  assert.equal(ctx.systemd.started.length, 2, 'steering is news');
});

test('provider failures are visible, back off, and never stop retrying', () => {
  const {repo, commit} = tempRepo();
  const c = makeCampaign({repo, commit, pauseWorker: false});
  fs.writeFileSync(path.join(c.dir, 'stub-mode'), 'fail');
  const ctx = context(c);
  for (let i = 0; i < 3; i++) { tick(ctx); ctx.now += 1000; tick(ctx); ctx.now += 61 * MIN; }
  const s = status(c);
  assert.equal(s.roles.worker.consecutive_failures, 3);
  assert.match(s.roles.worker.last_error, /out of credits/);
  assert.ok(s.alerts.some(a => a.code === 'role_failing' && /out of credits/.test(a.message)));
  fs.rmSync(path.join(c.dir, 'stub-mode'));
  tick(ctx); ctx.now += 1000; tick(ctx);
  assert.equal(status(c).roles.worker.consecutive_failures, 0);
  assert.ok(!status(c).alerts.some(a => a.code === 'role_failing'), 'alert clears itself');
});

const FINDINGS = `# Question
Does warmup help?

## Claims

### C1 — 2k warmup lowers val loss by 0.03
Evidence: warmup-2k-seed1..3 vs warmup-500-seed1..3
Evaluator: unmodified
Variants tried: 2

### C2 — LR above 3e-3 diverges
Evidence: lr-sweep
Variants tried: 5

## Superseded

### C0 — warmup has no effect
Retracted after seed 3.
`;

test('claims parse with stable ids, hashes and a superseded section', () => {
  const claims = parseClaims(FINDINGS);
  assert.deepEqual(claims.map(c => [c.id, c.superseded]), [['C1', false], ['C2', false], ['C0', true]]);
  assert.match(claims[0].title, /2k warmup/);
  assert.notEqual(claims[0].hash, claims[1].hash);
  assert.deepEqual(parseVerdicts('C1: supported — matches metrics.json\n- C2: unsupported — only one seed\nMaterial issues: none'),
    {C1: {verdict: 'supported', detail: 'matches metrics.json'}, C2: {verdict: 'unsupported', detail: 'only one seed'}});
});

test('advisor audits claims; human review binds to the claim text; an edit makes it stale', async () => {
  const {repo, commit} = tempRepo();
  const c = makeCampaign({repo, commit, config: {advisor: {agent: 'claude', model: 'stub-model', bin: (await import('./helpers.mjs')).STUB_AGENT, every_min: 30}}});
  fs.writeFileSync(c.paths.findings, FINDINGS);
  fs.writeFileSync(path.join(c.dir, 'stub-report-advisor'), 'C1: supported — matches metrics.json\nC2: unsupported — one seed only\nMaterial issues:\n- C2 rests on a single seed (lr-sweep/metrics.json)');
  const ctx = context(c);
  tick(ctx); ctx.now += 1000; tick(ctx);
  const prompt = fs.readFileSync(path.join(c.paths.turns, 'advisor-0001.prompt.md'), 'utf8');
  assert.ok(prompt.includes('## Claims to audit (2)'));
  let states = Object.fromEntries(claimStates(c).map(x => [x.id, x]));
  assert.equal(states.C1.state, 'audited');
  assert.equal(states.C1.audit.verdict, 'supported');
  assert.equal(states.C2.audit.verdict, 'unsupported');
  assert.equal(status(c).claims.audited_unsupported, 1);
  ctx.now += 31 * MIN; tick(ctx);
  assert.equal(loadTurns(c).advisor.n, 1, 'nothing new to audit: advisor does not run');

  const log = console.log; console.log = () => {};
  try {
    await assert.rejects(main(['review', c.dir, 'C1', 'accept', '--hash', 'deadbeef', '-m', 'x']), /changed since you read it/);
    await main(['review', c.dir, 'C1', 'accept', '--hash', states.C1.hash.slice(0, 8), '-m', 'checked seeds']);
  } finally { console.log = log; }
  states = Object.fromEntries(claimStates(c).map(x => [x.id, x]));
  assert.equal(states.C1.state, 'reviewed:accept');
  fs.writeFileSync(c.paths.findings, FINDINGS.replace('0.03', '0.05'));
  states = Object.fromEntries(claimStates(c).map(x => [x.id, x]));
  assert.equal(states.C1.state, 'stale', 'review no longer matches the edited claim');
  assert.equal(states.C1.audit, null, 'audit no longer matches either');
});

test('cli: steer, pause, withdraw, priority, reconcile write only human-owned files', async () => {
  const {repo, commit} = tempRepo();
  const c = makeCampaign({repo, commit});
  const log = console.log; console.log = () => {};
  try {
    await main(['steer', c.dir, '-m', 'Drop the 4k arm.']);
    await main(['pause', c.dir, 'submissions']);
    await main(['priority', c.dir, 'r1', '3']);
    await main(['withdraw', c.dir, 'r9', '-m', 'duplicate']);
    await main(['reconcile', c.dir, 'r1', '--abandon']);
  } finally { console.log = log; }
  assert.match(fs.readFileSync(c.paths.steering, 'utf8'), /## \d{4}-\d\d-\d\dT\d\d:\d\dZ — Drop the 4k arm\.\n\nDrop the 4k arm\./);
  assert.ok(fs.existsSync(path.join(c.paths.control, 'PAUSE_SUBMISSIONS')));
  assert.deepEqual(JSON.parse(fs.readFileSync(c.paths.priority)), {r1: 3});
  assert.equal(fs.readFileSync(path.join(c.paths.withdraw, 'r9'), 'utf8').trim(), 'duplicate');
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.paths.reconcile, 'r1.json'))).action, 'abandon');
  writeRequest(c, request(commit));
  const ctx = context(c);
  tick(ctx);
  assert.equal(record(c, 'r1').status, 'queued');
  assert.equal(status(c).queue[0].waiting_for, 'paused');
});

test('cli: check-request validates schema and, with a campaign, the commit and script', async () => {
  const {repo, commit} = tempRepo();
  const c = makeCampaign({repo, commit});
  const file = path.join(c.dir, 'r1.json');
  const lines = []; const log = console.log; console.log = s => lines.push(s);
  try {
    fs.writeFileSync(file, JSON.stringify(request(commit)));
    assert.equal(await main(['check-request', file, '--campaign', c.dir]), 0);
    fs.writeFileSync(file, JSON.stringify(request(commit, {script: 'nope.sh'})));
    assert.equal(await main(['check-request', file, '--campaign', c.dir]), 1);
  } finally { console.log = log; }
  assert.match(lines.join('\n'), /not committed/);
});

test('cli: init creates a campaign from the templates with the repo HEAD as base commit', async () => {
  const {repo, commit} = tempRepo();
  const cfg = (await import('./helpers.mjs')).tempDir('arc-config-');
  const root = (await import('./helpers.mjs')).tempDir('arc-runs-');
  fs.writeFileSync(path.join(cfg, 'site.mjs'), `export const runs_root = ${JSON.stringify(root)};\nexport function route() { return {args: []}; }\n`);
  const prev = process.env.ARC_CONFIG_DIR; process.env.ARC_CONFIG_DIR = cfg;
  const log = console.log; console.log = () => {};
  try { assert.equal(await main(['init', 'new-study', '--repo', repo]), 0); }
  finally { console.log = log; if (prev === undefined) delete process.env.ARC_CONFIG_DIR; else process.env.ARC_CONFIG_DIR = prev; }
  const config = JSON.parse(fs.readFileSync(path.join(root, 'new-study', 'campaign.json')));
  assert.equal(config.id, 'new-study');
  assert.equal(config.base_commit, commit);
  assert.ok(fs.existsSync(path.join(root, 'new-study', 'brief.md')));
});

test('verdicts: the first answer per claim wins and bullets under "Material issues" are not verdicts', () => {
  const v = parseVerdicts('C1: supported — ok\nC2: unsupported — one seed\n\nMaterial issues:\n- C1: unsupported the number differs\n- C2: supported only by one run');
  assert.equal(v.C1.verdict, 'supported');
  assert.equal(v.C2.verdict, 'unsupported');
});

test('a systemctl hiccup does not end a running turn; only a definite inactive/failed does', async () => {
  const {repo, commit} = tempRepo();
  const c = makeCampaign({repo, commit, pauseWorker: false});
  let state = 'unknown';
  const systemd = {started: [], start(unit) { this.started.push(unit); }, isActive: () => !['inactive', 'failed'].includes(state)};
  const ctx = context(c, {systemd});
  tick(ctx);
  assert.equal(systemd.started.length, 1);
  assert.match(systemd.started[0], /^arc-test-campaign\.worker-0001$/);
  ctx.now += 5 * MIN; tick(ctx);
  assert.ok(loadTurns(c).worker.active, 'still tracked while systemctl answers unknown');
  ctx.now += 5 * MIN; tick(ctx);
  assert.equal(systemd.started.length, 1, 'no second turn');
  state = 'inactive';
  ctx.now += 1 * MIN; tick(ctx);
  assert.equal(loadTurns(c).worker.consecutive_failures, 1, 'gone without an exit record counts as a failure');
});

test('advisor flag rate: a clean audit is not flagged', async () => {
  const {repo, commit} = tempRepo();
  const c = makeCampaign({repo, commit, config: {advisor: {agent: 'claude', model: 'stub-model', bin: (await import('./helpers.mjs')).STUB_AGENT}}});
  fs.writeFileSync(c.paths.findings, FINDINGS);
  fs.writeFileSync(path.join(c.dir, 'stub-report-advisor'), 'C1: supported — fine\nC2: supported — fine\n\nMaterial issues: none');
  const ctx = context(c);
  tick(ctx); ctx.now += 1000; tick(ctx);
  assert.deepEqual(loadTurns(c).advisor.audits, {total: 1, flagged: 0});
});

test('a job starting to run is not news; a job finishing is', () => {
  const {repo, commit} = tempRepo();
  const c = makeCampaign({repo, commit, pauseWorker: false});
  writeRequest(c, request(commit));
  const ctx = context(c);
  tick(ctx); ctx.now += 1000; tick(ctx); // first turn runs and is harvested; the request is submitted
  ctx.now += 3 * MIN; tick(ctx); ctx.now += 1000; tick(ctx); // the submission itself is news: one more turn
  const after = ctx.systemd.started.length;
  ctx.slurm.set(record(c, 'r1').job_id, 'RUNNING');
  for (let i = 0; i < 5; i++) { ctx.now += 5 * MIN; tick(ctx); }
  assert.equal(ctx.systemd.started.length, after, 'PENDING -> RUNNING does not wake the worker');
  ctx.slurm.set(record(c, 'r1').job_id, 'COMPLETED');
  ctx.now += 1 * MIN; tick(ctx); ctx.now += 2 * MIN; tick(ctx);
  assert.equal(ctx.systemd.started.length, after + 1, 'the job finishing does');
});

test('the hourly wake-up with nothing new is a short check-in, with its own cheaper settings', () => {
  const {repo, commit} = tempRepo();
  const c = makeCampaign({repo, commit, pauseWorker: false, config: {worker: {agent: 'claude', model: 'stub-model', bin: STUB_AGENT, checkin: {effort: 'low'}}}});
  writeRequest(c, request(commit));
  const ctx = context(c);
  tick(ctx); ctx.now += 1000; tick(ctx);
  ctx.now += 3 * MIN; tick(ctx); ctx.now += 1000; tick(ctx); // the accepted submission is news: a full turn
  const n = loadTurns(c).worker.n;
  ctx.now += 61 * MIN; tick(ctx); ctx.now += 1000; tick(ctx);
  const t = loadTurns(c).worker;
  assert.equal(t.n, n + 1);
  const prompt = fs.readFileSync(path.join(c.paths.turns, `worker-${String(n + 1).padStart(4, '0')}.prompt.md`), 'utf8');
  assert.match(prompt, /# Scheduled check-in/);
  assert.match(prompt, /slurm-\d+\.log/);
  assert.ok(!prompt.includes('## Request schema'), 'no schema, brief or full findings in a check-in');
  assert.ok(prompt.length < 4000, `check-in prompt is short (${prompt.length} chars)`);
  assert.equal(t.totals.checkins, 1);
  const full = fs.readFileSync(path.join(c.paths.turns, `worker-${String(n).padStart(4, '0')}.prompt.md`), 'utf8');
  assert.ok(full.includes('## Request schema'), 'news turns stay full');
});
