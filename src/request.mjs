// Request schema: one FIELDS table drives validation and the schema text shown to the worker.
import path from 'node:path';
import {commitExists, treeEntry, git} from './git.mjs';

export const REQUEST_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const nonEmpty = v => typeof v === 'string' && v.trim().length > 0;
const relPath = v => typeof v === 'string' && v.length > 0 && !path.isAbsolute(v) && !v.split('/').includes('..');
const intAtLeast = n => v => Number.isInteger(v) && v >= n;

export const FIELDS = {
  id: {required: true, check: v => REQUEST_ID_RE.test(v ?? ''), doc: 'unique id, `[a-z][a-z0-9-]*`, equal to the file name; never reused'},
  kind: {required: true, check: nonEmpty, doc: 'e.g. training, evaluation, diagnostic, smoke'},
  source_commit: {required: true, check: v => /^[0-9a-f]{40}$/.test(v ?? ''), doc: 'full 40-character commit; only committed code runs'},
  script: {required: true, check: relPath, doc: 'bash script path relative to the repository root, committed in source_commit'},
  gpus: {required: true, check: intAtLeast(0), doc: 'integer GPUs (0 for CPU-only)'},
  cpus: {required: true, check: intAtLeast(1), doc: 'integer CPUs per task'},
  mem_gb: {required: true, check: intAtLeast(1), doc: 'integer memory in GB'},
  minutes: {required: true, check: intAtLeast(1), doc: 'integer Slurm walltime in minutes'},
  partition: {required: false, check: nonEmpty, doc: 'optional partition hint, interpreted by the cluster rules'},
  seed: {required: true, check: Number.isInteger, doc: 'integer seed'},
  hypothesis: {required: true, check: nonEmpty, doc: 'what this run tests'},
  baseline: {required: true, check: nonEmpty, doc: 'what it is compared against'},
  evaluation: {required: true, check: nonEmpty, doc: 'how the result will be judged'},
  data_provenance: {required: true, check: nonEmpty, doc: 'data and checkpoint paths with hashes or versions'},
  config_description: {required: true, check: nonEmpty, doc: 'the settings that differ from the baseline'},
  expected_outputs: {required: true, check: v => Array.isArray(v) && v.length > 0 && v.every(relPath), doc: 'non-empty list of paths relative to $ARC_RUN_DIR'},
  after: {required: false, check: v => Array.isArray(v) && v.every(x => REQUEST_ID_RE.test(x)), doc: 'request ids that must finish COMPLETED first'},
  priority: {required: false, check: Number.isInteger, doc: 'integer, default 0; higher runs first'},
  supersedes: {required: false, check: v => REQUEST_ID_RE.test(v ?? ''), doc: 'id of the request this one replaces (lineage only)'},
  ext: {required: false, check: v => v !== null && typeof v === 'object' && !Array.isArray(v), doc: 'free-form object for project-specific fields'},
};

// Pure schema checks. fileId is the file name without .json.
export function validateRequest(r, {fileId} = {}) {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return ['request must be a JSON object'];
  const errors = [];
  for (const k of Object.keys(r)) if (!FIELDS[k]) errors.push(`unknown field "${k}"`);
  for (const [k, f] of Object.entries(FIELDS)) {
    if (r[k] === undefined) { if (f.required) errors.push(`missing ${k}`); continue; }
    if (!f.check(r[k])) errors.push(`invalid ${k}: ${f.doc}`);
  }
  if (fileId !== undefined && r.id !== fileId) errors.push(`id "${r.id}" must equal the file name "${fileId}.json"`);
  if (Array.isArray(r.after) && r.after.includes(r.id)) errors.push('a request cannot depend on itself');
  return errors;
}

export const FORBIDDEN = ['sbatch', 'salloc', 'scancel', 'scontrol'];

// Checks that need the repository. Returns error strings; git timeouts throw (transient).
export function validateInRepo(r, repo, extraForbidden = []) {
  if (!commitExists(repo, r.source_commit)) return [`source_commit ${r.source_commit} does not exist in ${repo}`];
  const entry = treeEntry(repo, r.source_commit, r.script);
  if (!entry) return [`script ${r.script} is not committed in ${r.source_commit}`];
  if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) return [`script ${r.script} must be a regular file (not a symlink or directory)`];
  const body = git(repo, ['show', `${r.source_commit}:${r.script}`]);
  const names = [...FORBIDDEN, ...extraForbidden];
  const found = names.filter(n => new RegExp(`\\b${n}\\b`).test(body));
  return found.length ? [`script mentions ${found.join(', ')}; jobs may not submit or cancel scheduler jobs`] : [];
}

export function schemaText() {
  const rows = Object.entries(FIELDS).map(([k, f]) => `| \`${k}\` | ${f.required ? 'yes' : 'no'} | ${f.doc} |`);
  return ['| Field | Required | Meaning |', '|---|---|---|', ...rows].join('\n');
}
