import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {tick} from '../src/controller.mjs';
import {fakeSlurm, tempRepo, makeCampaign, request, writeRequest, context, record, status, commitFiles, testSite} from './helpers.mjs';

const MIN = 60000;
const setup = (config = {}) => { const {repo, commit} = tempRepo(); const c = makeCampaign({repo, commit, config}); return {repo, commit, c}; };
const reconcileCmd = (c, id, cmd) => fs.writeFileSync(path.join(c.paths.reconcile, `${id}.json`), JSON.stringify(cmd));

test('happy path: frozen, submitted held, study written, then released in the same tick', () => {
  const {c, commit} = setup();
  writeRequest(c, request(commit));
  const ctx = context(c);
  tick(ctx);
  const rec = record(c, 'r1');
  assert.equal(rec.status, 'submitted');
  assert.equal(rec.released, true);
  const job = ctx.slurm.jobs.get(rec.job_id);
  assert.equal(job.held, false);
  assert.ok(job.args.includes('--hold'));
  assert.equal(job.comment, 'arc:test-campaign:r1');
  const out = path.join(c.paths.artifacts, 'r1');
  for (const f of ['source.tar', 'run.sh', 'request.json', 'provenance.json', 'study.json']) assert.ok(fs.existsSync(path.join(out, f)), f);
  const types = ctx.events.map(e => e.type);
  assert.ok(types.indexOf('submitting') < types.indexOf('submitted') && types.indexOf('submitted') < types.indexOf('released'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'study.json'))).jobs[0].id, rec.job_id);
  assert.equal(status(c).budget.reserved, 2);
});

test('terminal state finishes the record and appends a ledger line', () => {
  const {c, commit} = setup();
  const ledger = path.join(c.dir, 'runs.md');
  fs.writeFileSync(path.join(c.dir, 'campaign.json'), JSON.stringify({...c.config, cadence: undefined, ledger_md: ledger}));
  const c2 = {...c, config: {...c.config, ledger_md: ledger}};
  writeRequest(c2, request(commit));
  const ctx = context(c2);
  tick(ctx);
  ctx.slurm.set(record(c2, 'r1').job_id, 'COMPLETED');
  tick(ctx);
  const rec = record(c2, 'r1');
  assert.equal(rec.status, 'finished');
  assert.equal(rec.slurm_state, 'COMPLETED');
  const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /submitted/);
  assert.match(lines[1], /COMPLETED/);
  assert.equal(status(c2).budget.reserved, 0);
});

test('crash after sbatch created the job: restart adopts it, no duplicate', () => {
  const {c, commit} = setup();
  writeRequest(c, request(commit));
  const ctx = context(c);
  ctx.slurm.plan.push('crash-after-create');
  tick(ctx); // the failure stays inside the admit phase; the intent is left unresolved, as after a real crash
  assert.equal(record(c, 'r1').status, 'submitting');
  assert.ok(status(c).alerts.some(a => a.code === 'controller_error' && /simulated controller crash/.test(a.message)));
  tick(ctx);
  const rec = record(c, 'r1');
  assert.equal(rec.status, 'submitted');
  assert.equal(ctx.slurm.jobs.size, 1);
  assert.equal(ctx.slurm.jobs.get(rec.job_id).held, false, 'adopted held job is released');
});

test('sbatch timeout without a job: uncertain, GPUs reserved, never resubmitted, others proceed', () => {
  const {c, commit} = setup({gpu_cap: 4});
  writeRequest(c, request(commit, {id: 'a', gpus: 2}));
  writeRequest(c, request(commit, {id: 'b', gpus: 2}));
  writeRequest(c, request(commit, {id: 'z', gpus: 1}));
  const ctx = context(c);
  ctx.slurm.plan.push('timeout-none');
  tick(ctx);
  assert.equal(record(c, 'a').status, 'uncertain');
  assert.equal(record(c, 'b').status, 'submitted', 'one uncertain request does not freeze the campaign');
  assert.equal(record(c, 'z').status, 'queued', 'uncertain GPUs still count: 2 + 2 of 4');
  for (let i = 0; i < 3; i++) { ctx.now += 10 * MIN; tick(ctx); }
  assert.equal(ctx.slurm.jobs.size, 1, 'never resubmitted');
  const s = status(c);
  assert.ok(s.alerts.some(a => a.code === 'uncertain_submission'));
  reconcileCmd(c, 'a', {action: 'abandon'});
  tick(ctx);
  assert.equal(record(c, 'a').status, 'dropped');
  assert.equal(record(c, 'z').status, 'submitted');
  assert.ok(!status(c).alerts.some(a => a.code === 'uncertain_submission'), 'alert clears itself');
});

test('sbatch timeout that did create the job: adopted on the next tick', () => {
  const {c, commit} = setup();
  writeRequest(c, request(commit));
  const ctx = context(c);
  ctx.slurm.plan.push('timeout-created');
  tick(ctx);
  assert.equal(record(c, 'r1').status, 'uncertain');
  tick(ctx);
  assert.equal(record(c, 'r1').status, 'submitted');
  assert.equal(ctx.slurm.jobs.size, 1);
});

test('definite sbatch error: retried later with the same id, never rejected', () => {
  const {c, commit} = setup();
  writeRequest(c, request(commit));
  const ctx = context(c);
  ctx.slurm.plan.push('definite', 'definite');
  tick(ctx);
  let rec = record(c, 'r1');
  assert.equal(rec.status, 'queued');
  assert.equal(rec.attempts, 1);
  assert.match(rec.last_error, /Invalid partition/);
  tick(ctx);
  assert.equal(record(c, 'r1').attempts, 1, 'waits for retry_at');
  ctx.now += 3 * MIN; tick(ctx);
  assert.equal(record(c, 'r1').attempts, 2);
  ctx.now += 5 * MIN; tick(ctx);
  rec = record(c, 'r1');
  assert.equal(rec.status, 'submitted');
});

test('validation: unknown field, name mismatch, missing commit, uncommitted script, forbidden command', () => {
  const {c, commit, repo} = setup();
  const bad = commitFiles(repo, {'experiments/bad.sh': 'sbatch other.sh\n'});
  writeRequest(c, request(commit, {id: 'unknown', env: {X: '1'}}));
  fs.writeFileSync(path.join(c.paths.requests, 'mismatch.json'), JSON.stringify(request(commit, {id: 'other'})));
  writeRequest(c, request('0'.repeat(40), {id: 'nocommit'}));
  writeRequest(c, request(commit, {id: 'noscript', script: 'experiments/missing.sh'}));
  writeRequest(c, request(bad, {id: 'forbidden', script: 'experiments/bad.sh'}));
  fs.writeFileSync(path.join(c.paths.requests, 'Bad Name.json'), '{}');
  const ctx = context(c);
  tick(ctx);
  assert.match(record(c, 'unknown').reason, /unknown field "env"/);
  assert.match(record(c, 'mismatch').reason, /must equal the file name/);
  assert.match(record(c, 'nocommit').reason, /does not exist/);
  assert.match(record(c, 'noscript').reason, /not committed/);
  assert.match(record(c, 'forbidden').reason, /sbatch/);
  for (const id of ['unknown', 'mismatch', 'nocommit', 'noscript', 'forbidden']) assert.equal(record(c, id).status, 'rejected');
  assert.ok(status(c).alerts.some(a => a.code === 'bad_request_file'));
  assert.equal(ctx.slurm.jobs.size, 0);
});

test('priority: a blocked higher priority is never overtaken by lower; same priority backfills', () => {
  const {c, commit} = setup({gpu_cap: 8});
  const ctx = context(c);
  writeRequest(c, request(commit, {id: 'running', gpus: 4}));
  tick(ctx);
  writeRequest(c, request(commit, {id: 'big', gpus: 8, priority: 1}));
  ctx.now += 1000; tick(ctx);
  writeRequest(c, request(commit, {id: 'small-low', gpus: 1, priority: 0}));
  writeRequest(c, request(commit, {id: 'small-high', gpus: 2, priority: 1}));
  ctx.now += 1000; tick(ctx);
  assert.equal(record(c, 'big').status, 'queued');
  assert.equal(record(c, 'small-high').status, 'submitted', 'same priority backfills');
  assert.equal(record(c, 'small-low').status, 'queued', 'lower priority waits behind the blocked one');
  const q = Object.fromEntries(status(c).queue.map(x => [x.id, x.waiting_for]));
  assert.equal(q.big, 'budget');
  assert.equal(q['small-low'], 'priority');
  fs.writeFileSync(c.paths.priority, JSON.stringify({'small-low': 5}));
  ctx.now += 1000; tick(ctx);
  assert.equal(record(c, 'small-low').status, 'submitted', 'arc priority override');
});

test('admission is by first sight, not alphabetical', () => {
  const {c, commit} = setup({gpu_cap: 2});
  const ctx = context(c);
  writeRequest(c, request(commit, {id: 'zeta', gpus: 2}));
  tick(ctx);
  writeRequest(c, request(commit, {id: 'alpha', gpus: 2}));
  writeRequest(c, request(commit, {id: 'mid', gpus: 2}));
  ctx.now += 1000; tick(ctx);
  ctx.slurm.set(record(c, 'zeta').job_id, 'COMPLETED');
  ctx.now += 1000; tick(ctx);
  // alpha and mid were first seen in the same tick; tie broken by id. zeta was first.
  assert.equal(record(c, 'alpha').status, 'submitted');
  assert.equal(record(c, 'mid').status, 'queued');
});

test('dependencies wait, then proceed on COMPLETED or drop on failure', () => {
  const {c, commit} = setup();
  const ctx = context(c);
  writeRequest(c, request(commit, {id: 'train', gpus: 1}));
  writeRequest(c, request(commit, {id: 'eval', gpus: 1, after: ['train']}));
  writeRequest(c, request(commit, {id: 'train2', gpus: 1}));
  writeRequest(c, request(commit, {id: 'eval2', gpus: 1, after: ['train2']}));
  tick(ctx);
  assert.equal(record(c, 'eval').status, 'queued');
  ctx.slurm.set(record(c, 'train').job_id, 'COMPLETED');
  ctx.slurm.set(record(c, 'train2').job_id, 'FAILED', '1:0');
  tick(ctx); tick(ctx);
  assert.equal(record(c, 'eval').status, 'submitted');
  assert.equal(record(c, 'eval2').status, 'dropped');
  assert.match(record(c, 'eval2').reason, /dependency_failed/);
});

test('requests are immutable; withdrawal only before submission', () => {
  const {c, commit} = setup({gpu_cap: 2});
  const ctx = context(c);
  writeRequest(c, request(commit, {id: 'sub', gpus: 2}));
  writeRequest(c, request(commit, {id: 'wait', gpus: 2}));
  tick(ctx);
  writeRequest(c, request(commit, {id: 'sub', gpus: 2, seed: 99}));
  fs.writeFileSync(path.join(c.paths.withdraw, 'wait'), 'not needed\n');
  fs.writeFileSync(path.join(c.paths.withdraw, 'sub'), 'too late\n');
  tick(ctx);
  assert.equal(record(c, 'sub').request.seed, 1, 'original content kept');
  assert.equal(record(c, 'wait').status, 'dropped');
  const codes = status(c).alerts.map(a => a.code);
  assert.ok(codes.includes('request_mutated'));
  assert.ok(codes.includes('withdraw_after_submit'));
});

test('deadline closes admission but keeps jobs; evaluator status is recorded', () => {
  const {repo, commit} = tempRepo();
  const changed = commitFiles(repo, {'eval/score.sh': 'echo better score\n'});
  const c = makeCampaign({repo, commit, config: {deadline: '2026-10-22T01:00:00Z', evaluator: {commit, paths: ['eval/']}}});
  const ctx = context(c);
  writeRequest(c, request(commit, {id: 'same', gpus: 1}));
  writeRequest(c, request(changed, {id: 'edited', gpus: 1}));
  tick(ctx);
  assert.equal(record(c, 'same').evaluator_status, 'unmodified');
  assert.equal(record(c, 'edited').evaluator_status, 'modified');
  assert.ok(status(c).alerts.some(a => a.code === 'evaluator_modified'));
  ctx.now = Date.parse('2026-10-22T02:00:00Z');
  writeRequest(c, request(commit, {id: 'late', gpus: 1}));
  tick(ctx);
  assert.equal(record(c, 'late').status, 'queued');
  assert.equal(status(c).queue.find(q => q.id === 'late').waiting_for, 'deadline');
  assert.equal(status(c).deadline.closed, true);
  ctx.slurm.set(record(c, 'same').job_id, 'COMPLETED');
  tick(ctx);
  assert.equal(record(c, 'same').status, 'finished', 'existing jobs keep being followed after the deadline');
});

test('STOP: the controller exits without touching jobs', () => {
  const {c, commit} = setup();
  const ctx = context(c);
  writeRequest(c, request(commit));
  tick(ctx);
  fs.writeFileSync(path.join(c.paths.control, 'STOP'), 'done\n');
  assert.deepEqual(tick(ctx), {stop: true});
  assert.equal(status(c).controller.phase, 'stopped');
  assert.equal([...ctx.slurm.jobs.values()][0].state, 'PENDING');
});

test('orphan campaign jobs count against the budget', () => {
  const {c, commit} = setup({gpu_cap: 4});
  const ctx = context(c);
  ctx.slurm.jobs.set('77', {id: '77', name: 'x', comment: 'arc:test-campaign:ghost', state: 'RUNNING', held: false, gpus: 3});
  writeRequest(c, request(commit, {gpus: 2}));
  tick(ctx);
  assert.equal(record(c, 'r1').status, 'queued');
  assert.equal(status(c).budget.orphan_gpus, 3);
  assert.ok(status(c).alerts.some(a => a.code === 'orphan_job'));
});

test('run.sh: scheduler commands are shadowed even when hidden from the static scan', () => {
  const {repo, commit: base} = tempRepo();
  const commit = commitFiles(repo, {'experiments/sneaky.sh': 'c=sb; c="${c}atch"; $c --version\n'});
  const c = makeCampaign({repo, commit: base});
  writeRequest(c, request(commit, {script: 'experiments/sneaky.sh', gpus: 0}));
  const ctx = context(c);
  tick(ctx);
  assert.equal(record(c, 'r1').status, 'submitted');
  const out = path.join(c.paths.artifacts, 'r1');
  const r = spawnSync('bash', [path.join(out, 'run.sh')], {encoding: 'utf8', env: {...process.env, SLURM_JOB_ID: '1', SLURM_CPUS_PER_TASK: '2'}});
  assert.equal(r.status, 97);
  assert.match(r.stderr, /blocked inside campaign jobs/);
  const failed = JSON.parse(fs.readFileSync(path.join(out, 'execution.json')));
  assert.equal(failed.exit_code, 97);
  assert.deepEqual(failed.outputs, [{path: 'metrics.json', missing: true}]);
  assert.ok(fs.existsSync(path.join(out, 'source', 'experiments', 'sneaky.sh')), 'source extracted by the job');
});

test('run.sh runs the frozen script and records its outputs', () => {
  const {c, commit, repo} = setup();
  writeRequest(c, request(commit, {gpus: 0}));
  const ctx = context(c);
  tick(ctx);
  commitFiles(repo, {'experiments/train.sh': 'exit 3\n'}); // later edits must not affect the frozen job
  const out = path.join(c.paths.artifacts, 'r1');
  const r = spawnSync('bash', [path.join(out, 'run.sh')], {encoding: 'utf8', env: {...process.env, SLURM_JOB_ID: '5'}});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'metrics.json'))), {val_loss: 1});
  const exec = JSON.parse(fs.readFileSync(path.join(out, 'execution.json')));
  assert.equal(exec.job_id, '5');
  const metrics = fs.readFileSync(path.join(out, 'metrics.json'));
  const sha256 = execFileSync('sha256sum', [path.join(out, 'metrics.json')], {encoding: 'utf8'}).split(' ')[0];
  assert.deepEqual(exec.outputs, [{path: 'metrics.json', sha256, bytes: metrics.length}]);
});

test('status has the fixed schema', () => {
  const {c} = setup();
  tick(context(c));
  const s = status(c);
  for (const k of ['schema', 'campaign', 'generated_at', 'controller', 'deadline', 'budget', 'counts', 'queue', 'jobs', 'roles', 'claims', 'blocked', 'alerts']) assert.ok(k in s, k);
  assert.equal(s.schema, 'arc.status/1');
  for (const k of ['pid', 'version', 'started_at', 'heartbeat_at', 'phase']) assert.ok(k in s.controller, k);
});

test('a git worktree is not required to be clean; uncommitted changes are recorded, not run', () => {
  const {c, commit} = setup();
  fs.writeFileSync(path.join(c.paths.worktree, 'scratch.txt'), 'wip');
  writeRequest(c, request(commit));
  tick(context(c));
  const prov = JSON.parse(fs.readFileSync(path.join(c.paths.artifacts, 'r1', 'provenance.json')));
  assert.ok(prov.ignored_worktree_changes.some(l => l.includes('scratch.txt')));
  const listing = execFileSync('tar', ['-tf', path.join(c.paths.artifacts, 'r1', 'source.tar')], {encoding: 'utf8'});
  assert.ok(!listing.includes('scratch.txt'));
});

test('a half-written request file is retried, not rejected, while it is fresh', () => {
  const {c, commit} = setup();
  const file = path.join(c.paths.requests, 'r1.json');
  fs.writeFileSync(file, '{"id": "r1", "kind": ');
  const ctx = context(c);
  ctx.now = Date.now();
  tick(ctx);
  assert.ok(!fs.existsSync(path.join(c.paths.state, 'requests', 'r1.json')), 'not recorded yet');
  writeRequest(c, request(commit));
  ctx.now = Date.now(); tick(ctx);
  assert.equal(record(c, 'r1').status, 'submitted');
});

test('a request larger than the GPU budget is rejected instead of blocking the queue forever', () => {
  const {c, commit} = setup({gpu_cap: 4});
  writeRequest(c, request(commit, {id: 'huge', gpus: 8, priority: 9}));
  writeRequest(c, request(commit, {id: 'small', gpus: 1}));
  tick(context(c));
  assert.equal(record(c, 'huge').status, 'rejected');
  assert.match(record(c, 'huge').reason, /never fit/);
  assert.equal(record(c, 'small').status, 'submitted');
});

test('a scheduler outage stops admission but not status or the rest of the tick', () => {
  const {c, commit} = setup();
  writeRequest(c, request(commit));
  const ctx = context(c);
  const queue = ctx.slurm.queue;
  ctx.slurm.queue = () => { throw Object.assign(new Error('squeue: error: Socket timed out'), {stderr: 'Socket timed out'}); };
  tick(ctx);
  assert.equal(record(c, 'r1').status, 'queued', 'no admission without a fresh view of the queue');
  assert.ok(status(c).alerts.some(a => a.code === 'controller_error'));
  ctx.slurm.queue = queue;
  tick(ctx);
  assert.equal(record(c, 'r1').status, 'submitted');
  assert.ok(!status(c).alerts.some(a => a.code === 'controller_error'), 'clears on the next good tick');
});

test('a job found only in accounting (already finished) is adopted, recorded and finished, never stuck', () => {
  const {c, commit} = setup();
  writeRequest(c, request(commit, {id: 'train', gpus: 1}));
  writeRequest(c, request(commit, {id: 'eval', gpus: 1, after: ['train']}));
  const ctx = context(c);
  ctx.slurm.plan.push('crash-after-create');
  tick(ctx);
  const job = [...ctx.slurm.jobs.values()][0];
  ctx.slurm.set(job.id, 'CANCELLED'); // e.g. a human cancelled the held job while the controller was down
  tick(ctx);
  const rec = record(c, 'train');
  assert.equal(rec.status, 'finished');
  assert.equal(rec.slurm_state, 'CANCELLED');
  assert.ok(fs.existsSync(path.join(c.paths.artifacts, 'train', 'study.json')), 'study written on adoption');
  tick(ctx);
  assert.equal(record(c, 'eval').status, 'dropped', 'dependents resolve instead of waiting forever');
});

test('a queued request whose token is already in the queue is adopted, not submitted twice', () => {
  const {c, commit} = setup();
  writeRequest(c, request(commit));
  const ctx = context(c);
  ctx.slurm.plan.push('definite');
  tick(ctx);
  assert.equal(record(c, 'r1').status, 'queued');
  // the "definite" error was wrong: a job exists after all
  ctx.slurm.jobs.set('555', {id: '555', name: 'test-campaign-r1', comment: 'arc:test-campaign:r1', state: 'PENDING', held: true, gpus: 2});
  ctx.now += 10 * MIN; tick(ctx);
  assert.equal(record(c, 'r1').job_id, '555');
  assert.equal(ctx.slurm.jobs.size, 1);
  assert.equal(ctx.slurm.jobs.get('555').held, false);
});

test('a job still held after a release is released again', () => {
  const {c, commit} = setup();
  writeRequest(c, request(commit));
  const ctx = context(c);
  tick(ctx);
  const id = record(c, 'r1').job_id;
  ctx.slurm.jobs.get(id).held = true; // e.g. a release that silently did not take
  tick(ctx);
  assert.equal(ctx.slurm.jobs.get(id).held, false);
});

test('site.notify is opt-in and called once per new alert, again only after it clears and returns', () => {
  const {c} = setup();
  const calls = [];
  const site = {...testSite, notify: a => calls.push(a)};
  const ctx = context(c, {site});
  tick(ctx);
  assert.equal(calls.length, 0, 'no alerts, nothing sent');
  fs.writeFileSync(c.paths.blocked, 'The gate cannot be computed.\n');
  ctx.now += MIN; tick(ctx);
  ctx.now += MIN; tick(ctx);
  assert.deepEqual(calls.map(a => [a.campaign, a.code]), [['test-campaign', 'blocked']], 'sent once, not every tick');
  assert.match(calls[0].message, /gate cannot be computed/);
  fs.writeFileSync(c.paths.blocked, '');
  ctx.now += MIN; tick(ctx);
  fs.writeFileSync(c.paths.blocked, 'Still stuck.\n');
  ctx.now += MIN; tick(ctx);
  assert.equal(calls.length, 2, 'a cleared alert that returns is sent again');

  const failing = {...testSite, notify: () => { throw Error('notifier down'); }};
  const ctx2 = context(c, {site: failing});
  fs.writeFileSync(c.paths.findings, Array(200).fill('line').join('\n'));
  ctx2.now += MIN; tick(ctx2);
  assert.ok(ctx2.events.some(e => e.type === 'notify_error' && e.code === 'findings_long' && /notifier down/.test(e.error)), 'errors are logged');
  assert.ok(fs.existsSync(c.paths.status), 'and never stop the tick');
});

test('without site.notify nothing is sent and no notification state is kept', () => {
  const {c} = setup();
  fs.writeFileSync(c.paths.blocked, 'stuck\n');
  const ctx = context(c);
  tick(ctx);
  assert.ok(status(c).alerts.some(a => a.code === 'blocked'));
  assert.ok(!fs.existsSync(path.join(c.paths.state, 'notified.json')));
});
