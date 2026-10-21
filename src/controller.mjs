// The controller tick. All state is in files; a tick can be interrupted anywhere and the next one repairs it.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readJson, readText, writeJson, appendJsonl, sha256, listDir, isoNow} from './fsutil.mjs';
import {REQUEST_ID_RE, validateRequest, validateInRepo} from './request.mjs';
import {TERMINAL, ENGINE_FLAGS, realSlurm} from './slurm.mjs';
import {freeze, studyRecord, ARC_VERSION} from './freeze.mjs';
import {deadlineMs, loadCampaign, loadSite, resolveCampaignDir} from './campaign.mjs';
import {loadTurns, turnsFile, harvest, launch, isDue, composePrompt, workerFingerprint, claimHashes} from './turns.mjs';
import {claimStates} from './claims.mjs';
import {buildStatus} from './status.mjs';
import {realSystemd} from './systemd.mjs';

const MIN = 60000;
export const token = (c, id) => `arc:${c.config.id}:${id}`;
export const jobName = (c, id) => `${c.config.job_prefix}-${id}`;
export const isLive = r => r.status === 'submitting' || r.status === 'uncertain' || (r.status === 'submitted' && !TERMINAL.has(r.slurm_state));
const recordsDir = c => path.join(c.paths.state, 'requests');
const recordFile = (c, id) => path.join(recordsDir(c), `${id}.json`);
const errText = err => String(err?.stderr || err?.message || err).trim().slice(0, 1000);

export function loadRecords(c) {
  return listDir(recordsDir(c)).filter(f => f.endsWith('.json')).map(f => readJson(path.join(recordsDir(c), f)));
}

function controlFlags(c) {
  const has = name => fs.existsSync(path.join(c.paths.control, name));
  return {stop: has('STOP'), pauseSubmissions: has('PAUSE_SUBMISSIONS'), pauseWorker: has('PAUSE_WORKER'), pauseAdvisor: has('PAUSE_ADVISOR')};
}

function makeSave(ctx) {
  return rec => { rec.updated_at = isoNow(ctx.now); writeJson(recordFile(ctx.c, rec.id), rec); };
}

function ledgerLine(ctx, text) {
  const file = ctx.c.config.ledger_md;
  if (!file) return;
  try { execFileSync('flock', [`${file}.lock`, 'sh', '-c', 'cat >> "$1"', 'sh', file], {input: text + '\n', stdio: ['pipe', 'ignore', 'pipe'], timeout: 60000}); }
  catch (err) { ctx.log('ledger_error', {error: errText(err)}); }
}

// --- observe: follow submitted jobs to a terminal state ---
function observe(ctx, records) {
  const active = records.filter(r => r.status === 'submitted' && !TERMINAL.has(r.slurm_state) && r.job_id);
  if (!active.length) return;
  const byJob = new Map(active.map(r => [r.job_id, r]));
  for (const row of ctx.slurm.acct([...byJob.keys()])) {
    const rec = byJob.get(row.id);
    if (!rec || rec.slurm_state === row.state) continue;
    const from = rec.slurm_state;
    rec.slurm_state = row.state;
    if (TERMINAL.has(row.state)) {
      Object.assign(rec, {status: 'finished', exit_code: row.exit, elapsed_s: row.elapsed, finished_at: isoNow(ctx.now)});
      ctx.log('finished', {request: rec.id, job: rec.job_id, from, to: row.state, exit: row.exit});
      ledgerLine(ctx, `- ${isoNow(ctx.now)} ${ctx.c.config.id}/${rec.id}: job ${rec.job_id} ${row.state}, exit ${row.exit}; artifacts ${path.join(ctx.c.paths.artifacts, rec.id)}`);
    } else ctx.log('job_state', {request: rec.id, job: rec.job_id, from, to: row.state});
    ctx.save(rec);
  }
}

// --- scan: first sight of requests, immutability, withdrawals ---
function scan(ctx, records, byId, obs) {
  const {c} = ctx;
  for (const file of listDir(c.paths.requests)) {
    if (!file.endsWith('.json') || file.includes('.tmp')) continue;
    const id = file.slice(0, -5);
    if (!REQUEST_ID_RE.test(id)) { obs.badFiles.push(file); continue; }
    const text = readText(path.join(c.paths.requests, file), '');
    const existing = byId.get(id);
    if (existing) { if (existing.sha256 && sha256(text) !== existing.sha256) obs.mutated.push(id); continue; }
    let request = null, errors;
    try { request = JSON.parse(text); errors = validateRequest(request, {fileId: id}); }
    catch (err) {
      // A file still being written must not burn its id: retry while it is fresh.
      const age = ctx.now - fs.statSync(path.join(c.paths.requests, file)).mtimeMs;
      if (age < 60000) continue;
      errors = [`not valid JSON: ${err.message}`];
    }
    if (!errors.length) {
      try { errors = validateInRepo(request, c.config.repo, ctx.site.forbidden(request) ?? []); }
      catch (err) { ctx.log('scan_retry', {request: id, error: errText(err)}); continue; } // git timeout: try next tick
      if (!errors.length) { try { ctx.site.validate(request); } catch (err) { errors = [`cluster rules: ${err.message}`]; } }
    }
    const rec = {id, status: errors.length ? 'rejected' : 'queued', request, sha256: sha256(text), first_seen: isoNow(ctx.now), attempts: 0, reason: errors.join('; ') || null};
    ctx.save(rec); records.push(rec); byId.set(id, rec);
    ctx.log(errors.length ? 'rejected' : 'queued', {request: id, ...(errors.length ? {reason: rec.reason} : {})});
  }
  for (const id of listDir(c.paths.withdraw)) {
    const rec = byId.get(id);
    if (!rec) continue;
    if (rec.status === 'queued') {
      Object.assign(rec, {status: 'dropped', reason: `withdrawn: ${readText(path.join(c.paths.withdraw, id), '').trim() || 'no reason given'}`});
      ctx.save(rec); ctx.log('dropped', {request: id, reason: rec.reason});
    } else if (isLive(rec)) obs.withdrawAfterSubmit.push(id);
  }
}

// --- human reconcile commands (control/reconcile/<id>.json), consumed once ---
function applyReconcile(ctx, byId) {
  const dir = ctx.c.paths.reconcile;
  for (const file of listDir(dir).filter(f => f.endsWith('.json'))) {
    const id = file.slice(0, -5);
    const cmd = readJson(path.join(dir, file), {});
    const rec = byId.get(id);
    let outcome = 'ignored';
    if (rec && (rec.status === 'uncertain' || rec.status === 'submitting')) {
      if (cmd.action === 'adopt' && /^\d+$/.test(cmd.job ?? '')) {
        Object.assign(rec, {status: 'submitted', job_id: cmd.job, released: false, slurm_state: 'PENDING', submitted_at: isoNow(ctx.now), last_error: null});
        outcome = 'adopted';
      } else if (cmd.action === 'abandon') {
        Object.assign(rec, {status: 'dropped', reason: 'abandoned by human after uncertain submission'});
        outcome = 'abandoned';
      }
      if (outcome !== 'ignored') ctx.save(rec);
    }
    ctx.log('reconcile', {request: id, action: cmd.action ?? null, job: cmd.job ?? null, outcome});
    fs.renameSync(path.join(dir, file), path.join(dir, `${file}.${outcome}`));
  }
}

function adopt(ctx, rec, {id, state, released}) {
  Object.assign(rec, {status: 'submitted', job_id: id, released, slurm_state: state ?? 'PENDING', submitted_at: rec.submitted_at ?? isoNow(ctx.now), last_error: null});
  ctx.save(rec);
  ctx.log('adopted', {request: rec.id, job: id});
}

// --- reconcile: adopt exact matches for uncertain intents, count orphans ---
function reconcile(ctx, records, obs) {
  const {c} = ctx;
  const prefix = `arc:${c.config.id}:`;
  const ours = ctx.slurm.queue().filter(r => r.comment.startsWith(prefix));
  for (const rec of records.filter(r => r.status === 'submitting' || r.status === 'uncertain')) {
    const matches = ours.filter(r => r.comment === token(c, rec.id));
    if (matches.length === 1) { adopt(ctx, rec, {id: matches[0].id, state: matches[0].state, released: !matches[0].held}); continue; }
    let past = [];
    if (!matches.length) {
      const since = isoNow(Date.parse(rec.intent_at ?? rec.first_seen) - 10 * MIN);
      try { past = ctx.slurm.acctByName(jobName(c, rec.id), since); } catch (err) { ctx.log('reconcile_retry', {request: rec.id, error: errText(err)}); continue; }
      if (past.length === 1) { adopt(ctx, rec, {id: past[0].id, state: past[0].state, released: true}); continue; }
    }
    // A crash left the intent unresolved: stay reserved and re-check every tick, never resubmit.
    if (rec.status === 'submitting') {
      const n = matches.length || past.length;
      Object.assign(rec, {status: 'uncertain', last_error: `controller stopped mid-submit; ${n} matching jobs found`});
      ctx.save(rec); ctx.log('uncertain', {request: rec.id, matches: n});
    }
  }
  const known = new Set(records.map(r => r.job_id).filter(Boolean));
  for (const row of ours) if (!known.has(row.id)) obs.orphans.push({id: row.id, name: row.name, gpus: row.gpus});
}

// --- release: write the study record and ledger line, then let the job run ---
function releaseRecord(ctx, rec) {
  const {c} = ctx;
  const out = path.join(c.paths.artifacts, rec.id);
  const studyFile = path.join(out, 'study.json');
  if (!fs.existsSync(studyFile)) {
    const study = studyRecord({campaign: c, record: rec, provenance: readJson(path.join(out, 'provenance.json')), out});
    writeJson(studyFile, study);
    if (c.config.study_spool) writeJson(path.join(c.config.study_spool, `${study.id}.json`), study);
  }
  if (!rec.ledger_submitted) {
    const r = rec.request;
    ledgerLine(ctx, `- ${isoNow(ctx.now)} ${c.config.id}/${rec.id}: job ${rec.job_id} submitted (${r.gpus} GPUs, ${r.kind}, seed ${r.seed}, evaluator ${rec.evaluator_status ?? 'not pinned'}). ${r.hypothesis} Source ${r.source_commit}; artifacts ${out}`);
    rec.ledger_submitted = true;
  }
  try {
    ctx.slurm.release(rec.job_id);
    rec.released = true;
    ctx.log('released', {request: rec.id, job: rec.job_id});
  } catch (err) {
    const msg = errText(err);
    if (/not held|already|invalid job id|not pending|has finished|completed/i.test(msg)) rec.released = true;
    else { rec.last_error = `release: ${msg}`; ctx.log('release_retry', {request: rec.id, job: rec.job_id, error: msg}); }
  }
  ctx.save(rec);
}

function retryLater(ctx, rec, message) {
  rec.attempts = (rec.attempts ?? 0) + 1;
  rec.retry_at = isoNow(ctx.now + Math.min(60, 2 ** rec.attempts) * MIN);
  rec.last_error = message;
  ctx.save(rec);
  ctx.log('retry', {request: rec.id, attempts: rec.attempts, error: message});
}

// --- submit one admitted request: freeze, persist intent, held sbatch, receipt, release ---
function submit(ctx, rec, route) {
  const {c} = ctx;
  let frozen;
  try { frozen = freeze({campaign: c, record: rec, route, forbidden: ctx.site.forbidden(rec.request) ?? []}); }
  catch (err) { retryLater(ctx, rec, `freeze: ${errText(err)}`); return 'retry'; }
  const {out, provenance} = frozen;
  Object.assign(rec, {status: 'submitting', intent_at: isoNow(ctx.now), route, evaluator_status: provenance.evaluator?.status ?? null});
  ctx.save(rec);
  ctx.log('submitting', {request: rec.id});
  const args = ['--parsable', '--hold', '--no-requeue', `--job-name=${jobName(c, rec.id)}`, `--comment=${token(c, rec.id)}`,
    `--chdir=${out}`, `--output=${path.join(out, 'slurm-%j.log')}`, ...route.args];
  const res = ctx.slurm.submit(args, path.join(out, 'run.sh'));
  if (res.ok) {
    Object.assign(rec, {status: 'submitted', job_id: res.id, released: false, slurm_state: 'PENDING', submitted_at: isoNow(ctx.now), last_error: null});
    ctx.save(rec);
    ctx.log('submitted', {request: rec.id, job: res.id, gpus: rec.request.gpus});
    releaseRecord(ctx, rec);
    return 'submitted';
  }
  if (res.kind === 'definite') { rec.status = 'queued'; retryLater(ctx, rec, `sbatch: ${res.error}`); return 'retry'; }
  Object.assign(rec, {status: 'uncertain', last_error: `sbatch outcome unknown: ${res.error}`});
  ctx.save(rec);
  ctx.log('uncertain', {request: rec.id, error: res.error});
  return 'uncertain';
}

function engineFlagIn(args) {
  return (args ?? []).find(a => ENGINE_FLAGS.some(f => a === f || a.startsWith(`${f}=`)));
}

// --- admit: priority, then first seen; lower priority never overtakes a blocked higher one ---
function admit(ctx, records, byId, obs, flags) {
  const {c, now} = ctx;
  const dl = deadlineMs(c.config);
  const closed = dl !== null && now >= dl;
  const override = readJson(c.paths.priority, {}) ?? {};
  obs.reserved = records.filter(isLive).reduce((n, r) => n + (r.request?.gpus ?? 0), 0) + obs.orphans.reduce((n, o) => n + o.gpus, 0);
  const prio = r => override[r.id] ?? r.request.priority ?? 0;
  const queued = records.filter(r => r.status === 'queued').sort((a, b) => prio(b) - prio(a) || a.first_seen.localeCompare(b.first_seen) || a.id.localeCompare(b.id));
  let blockedAt = -Infinity;
  for (const rec of queued) {
    const r = rec.request, p = prio(rec);
    let wait = null;
    if (flags.pauseSubmissions) wait = 'paused';
    else if (closed) wait = 'deadline';
    else if (rec.retry_at && now < Date.parse(rec.retry_at)) wait = `retry at ${rec.retry_at}`;
    if (!wait) {
      for (const dep of r.after ?? []) {
        const d = byId.get(dep);
        if (d && (d.status === 'rejected' || d.status === 'dropped' || (d.status === 'finished' && d.slurm_state !== 'COMPLETED'))) {
          Object.assign(rec, {status: 'dropped', reason: `dependency_failed: ${dep} ended ${d.slurm_state ?? d.status}`});
          ctx.save(rec); ctx.log('dropped', {request: rec.id, reason: rec.reason});
          wait = 'dropped';
          break;
        }
        if (!d || d.status !== 'finished') { wait = `dependency ${dep}`; break; }
      }
    }
    if (wait === 'dropped') continue;
    if (!wait && p < blockedAt) wait = 'priority';
    if (!wait && obs.reserved + r.gpus > c.config.gpu_cap) { wait = 'budget'; blockedAt = Math.max(blockedAt, p); }
    let route = null;
    if (!wait) {
      try { route = ctx.site.route(r, {campaign: c.config, exec: ctx.slurm.exec}); }
      catch (err) { retryLater(ctx, rec, `route: ${errText(err)}`); wait = 'retry'; }
      if (route?.wait) { wait = `route: ${route.wait}`; blockedAt = Math.max(blockedAt, p); }
      else if (route && engineFlagIn(route.args)) { retryLater(ctx, rec, `route: site returned engine-owned flag ${engineFlagIn(route.args)}`); wait = 'retry'; }
    }
    if (!wait) {
      const result = submit(ctx, rec, route);
      if (result === 'submitted' || result === 'uncertain') { obs.reserved += r.gpus; continue; }
      wait = 'retry';
    }
    obs.queue.push({id: rec.id, priority: p, waiting_for: wait, ...(rec.last_error ? {last_error: rec.last_error} : {})});
  }
}

function phaseOf(c, flags, now) {
  const dl = deadlineMs(c.config);
  if (flags.stop) return 'stopped';
  if (dl !== null && now >= dl) return 'deadline_closed';
  if (flags.pauseSubmissions || flags.pauseWorker || flags.pauseAdvisor) return 'paused';
  return 'running';
}

export function tick(ctx) {
  const {c, now} = ctx;
  ctx.save = makeSave(ctx);
  const flags = controlFlags(c);
  const obs = {orphans: [], mutated: [], badFiles: [], withdrawAfterSubmit: [], queue: [], reserved: 0, tickError: ctx.lastError ?? null};
  const records = loadRecords(c);
  const byId = new Map(records.map(r => [r.id, r]));
  const turns = loadTurns(c);
  const writeStatus = (phase, claims) => writeJson(c.paths.status, buildStatus({c, records, obs, turns, claims, now, phase, controller: ctx.controller}));

  if (flags.stop) {
    obs.reserved = records.filter(isLive).reduce((n, r) => n + (r.request?.gpus ?? 0), 0);
    writeStatus('stopped', claimStates(c));
    return {stop: true};
  }
  observe(ctx, records);
  scan(ctx, records, byId, obs);
  applyReconcile(ctx, byId);
  reconcile(ctx, records, obs);
  for (const rec of records) if (rec.status === 'submitted' && !rec.released && !TERMINAL.has(rec.slurm_state)) releaseRecord(ctx, rec);
  admit(ctx, records, byId, obs, flags);

  // Turns: harvest finished ones, then launch any that are due.
  for (const role of ['worker', 'advisor']) harvest(c, role, {turns, now, systemd: ctx.systemd, log: ctx.log});
  const claims = claimStates(c);
  const dl = deadlineMs(c.config);
  const closed = dl !== null && now >= dl;
  const activeJobs = records.some(isLive);
  const fp = workerFingerprint(c, records);
  let phase = phaseOf(c, flags, now);
  const status = buildStatus({c, records, obs, turns, claims, now, phase, controller: ctx.controller});
  const cad = c.config.cadence;
  const w = isDue({rs: turns.worker, now, every: {changed: cad.changed_min, idle: cad.idle_min, busy: cad.busy_min},
    changed: fp !== turns.worker.last_fingerprint, activeJobs, closed, paused: flags.pauseWorker});
  turns.worker.next_due_at = w.next_due_at;
  if (w.due) launch(c, 'worker', {turns, now, site: ctx.site, systemd: ctx.systemd, fingerprint: fp, log: ctx.log,
    prompt: composePrompt(c, 'worker', {site: ctx.site, status, records, claims, rs: turns.worker})});
  if (c.config.advisor) {
    const unaudited = claims.some(cl => !cl.superseded && !cl.audit && !cl.duplicate);
    const a = isDue({rs: turns.advisor, now, every: {changed: c.config.advisor.every_min ?? 60}, changed: unaudited, activeJobs, closed: true, paused: flags.pauseAdvisor});
    turns.advisor.next_due_at = a.next_due_at;
    if (a.due) launch(c, 'advisor', {turns, now, site: ctx.site, systemd: ctx.systemd, fingerprint: null, log: ctx.log,
      claimHashes: claimHashes(readText(c.paths.findings, '')),
      prompt: composePrompt(c, 'advisor', {site: ctx.site, status, records, claims, rs: turns.advisor})});
  }
  writeJson(turnsFile(c), turns);

  const finished = closed && !activeJobs && !turns.worker.active && !turns.advisor.active && fp === turns.worker.last_fingerprint;
  if (finished) phase = 'finished';
  writeStatus(phase, claims);
  if (finished) ctx.log('finished_campaign', {});
  return {finished};
}

export function newContext({c, site, slurm, systemd, log}) {
  return {c, site, slurm, systemd, log, now: Date.now(), lastError: null,
    controller: {pid: process.pid, version: ARC_VERSION, started_at: isoNow()}};
}

const sleep = (ms, signal) => new Promise(resolve => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, {once: true});
});

// systemd entry point: `arc run <id>`.
export async function runController(ref, {tickMs = 30000} = {}) {
  const c = loadCampaign(resolveCampaignDir(ref));
  const site = await loadSite();
  const log = (type, data = {}) => appendJsonl(c.paths.events, {at: isoNow(), type, ...data});
  const ctx = newContext({c, site, slurm: realSlurm(), systemd: realSystemd(), log});
  const ac = new AbortController();
  let stopping = false;
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true; ac.abort(); });
  log('controller_started', {pid: process.pid, version: ARC_VERSION});
  while (!stopping) {
    ctx.now = Date.now();
    let result = {};
    try { result = tick(ctx); ctx.lastError = null; }
    catch (err) {
      ctx.lastError = errText(err);
      log('tick_error', {error: String(err.stack ?? err).slice(0, 4000)});
      const s = readJson(c.paths.status);
      if (s) { s.controller.heartbeat_at = isoNow(); s.alerts = [...s.alerts.filter(a => a.code !== 'controller_error'), {code: 'controller_error', message: `last tick failed: ${ctx.lastError}`, ids: []}]; writeJson(c.paths.status, s); }
    }
    if (result.stop || result.finished) break;
    await sleep(tickMs, ac.signal);
  }
  log('controller_exit', {reason: stopping ? 'signal' : 'stop_or_finished'});
}
