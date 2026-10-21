// Test fixtures: a fake Slurm, a fake systemd that runs turns synchronously, and throwaway git repos and campaigns.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {TERMINAL} from '../src/slurm.mjs';
import {loadCampaign} from '../src/campaign.mjs';
import {newContext} from '../src/controller.mjs';
import {readJsonl} from '../src/fsutil.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STUB_AGENT = path.join(HERE, 'stub-agent.sh');

export function fakeSlurm() {
  const jobs = new Map();
  const plan = [];
  let next = 1000;
  const arg = (args, flag) => args.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
  const make = (args, script) => {
    const id = String(next++);
    jobs.set(id, {id, name: arg(args, '--job-name'), comment: arg(args, '--comment'), state: 'PENDING', held: args.includes('--hold'),
      gpus: Number(arg(args, '--gres')?.split(':').pop() ?? 0), args, script, exit: null});
    return id;
  };
  const fail = msg => Object.assign(new Error(msg), {stderr: msg});
  return {
    jobs, plan,
    submit(args, script) {
      const mode = plan.shift() ?? 'ok';
      if (mode === 'ok') return {ok: true, id: make(args, script)};
      if (mode === 'definite') return {ok: false, kind: 'definite', error: 'sbatch: error: Batch job submission failed: Invalid partition'};
      if (mode === 'timeout-created') { make(args, script); return {ok: false, kind: 'ambiguous', error: 'Socket timed out on send/recv'}; }
      if (mode === 'timeout-none') return {ok: false, kind: 'ambiguous', error: 'Socket timed out on send/recv'};
      if (mode === 'crash-after-create') { make(args, script); throw new Error('simulated controller crash after sbatch'); }
      throw Error(`unknown plan ${mode}`);
    },
    queue: () => [...jobs.values()].filter(j => !TERMINAL.has(j.state)).map(({id, name, comment, state, held, gpus}) => ({id, name, comment, state, held, gpus})),
    acct: ids => ids.filter(id => jobs.has(id)).map(id => ({id, state: jobs.get(id).state, exit: jobs.get(id).exit ?? '0:0', elapsed: 42})),
    acctByName: name => [...jobs.values()].filter(j => j.name === name).map(j => ({id: j.id, state: j.state, name: j.name})),
    release(id) {
      const j = jobs.get(id);
      if (!j) throw fail('scontrol: error: Invalid job id specified');
      if (!j.held) throw fail('scontrol: error: Job is not held');
      j.held = false;
    },
    cancel(ids) { for (const id of ids) if (jobs.has(id)) jobs.get(id).state = 'CANCELLED'; },
    exec: () => '',
    set(id, state, exit = '0:0') { Object.assign(jobs.get(id), {state, exit}); },
  };
}

// Runs each turn synchronously through the real `arc turn` runner.
export function fakeSystemd() {
  const started = [];
  return {
    started,
    start(unit, argv, {cwd, env}) {
      started.push(unit);
      const r = spawnSync(argv[0], argv.slice(1), {cwd, env: {...process.env, ...env}, encoding: 'utf8'});
      if (r.error) throw r.error;
    },
    isActive: () => false,
  };
}

export const testSite = {route: r => ({args: ['--partition=test', ...(r.gpus ? [`--gres=gpu:${r.gpus}`] : []), `--cpus-per-task=${r.cpus}`, `--mem=${r.mem_gb}G`, `--time=${r.minutes}`]}),
  validate: () => {}, forbidden: () => [], prompt: 'Test cluster: one partition.', path: process.env.PATH};

const sh = (cwd, cmd, args) => execFileSync(cmd, args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();

export function commitFiles(repo, files, message = 'change') {
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), {recursive: true});
    fs.writeFileSync(path.join(repo, name), body);
  }
  sh(repo, 'git', ['add', '-A']);
  sh(repo, 'git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message]);
  return sh(repo, 'git', ['rev-parse', 'HEAD']);
}

const TEMP = [];
process.on('exit', () => { for (const d of TEMP) fs.rmSync(d, {recursive: true, force: true}); });
export function tempDir(prefix = 'arc-test-') { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TEMP.push(d); return d; }

export function tempRepo() {
  const repo = tempDir('arc-repo-');
  sh(repo, 'git', ['init', '-q', '-b', 'main']);
  const commit = commitFiles(repo, {
    'experiments/train.sh': 'echo "{\\"val_loss\\": 1.0}" > "$ARC_RUN_DIR/metrics.json"\n',
    'eval/score.sh': 'echo score\n',
  }, 'initial');
  return {repo, commit};
}

export function makeCampaign({repo, commit, config = {}, worktree = true, pauseWorker = true}) {
  const dir = tempDir('arc-campaign-');
  const base = {id: 'test-campaign', repo, base_commit: commit, gpu_cap: 8, deadline: 'none',
    worker: {agent: 'claude', model: 'stub-model', bin: STUB_AGENT}, ...config};
  fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify(base, null, 2));
  fs.writeFileSync(path.join(dir, 'brief.md'), '# Goal\nTest the harness.\n');
  fs.writeFileSync(path.join(dir, 'steering.md'), '# Steering\n');
  for (const d of ['control', 'requests', 'withdraw', 'state/requests', 'artifacts', 'turns', 'control/reconcile']) fs.mkdirSync(path.join(dir, d), {recursive: true});
  if (pauseWorker) fs.writeFileSync(path.join(dir, 'control', 'PAUSE_WORKER'), 'tests\n');
  if (worktree) sh(repo, 'git', ['worktree', 'add', '-q', path.join(dir, 'worktree'), '-b', `arc/${base.id}-${path.basename(dir)}`, commit]);
  return loadCampaign(dir);
}

export function request(commit, over = {}) {
  return {id: 'r1', kind: 'training', source_commit: commit, script: 'experiments/train.sh', gpus: 2, cpus: 4, mem_gb: 16, minutes: 30, seed: 1,
    hypothesis: 'h', baseline: 'b', evaluation: 'e', data_provenance: 'd', config_description: 'c', expected_outputs: ['metrics.json'], ...over};
}

export function writeRequest(c, r) { fs.writeFileSync(path.join(c.paths.requests, `${r.id}.json`), JSON.stringify(r, null, 2)); }

export function context(c, {slurm = fakeSlurm(), systemd = fakeSystemd(), site = testSite, now = Date.parse('2026-10-22T00:00:00Z')} = {}) {
  const events = [];
  const log = (type, data = {}) => events.push({type, ...data});
  const ctx = newContext({c, site, slurm, systemd, log});
  ctx.now = now;
  ctx.events = events;
  return ctx;
}

export const record = (c, id) => JSON.parse(fs.readFileSync(path.join(c.paths.state, 'requests', `${id}.json`), 'utf8'));
export const status = c => JSON.parse(fs.readFileSync(c.paths.status, 'utf8'));
export const eventsFile = c => readJsonl(c.paths.events);
