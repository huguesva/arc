// User systemd: transient units for agent turns, and the controller service.
import {execFileSync} from 'node:child_process';

const run = (exe, args) => execFileSync(exe, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000});

export function unitState(unit) {
  try { return run('systemctl', ['--user', 'is-active', unit]).trim(); }
  catch (err) { return String(err.stdout ?? '').trim() || 'unknown'; }
}

export function realSystemd() {
  return {
    start(unit, argv, {cwd, env}) {
      const setenv = Object.entries(env).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `--setenv=${k}=${v}`);
      run('systemd-run', ['--user', '--collect', '--quiet', `--unit=${unit}`, `--working-directory=${cwd}`, ...setenv, ...argv]);
    },
    isActive: unit => ['active', 'activating', 'deactivating', 'reloading'].includes(unitState(unit)),
  };
}

export const systemctl = (...args) => run('systemctl', ['--user', ...args]);
