// Agent turns: cadence, prompt composition, launch as separate units, harvest, and the turn runner itself.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readJson, readText, writeJson, writeAtomic, sha256, isoNow} from './fsutil.mjs';
import {agentCommand, parseTranscript} from './agents.mjs';
import {parseVerdicts, parseClaims} from './claims.mjs';
import {schemaText} from './request.mjs';
import {loadCampaign} from './campaign.mjs';
import {git} from './git.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ARC_BIN = path.join(HERE, '..', 'bin', 'arc');
export const ROLES = ['worker', 'advisor'];
const MIN = 60000;
const FINDINGS_SOFT_LINES = 150;

const emptyRole = () => ({n: 0, active: null, last_started_at: 0, last_finished_at: 0, last_ok_at: 0, consecutive_failures: 0,
  last_error: null, last_fingerprint: null, totals: {turns: 0, failures: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, cost_usd: 0}, audits: {total: 0, flagged: 0}});

export const turnsFile = c => path.join(c.paths.state, 'turns.json');
export function loadTurns(c) {
  const t = readJson(turnsFile(c), {});
  for (const r of ROLES) t[r] = {...emptyRole(), ...t[r]};
  return t;
}
export const turnName = (role, n) => `${role}-${String(n).padStart(4, '0')}`;
// '.' cannot appear in a campaign id, so arc-<id>.* never matches another campaign's units.
export const unitName = (c, role, n) => `arc-${c.config.id}.${turnName(role, n)}`;
export const unitGlob = id => `arc-${id}.*`;
const fileHash = p => sha256(readText(p, ''));

// What counts as news for the worker: a request accepted (submitted), rejected, dropped, or a job finishing.
// Progress in between (queued, held, released, PENDING -> RUNNING) is not news, so a long job costs few turns.
const NEWS = {submitting: 'accepted', uncertain: 'accepted', submitted: 'accepted', rejected: 'rejected', dropped: 'dropped'};
const newsOf = r => (r.status === 'finished' ? `finished:${r.slurm_state}` : NEWS[r.status] ?? null);

export function workerFingerprint(c, records) {
  const rows = records.map(r => [r.id, newsOf(r)]).filter(([, n]) => n).sort((a, b) => a[0].localeCompare(b[0]));
  return sha256(JSON.stringify([rows, fileHash(c.paths.brief), fileHash(c.paths.steering),
    fileHash(path.join(c.paths.turns, 'advisor-latest.md')), fileHash(c.paths.reviews)]));
}

const backoffMs = failures => Math.min(60, 2 ** failures) * MIN;

// Returns {due, next_due_at}. No caps, no timeouts: only cadence and failure backoff.
export function isDue({rs, now, every, changed, activeJobs, closed, paused}) {
  if (paused || rs.active) return {due: false, next_due_at: null};
  if (rs.consecutive_failures) {
    const at = rs.last_finished_at + backoffMs(rs.consecutive_failures);
    return now >= at ? {due: true, next_due_at: at} : {due: false, next_due_at: at};
  }
  const since = now - rs.last_started_at;
  const candidates = [];
  if (changed) candidates.push(rs.last_started_at + every.changed * MIN);
  if (!closed) candidates.push(rs.last_started_at + (activeJobs ? every.busy : every.idle) * MIN);
  if (!candidates.length) return {due: false, next_due_at: null};
  const at = Math.min(...candidates);
  return {due: now >= at && since >= 0, next_due_at: at};
}

function recentRejections(records, sinceMs) {
  return records.filter(r => r.status === 'rejected' && Date.parse(r.updated_at) > sinceMs).map(r => `- \`${r.id}\`: ${r.reason}`);
}

// For each request id cited by a claim: the controller's record and the code change behind it.
function evidenceLines(c, claims, records) {
  const ids = new Set(records.map(r => r.id));
  const cited = [...new Set(claims.flatMap(cl => cl.text.match(/[a-z][a-z0-9-]*/g) ?? []).filter(w => ids.has(w)))].slice(0, 30);
  return cited.map(id => {
    const r = records.find(x => x.id === id);
    let stat = '';
    try { stat = git(c.config.repo, ['diff', '--shortstat', c.config.base_commit, r.request.source_commit], {timeout: 30000}).trim(); } catch { stat = 'diff unavailable'; }
    return `- \`${id}\`: ${r.status}${r.slurm_state ? ` ${r.slurm_state}` : ''}${r.exit_code ? ` exit ${r.exit_code}` : ''}, job ${r.job_id ?? '-'}, commit ${r.request?.source_commit ?? '-'} (vs base: ${stat || 'no change'}), evaluator ${r.evaluator_status ?? 'not pinned'}, artifacts ${path.join(c.paths.artifacts, id)}`;
  });
}

export function digest(c, role, {status, records, claims, rs}) {
  const out = [];
  const s = status;
  out.push(`## Live status (${s.generated_at})`,
    `Phase: ${s.controller.phase}. GPUs reserved ${s.budget.reserved}/${s.budget.cap} (free ${s.budget.free}). Deadline: ${s.deadline.at ?? 'none'}${s.deadline.closed ? ' (CLOSED: no new submissions)' : ''}.`);
  if (s.alerts.length) out.push('Alerts:', ...s.alerts.map(a => `- ${a.code}: ${a.message}`));
  if (s.queue.length) out.push('Queue (in admission order):', ...s.queue.slice(0, 40).map(q => `- \`${q.id}\` priority ${q.priority}: waiting for ${q.waiting_for}${q.last_error ? ` (last error: ${q.last_error.slice(0, 300)})` : ''}`));
  if (s.jobs.active.length) out.push('Active jobs:', ...s.jobs.active.map(j => `- \`${j.request}\` job ${j.job_id ?? '?'} ${j.state} (${j.gpus} GPUs)`));
  if (s.jobs.recent.length) out.push('Recently finished:', ...s.jobs.recent.map(j => `- \`${j.request}\` job ${j.job_id} ${j.state} exit ${j.exit ?? '?'} → ${j.artifacts}`));
  const rej = recentRejections(records, rs.last_started_at);
  if (rej.length) out.push('Requests rejected since your last turn (file a new id after fixing):', ...rej);
  const blocked = readText(c.paths.blocked, '').trim();
  if (blocked) out.push('## blocked.md', blocked);
  const findings = readText(c.paths.findings, '');
  const lines = findings ? findings.split('\n').length : 0;
  if (role === 'worker') {
    if (claims.length) out.push('## Claim review state', ...claims.map(cl => `- ${cl.id} [${cl.state}]` +
      (cl.audit ? ` audit: ${cl.audit.verdict}${cl.audit.detail ? ` (${cl.audit.detail})` : ''}` : '') +
      (cl.review ? ` human: ${cl.review.verdict}${cl.review.note ? ` (${cl.review.note})` : ''}` : '')));
    out.push(`## findings.md (${lines} lines${lines > FINDINGS_SOFT_LINES ? `; over ${FINDINGS_SOFT_LINES}: consolidate it this turn` : ''})`, findings || '(empty)');
    const adv = readText(path.join(c.paths.turns, 'advisor-latest.md'), '').trim();
    if (adv) out.push('## Latest advisor audit (nonbinding)', adv.slice(0, 12000));
  } else {
    const toAudit = claims.filter(cl => !cl.superseded && !cl.audit);
    out.push(`## Claims to audit (${toAudit.length})`, toAudit.length ? toAudit.map(cl => cl.text).join('\n\n') : 'None changed since your last audit.');
    const evidence = evidenceLines(c, toAudit, records);
    if (evidence.length) out.push('## Evidence for the cited requests (controller records)', ...evidence);
    out.push('## Full findings.md for context', findings || '(empty)');
  }
  out.push(`## Your health`, `Consecutive failures: ${rs.consecutive_failures}${rs.last_error ? `; last error: ${rs.last_error}` : ''}.`);
  return out.join('\n');
}

export function composePrompt(c, role, {site, status, records, claims, rs}) {
  const {config, paths} = c;
  const protocol = readText(path.join(HERE, '..', 'prompts', `${role}.md`), '');
  const facts = [
    '## Campaign facts',
    `- Campaign: ${config.id}; directory ${paths.dir}`,
    `- Worktree (branch arc/${config.id}): ${paths.worktree}`,
    `- Requests directory: ${paths.requests}; withdrawals: ${paths.withdraw}`,
    `- GPU budget: ${config.gpu_cap} simultaneous GPUs (queued, held and running jobs all count)`,
    `- Deadline: ${config.deadline}`,
    `- Evaluator: ${config.evaluator ? `pinned at ${config.evaluator.commit}, paths ${config.evaluator.paths.join(', ')}` : 'not pinned'}`,
    `- Previous turn reports: ${paths.turns}/${role}-NNNN.md`,
    ...(role === 'worker' ? [`- Check a request before writing it: ${process.execPath} ${ARC_BIN} check-request <file> --campaign ${paths.dir}`] : []),
  ];
  return [
    protocol.trim(),
    role === 'worker' ? `## Request schema\n\n${schemaText()}` : '',
    site.prompt ? `## Cluster rules\n\n${site.prompt.trim()}` : '',
    facts.join('\n'),
    `## Brief\n\n${readText(paths.brief, '(missing brief.md)').trim()}`,
    `## Steering (chronological; later entries supersede earlier ones)\n\n${readText(paths.steering, '').trim() || '(none)'}`,
    digest(c, role, {status, records, claims, rs}),
  ].filter(Boolean).join('\n\n') + '\n';
}

// Launch one turn as its own systemd unit so controller restarts never touch it.
export function launch(c, role, {turns, now, site, systemd, prompt, fingerprint, claimHashes, log, persist}) {
  const rs = turns[role];
  const n = rs.n + 1;
  const name = turnName(role, n);
  writeAtomic(path.join(c.paths.turns, `${name}.prompt.md`), prompt);
  const unit = unitName(c, role, n);
  const env = {PATH: site.path ?? process.env.PATH, HOME: process.env.HOME, USER: process.env.USER,
    ...(process.env.ARC_CONFIG_DIR ? {ARC_CONFIG_DIR: process.env.ARC_CONFIG_DIR} : {}),
    ...(process.env.ARC_SITE ? {ARC_SITE: process.env.ARC_SITE} : {}),
    ARC_CAMPAIGN_DIR: c.dir, ARC_ROLE: role};
  // Record the turn before starting it: after a crash in between, harvest finds the unit or counts a failure,
  // and never starts a second turn alongside a running one.
  rs.n = n;
  rs.last_started_at = now;
  rs.active = {n, unit, started_at: now, fingerprint, claim_hashes: claimHashes};
  persist();
  try {
    systemd.start(unit, [process.execPath, ARC_BIN, 'turn', c.dir, role, String(n)], {cwd: c.paths.worktree, env});
    log('turn_started', {role, turn: name, unit});
  } catch (err) {
    rs.active = null;
    rs.consecutive_failures += 1; rs.last_finished_at = now; rs.totals.failures += 1;
    rs.last_error = `could not start turn unit: ${String(err.stderr || err.message).trim().slice(0, 500)}`;
    log('turn_failed', {role, turn: name, error: rs.last_error});
  }
}

export function harvest(c, role, {turns, now, systemd, log}) {
  const rs = turns[role];
  const a = rs.active;
  if (!a) return;
  const name = turnName(role, a.n);
  const exit = readJson(path.join(c.paths.turns, `${name}.exit.json`));
  if (!exit) {
    if (now - a.started_at < 30000 || systemd.isActive(a.unit)) return;
    Object.assign(rs, {active: null, last_finished_at: now, consecutive_failures: rs.consecutive_failures + 1, last_error: 'turn ended without an exit record'});
    rs.totals.failures += 1;
    log('turn_failed', {role, turn: name, error: rs.last_error});
    return;
  }
  rs.active = null;
  rs.last_finished_at = now;
  rs.totals.turns += 1;
  for (const k of ['input_tokens', 'cached_input_tokens', 'output_tokens']) rs.totals[k] += exit.usage?.[k] ?? 0;
  rs.totals.cost_usd += exit.usage?.cost_usd ?? 0;
  if (exit.ok) {
    rs.consecutive_failures = 0; rs.last_error = null; rs.last_ok_at = now; rs.last_fingerprint = a.fingerprint;
    const report = readText(path.join(c.paths.turns, `${name}.md`), '');
    writeAtomic(path.join(c.paths.turns, `${role}-latest.md`), report);
    if (role === 'advisor') { recordAudit(c, rs, a, report, now); rs.audited_hashes = Object.values(a.claim_hashes ?? {}); }
  } else {
    rs.consecutive_failures += 1; rs.totals.failures += 1; rs.last_error = exit.error;
  }
  log('turn_finished', {role, turn: name, ok: exit.ok, error: exit.error ?? null});
}

function recordAudit(c, rs, active, report, now) {
  const file = path.join(c.paths.state, 'claims.json');
  const state = readJson(file, {audits: {}});
  const verdicts = parseVerdicts(report);
  for (const [id, v] of Object.entries(verdicts)) {
    if (!active.claim_hashes?.[id]) continue; // only claims that existed when the audit started
    state.audits[id] = {...v, hash: active.claim_hashes[id], turn: turnName('advisor', active.n), at: isoNow(now)};
  }
  rs.audits.total += 1;
  if (/material issues:\s*(?!none\b)\S/i.test(report) || Object.values(verdicts).some(v => v.verdict !== 'supported')) rs.audits.flagged += 1;
  writeJson(file, state);
}

export const claimHashes = text => Object.fromEntries(parseClaims(text).map(cl => [cl.id, cl.hash]));

// --- The turn runner, executed inside the transient unit: `arc turn <campaign> <role> <n>` ---
export async function runTurn(campaignDir, role, n) {
  const c = loadCampaign(campaignDir);
  const rc = c.config[role];
  if (!rc) throw Error(`role ${role} is not configured`);
  const name = turnName(role, Number(n));
  const base = path.join(c.paths.turns, name);
  const reportFile = `${base}.md`;
  const prompt = fs.readFileSync(`${base}.prompt.md`, 'utf8');
  const {bin, args} = agentCommand(role, rc, {worktree: c.paths.worktree, campaignDir: c.dir, reportFile, gitDir: path.join(c.config.repo, '.git')});
  const started_at = isoNow();
  const out = fs.openSync(`${base}.jsonl`, 'a', 0o600);
  const err = fs.openSync(`${base}.stderr`, 'a', 0o600);
  const code = await new Promise(resolve => {
    const child = spawn(bin, args, {cwd: c.paths.worktree, env: {...process.env, ...(rc.env ?? {})}, stdio: ['pipe', out, err]});
    child.on('error', e => { fs.appendFileSync(`${base}.stderr`, `spawn error: ${e.message}\n`); resolve(-1); });
    child.on('exit', code => resolve(code ?? -1));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
  fs.closeSync(out); fs.closeSync(err);
  const result = parseTranscript(rc, {raw: readText(`${base}.jsonl`, ''), stderr: readText(`${base}.stderr`, ''), code, reportFile});
  if (rc.agent !== 'codex' && result.report) writeAtomic(reportFile, result.report);
  writeJson(`${base}.exit.json`, {ok: result.ok, code, model: result.model, usage: result.usage, error: result.error, started_at, finished_at: isoNow()});
  return result.ok ? 0 : 1;
}
