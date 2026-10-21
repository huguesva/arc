// The only module that talks to Slurm. Tests inject a fake with the same interface.
import {execFileSync} from 'node:child_process';
import os from 'node:os';

export const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'OUT_OF_MEMORY', 'NODE_FAIL', 'BOOT_FAIL', 'DEADLINE', 'PREEMPTED', 'REVOKED']);
// Flags the engine owns; the site module may not set them.
export const ENGINE_FLAGS = ['--hold', '--parsable', '--no-requeue', '--job-name', '--comment', '--chdir', '--output', '--error', '-J', '-D', '-o', '-e', '-H'];

const AMBIGUOUS = /timed? ?out|socket|connection|unable to contact|zero bytes|recv|send|communication|slurm_receive|try again later/i;

// GPU count from a squeue gres/tres-per-node string such as "gres/gpu:h100:8", "gpu:4" or "gres/gpu=2".
export function gpusFromGres(gres) {
  const m = String(gres ?? '').match(/gpu(?::[A-Za-z0-9_.-]+)?[:=](\d+)/);
  return m ? Number(m[1]) : 0;
}

// Classify a failed sbatch. Only a clear scheduler rejection is "definite"; anything else may have created a job.
export function classifySubmitError(err) {
  if (err.code === 'ENOENT') return 'definite';
  const stderr = String(err.stderr ?? '') + ' ' + String(err.message ?? '');
  if (Number.isInteger(err.status) && err.status !== 0 && !err.signal && err.code !== 'ETIMEDOUT' && /error/i.test(stderr) && !AMBIGUOUS.test(stderr)) return 'definite';
  return 'ambiguous';
}

export function realSlurm({timeoutMs = 120000, bin = ''} = {}) {
  const run = (exe, args, opts = {}) => execFileSync(bin + exe, args, {encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...opts});
  return {
    submit(args, script) {
      let out;
      try { out = run('sbatch', [...args, script]); }
      catch (err) { return {ok: false, kind: classifySubmitError(err), error: String(err.stderr || err.message).trim().slice(0, 2000)}; }
      const id = out.trim().split(';')[0];
      return /^\d+$/.test(id) ? {ok: true, id} : {ok: false, kind: 'ambiguous', error: `unparseable sbatch output: ${out.slice(0, 200)}`};
    },
    // Jobs of the current user still known to the controller daemon.
    queue() {
      const out = run('squeue', ['-u', os.userInfo().username, '-h', '-o', '%i|%200j|%200k|%T|%200r|%200b|%D']);
      return out.split('\n').filter(Boolean).map(line => {
        const [id, name, comment, state, reason, gres, nodes] = line.split('|').map(s => s.trim());
        return {id, name, comment, state, held: /held/i.test(reason), gpus: gpusFromGres(gres) * (Number(nodes) || 1)};
      });
    },
    acct(ids) {
      if (!ids.length) return [];
      const out = run('sacct', ['-X', '-n', '-P', '-j', ids.join(','), '--format=JobIDRaw,State,ExitCode,ElapsedRaw']);
      return out.split('\n').filter(Boolean).map(line => {
        const [id, state, exit, elapsed] = line.split('|');
        return {id, state: state.split(/[ +]/)[0], exit, elapsed: Number(elapsed) || 0};
      });
    },
    acctByName(name, sinceIso) {
      const out = run('sacct', ['-X', '-n', '-P', '--name=' + name, '-S', sinceIso.slice(0, 19), '--format=JobIDRaw,State,JobName']);
      return out.split('\n').filter(Boolean).map(line => {
        const [id, state, jobName] = line.split('|');
        return {id, state: state.split(/[ +]/)[0], name: jobName};
      }).filter(r => r.name === name);
    },
    release(id) { run('scontrol', ['release', id]); },
    cancel(ids) { if (ids.length) run('scancel', ids); },
    exec: (exe, args) => run(exe, args),
  };
}
