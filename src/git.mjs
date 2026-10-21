import {execFileSync} from 'node:child_process';

// Long timeout: archives of large repos on shared filesystems are slow. A timeout is a transient error.
export const GIT_TIMEOUT_MS = 30 * 60 * 1000;

export function git(repo, args, {timeout = GIT_TIMEOUT_MS, input, encoding = 'utf8'} = {}) {
  return execFileSync('git', ['-C', repo, ...args], {encoding, timeout, input, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe']});
}

// Returns {ok, code, stdout, stderr} instead of throwing on a non-zero exit (spawn errors and timeouts still throw).
export function gitStatus(repo, args, opts = {}) {
  try {
    return {ok: true, code: 0, stdout: git(repo, args, opts), stderr: ''};
  } catch (err) {
    if (!Number.isInteger(err.status) || err.signal) throw err;
    return {ok: false, code: err.status, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '')};
  }
}

export const commitExists = (repo, commit) => {
  const r = gitStatus(repo, ['cat-file', '-t', commit]);
  return r.ok && r.stdout.trim() === 'commit';
};

// Mode and type of one path in a commit, or null if absent.
export function treeEntry(repo, commit, file) {
  const r = gitStatus(repo, ['ls-tree', commit, '--', file]);
  if (!r.ok || !r.stdout.trim()) return null;
  const [meta, name] = r.stdout.trim().split('\t');
  const [mode, type, object] = meta.split(' ');
  return name === file ? {mode, type, object} : null;
}
