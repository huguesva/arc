// Campaign directory layout, campaign.json validation, registry and site loading.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readJson} from './fsutil.mjs';

export const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const AGENTS = ['codex', 'claude'];

export const configDir = () => process.env.ARC_CONFIG_DIR || path.join(os.homedir(), '.config', 'arc');

export function paths(dir) {
  const p = name => path.join(dir, name);
  return {
    dir, config: p('campaign.json'), brief: p('brief.md'), steering: p('steering.md'),
    control: p('control'), requests: p('requests'), withdraw: p('withdraw'),
    findings: p('findings.md'), notes: p('notes.md'), blocked: p('blocked.md'), worktree: p('worktree'),
    state: p('state'), artifacts: p('artifacts'), turns: p('turns'),
    events: p('events.jsonl'), status: p('status.json'),
    reviews: path.join(dir, 'control', 'reviews.jsonl'),
    priority: path.join(dir, 'control', 'priority.json'),
    reconcile: path.join(dir, 'control', 'reconcile'),
  };
}

function checkRole(name, rc, errors, {advisor = false} = {}) {
  if (!rc || typeof rc !== 'object') return errors.push(`${name} must be an object`);
  const allowed = ['agent', 'model', 'bin', 'profile', 'effort', 'args', 'env', ...(advisor ? ['every_min'] : [])];
  for (const k of Object.keys(rc)) if (!allowed.includes(k)) errors.push(`${name}.${k} is not a known field`);
  if (!AGENTS.includes(rc.agent)) errors.push(`${name}.agent must be one of ${AGENTS.join(', ')}`);
  if (typeof rc.model !== 'string' || !rc.model) errors.push(`${name}.model is required (exact model id)`);
  for (const k of ['bin', 'profile', 'effort']) if (rc[k] !== undefined && typeof rc[k] !== 'string') errors.push(`${name}.${k} must be a string`);
  if (rc.args !== undefined && (!Array.isArray(rc.args) || rc.args.some(a => typeof a !== 'string'))) errors.push(`${name}.args must be an array of strings`);
  if (rc.env !== undefined && (typeof rc.env !== 'object' || Object.values(rc.env).some(v => typeof v !== 'string'))) errors.push(`${name}.env must map names to strings`);
  if (advisor && rc.every_min !== undefined && !(Number.isInteger(rc.every_min) && rc.every_min >= 1)) errors.push('advisor.every_min must be a positive integer');
}

export function validateConfig(c) {
  const errors = [];
  const known = ['id', 'repo', 'base_commit', 'gpu_cap', 'deadline', 'job_prefix', 'job_env', 'evaluator', 'worker', 'advisor', 'cadence', 'ledger_md', 'study_spool'];
  for (const k of Object.keys(c)) if (!known.includes(k)) errors.push(`${k} is not a known field`);
  if (!ID_RE.test(c.id ?? '')) errors.push('id must match ' + ID_RE);
  if (typeof c.repo !== 'string' || !path.isAbsolute(c.repo)) errors.push('repo must be an absolute path');
  if (!HEX40.test(c.base_commit ?? '')) errors.push('base_commit must be a full 40-character commit');
  if (!Number.isInteger(c.gpu_cap) || c.gpu_cap < 0) errors.push('gpu_cap must be a non-negative integer');
  if (c.deadline !== 'none' && !Number.isFinite(Date.parse(c.deadline ?? ''))) errors.push('deadline must be an ISO time or "none"');
  if (c.job_prefix !== undefined && !/^[a-z][a-z0-9-]{0,15}$/.test(c.job_prefix)) errors.push('job_prefix must be short lowercase');
  if (c.job_env !== undefined && (typeof c.job_env !== 'object' || Object.entries(c.job_env).some(([k, v]) => !/^[A-Z_][A-Z0-9_]*$/.test(k) || typeof v !== 'string'))) errors.push('job_env must map UPPER_CASE names to strings');
  if (c.evaluator !== undefined) {
    const e = c.evaluator;
    if (!HEX40.test(e?.commit ?? '')) errors.push('evaluator.commit must be a full commit');
    if (!Array.isArray(e?.paths) || !e.paths.length || e.paths.some(p => typeof p !== 'string' || path.isAbsolute(p) || p.split('/').includes('..'))) errors.push('evaluator.paths must be relative paths');
  }
  checkRole('worker', c.worker, errors);
  if (c.advisor !== undefined && c.advisor !== null) checkRole('advisor', c.advisor, errors, {advisor: true});
  if (c.cadence !== undefined) {
    for (const [k, v] of Object.entries(c.cadence)) {
      if (!['changed_min', 'idle_min', 'busy_min'].includes(k)) errors.push(`cadence.${k} is not a known field`);
      else if (!Number.isInteger(v) || v < 0) errors.push(`cadence.${k} must be a non-negative integer`);
    }
  }
  for (const k of ['ledger_md', 'study_spool']) if (c[k] !== undefined && (typeof c[k] !== 'string' || !path.isAbsolute(c[k]))) errors.push(`${k} must be an absolute path`);
  return errors;
}

export function loadCampaign(dir) {
  dir = path.resolve(dir);
  const p = paths(dir);
  const config = readJson(p.config);
  if (!config) throw Error(`No campaign.json in ${dir}`);
  const errors = validateConfig(config);
  if (errors.length) throw Error(`Invalid campaign.json:\n- ${errors.join('\n- ')}`);
  const cadence = {changed_min: 2, idle_min: 20, busy_min: 60, ...config.cadence};
  return {dir, paths: p, config: {job_prefix: config.id, job_env: {}, advisor: null, ...config, cadence}};
}

export const registryLink = id => path.join(configDir(), 'campaigns', id);

// Accepts a campaign directory or a registered campaign id.
export function resolveCampaignDir(ref) {
  if (fs.existsSync(path.join(ref, 'campaign.json'))) return path.resolve(ref);
  const link = registryLink(ref);
  if (fs.existsSync(path.join(link, 'campaign.json'))) return fs.realpathSync(link);
  throw Error(`Unknown campaign ${ref}: not a campaign directory and not registered in ${path.dirname(link)}`);
}

export const registeredIds = () => {
  const d = path.join(configDir(), 'campaigns');
  return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
};

// The site module holds local cluster policy. It is never committed.
export async function loadSite(file = process.env.ARC_SITE || path.join(configDir(), 'site.mjs')) {
  if (!fs.existsSync(file)) throw Error(`No site module at ${file}; copy templates/site.example.mjs there and adapt it`);
  const site = await import(pathToFileURL(file).href);
  for (const fn of ['route']) if (typeof site[fn] !== 'function') throw Error(`site module must export ${fn}()`);
  return {
    validate: () => {}, forbidden: () => [], prompt: '', path: process.env.PATH,
    ...site, file,
  };
}

export const deadlineMs = config => (config.deadline === 'none' ? null : Date.parse(config.deadline));
