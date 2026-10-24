// The controller tick. All state is in files; a tick can be interrupted anywhere and the next one repairs it.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readJson, readText, writeJson, appendJsonl, sha256, listDir, isoNow} from './fsutil.mjs';
import {REQUEST_ID_RE, validateRequest, validateInRepo} from './request.mjs';
import {TERMINAL, ENGINE_FLAGS, realSlurm} from './slurm.mjs';
import {freeze, studyRecord, ARC_VERSION} from './freeze.mjs';
import {deadlineMs, loadCampaign, loadSite, resolveCampaignDir, configDir} from './campaign.mjs';
import {loadTurns, turnsFile, harvest, launch, isDue, composePrompt, composeCheckinPrompt, workerFingerprint, claimHashes, runsToCheck} from './turns.mjs';
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
  return {stop: has('STOP'), pauseSubmissions: has('PAUSE_SUBMISSIONS'), pauseWorker: has('PAUSE_WORKER'), pauseAuditor: has('PAUSE_AUDITOR') || has('PAUSE_ADVISOR')};
}

function makeSave(ctx) {
  return rec => { rec.updated_at = isoNow(ctx.now); writeJson(recordFile(ctx.c, rec.id), rec); };
}

// ledger_md is a human-readable view (point it at a file only arc writes); events.jsonl is the full ledger.
function ledgerLine(ctx, text) {
  const file = ctx.c.config.ledger_md;
  if (!file) return true;
  try {
    execFileSync('flock', [`${file}.lock`, 'sh', '-c', 'cat >> "$1"', 'sh', file], {input: text + '\n', stdio: ['pipe', 'ignore', 'pipe'], timeout: 60000});
    return true;
  } catch (err) { ctx.log('ledger_error', {error: errText(err)}); return false; }
}

function finish(ctx, rec, {state, exit = null, elapsed = null}) {
  const from = rec.slurm_state;
  Object.assign(rec, {status: 'finished', slurm_state: state, exit_code: exit, elapsed_s: elapsed, finished_at: isoNow(ctx.now)});
  ctx.log('finished', {request: rec.id, job: rec.job_id, from, to: state, exit});
  rec.ledger_finished = ledgerLine(ctx, `- ${isoNow(ctx.now)} ${ctx.c.config.id}/${rec.id}: job ${rec.job_id} ${state}, exit ${exit ?? '?'}; artifacts ${path.join(ctx.c.paths.artifacts, rec.id)}`);
  ctx.save(rec);
}

// --- observe: follow submitted jobs to a terminal state ---
function observe(ctx, records) {
  const active = records.filter(r => r.status === 'submitted' && !TERMINAL.has(r.slurm_state) && r.job_id);
  if (!active.length) return;
  const byJob = new Map(active.map(r => [r.job_id, r]));
  for (const row of ctx.slurm.acct([...byJob.keys()])) {
    const rec = byJob.get(row.id);
    if (!rec || rec.slurm_state === row.state) continue;
    if (TERMINAL.has(row.state)) { finish(ctx, rec, {state: row.state, exit: row.exit, elapsed: row.elapsed}); continue; }
    ctx.log('job_state', {request: rec.id, job: rec.job_id, from: rec.slurm_state, to: row.state});
    rec.slurm_state = row.state;
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
    const existing = byId.get(id);
    const full = path.join(c.paths.requests, file);
    if (existing) {
      const mtime = fs.statSync(full).mtimeMs;
      if (existing.mtime_ms === mtime && !existing.mutated) continue;
      const mutated = !!existing.sha256 && sha256(readText(full, '')) !== existing.sha256;
      if (mutated) obs.mutated.push(id);
      if (existing.mtime_ms !== mtime || existing.mutated !== mutated) { Object.assign(existing, {mtime_ms: mtime, mutated}); ctx.save(existing); }
      continue;
    }
    const text = readText(full, '');
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
      if (!errors.length && request.gpus > c.config.gpu_cap) errors = [`${request.gpus} GPUs can never fit the campaign budget of ${c.config.gpu_cap}`];
    }
    const rec = {id, status: errors.length ? 'rejected' : 'queued', request, sha256: sha256(text), mtime_ms: fs.statSync(full).mtimeMs, first_seen: isoNow(ctx.now), attempts: 0, reason: errors.join('; ') || null};
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

// Every adoption goes through the same path as a normal receipt: study, ledger, and finish if already terminal.
function adopt(ctx, rec, {id, state, released}) {
  Object.assign(rec, {status: 'submitted', job_id: id, released, slurm_state: state ?? 'PENDING', submitted_at: rec.submitted_at ?? isoNow(ctx.now), last_error: null});
  ctx.save(rec);
  ctx.log('adopted', {request: rec.id, job: id, state: rec.slurm_state});
  recordStudy(ctx, rec);
  if (TERMINAL.has(rec.slurm_state)) finish(ctx, rec, {state: rec.slurm_state});
}

// --- reconcile: adopt exact matches for unresolved intents, re-check holds, count orphans ---
function reconcile(ctx, records, obs) {
  const {c} = ctx;
  const prefix = `arc:${c.config.id}:`;
  const ours = ctx.slurm.queue().filter(r => r.comment.startsWith(prefix));
  const byToken = new Map();
  for (const row of ours) byToken.set(row.comment, [...(byToken.get(row.comment) ?? []), row]);
  for (const rec of records.filter(r => r.status === 'submitting' || r.status === 'uncertain' || r.status === 'queued')) {
    const matches = byToken.get(token(c, rec.id)) ?? [];
    // A queued request already in the queue means an sbatch error was misclassified: adopt, never duplicate.
    if (rec.status === 'queued') { if (matches.length === 1) adopt(ctx, rec, {id: matches[0].id, state: matches[0].state, released: !matches[0].held}); continue; }
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
  const byJob = new Map(records.filter(r => r.job_id).map(r => [r.job_id, r]));
  for (const row of ours) {
    const rec = byJob.get(row.id);
    if (!rec) { obs.orphans.push({id: row.id, name: row.name, gpus: row.gpus}); continue; }
    if (row.held && rec.released && rec.status === 'submitted') { rec.released = false; ctx.save(rec); ctx.log('still_held', {request: rec.id, job: rec.job_id}); }
  }
}

// --- study record: provenance an observer can ingest, written before the job may run ---
function recordStudy(ctx, rec) {
  const {c} = ctx;
  const out = path.join(c.paths.artifacts, rec.id);
  const studyFile = path.join(out, 'study.json');
  let study = readJson(studyFile);
  if (!study) { study = studyRecord({campaign: c, record: rec, provenance: readJson(path.join(out, 'provenance.json')), out}); writeJson(studyFile, study); }
  if (c.config.study_spool) {
    const spooled = path.join(c.config.study_spool, `${study.id}.json`);
    if (!fs.existsSync(spooled)) writeJson(spooled, study);
  }
  if (!rec.ledger_submitted) {
    const r = rec.request;
    rec.ledger_submitted = ledgerLine(ctx, `- ${isoNow(ctx.now)} ${c.config.id}/${rec.id}: job ${rec.job_id} submitted (${r.gpus} GPUs, ${r.kind}, seed ${r.seed}, evaluator ${rec.evaluator_status ?? 'not pinned'}). ${r.hypothesis} Source ${r.source_commit}; artifacts ${out}`);
  }
  rec.study_recorded = true;
  ctx.save(rec);
}

// --- release: only after the study is recorded ---
function releaseRecord(ctx, rec) {
  if (!rec.study_recorded || !rec.ledger_submitted) recordStudy(ctx, rec);
  if (rec.released) return;
  try {
    ctx.slurm.release(rec.job_id);
    rec.released = true;
    ctx.log('released', {request: rec.id, job: rec.job_id});
  } catch (err) {
    const msg = errText(err);
    if (/not held|invalid job id|already complet|already finished|has finished/i.test(msg)) rec.released = true;
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
  try { frozen = freeze({campaign: c, record: rec, route, forbidden: ctx.site.forbidden(rec.request) ?? [], siteFile: ctx.site.file}); }
  catch (err) { retryLater(ctx, rec, `freeze: ${errText(err)}`); return 'retry'; }
  const {out, provenance} = frozen;
  Object.assign(rec, {status: 'submitting', intent_at: isoNow(ctx.now), route, evaluator_status: provenance.evaluator?.status ?? null});
  ctx.save(rec);
  ctx.log('submitting', {request: rec.id});
  const args = ['--parsable', '--hold', '--no-requeue', `--job-name=${jobName(c, rec.id)}`, `--comment=${token(c, rec.id)}`,
    `--chdir=${out}`, `--output=${path.join(out, 'slurm-%j.log')}`, ...route.args];
  rec.sbatch_args = args;
  ctx.save(rec);
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
    if (!wait && fs.existsSync(path.join(c.paths.control, 'STOP'))) break; // stopping: no new submissions
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
  if (flags.pauseSubmissions || flags.pauseWorker || flags.pauseAuditor) return 'paused';
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
  // Each phase fails on its own, so a scheduler hiccup never stops turns or status.
  const errors = [];
  const step = (name, fn) => { try { fn(); return true; } catch (err) { errors.push(`${name}: ${errText(err)}`); ctx.log('phase_error', {phase: name, error: String(err.stack ?? err).slice(0, 4000)}); return false; } };
  step('observe', () => observe(ctx, records));
  step('scan', () => scan(ctx, records, byId, obs));
  step('reconcile-commands', () => applyReconcile(ctx, byId));
  const reconciled = step('reconcile', () => reconcile(ctx, records, obs));
  step('release', () => { for (const rec of records) if (rec.status === 'submitted' && !TERMINAL.has(rec.slurm_state) && (!rec.released || !rec.study_recorded || !rec.ledger_submitted)) releaseRecord(ctx, rec); });
  // Without a fresh view of the queue, orphans and adoptions are unknown: admitting would be unsafe.
  if (reconciled) step('admit', () => admit(ctx, records, byId, obs, flags));
  else obs.reserved = records.filter(isLive).reduce((n, r) => n + (r.request?.gpus ?? 0), 0);
  if (errors.length) obs.tickError = errors.join('; ');

  // Turns: harvest finished ones, then launch any that are due.
  for (const role of ['worker', 'auditor']) harvest(c, role, {turns, now, systemd: ctx.systemd, log: ctx.log});
  const claims = claimStates(c);
  const dl = deadlineMs(c.config);
  const closed = dl !== null && now >= dl;
  const activeJobs = records.some(isLive);
  const fp = workerFingerprint(c, records);
  let phase = phaseOf(c, flags, now);
  const status = buildStatus({c, records, obs, turns, claims, now, phase, controller: ctx.controller});
  const cad = c.config.cadence;
  const w = isDue({rs: turns.worker, now, every: {changed: cad.changed_min, idle: cad.idle_min, idleMax: cad.idle_max_min, busy: cad.busy_min},
    changed: fp !== turns.worker.last_fingerprint, activeJobs, closed, paused: flags.pauseWorker});
  turns.worker.next_due_at = w.next_due_at;
  const persist = () => writeJson(turnsFile(c), turns);
  const quiet = fp === turns.worker.last_fingerprint && !turns.worker.consecutive_failures;
  // Woken only by the busy timer (jobs running, nothing new, no failure to retry): a short check-in turn.
  const checkin = quiet && status.jobs.active.length > 0;
  if (w.due) {
    // Woken only by the idle timer (nothing running, nothing new): the next idle wake-up comes later.
    turns.worker.idle_streak = quiet && !activeJobs ? (turns.worker.idle_streak ?? 0) + 1 : 0;
    launch(c, 'worker', {turns, now, site: ctx.site, systemd: ctx.systemd, fingerprint: fp, log: ctx.log, persist, kind: checkin ? 'checkin' : 'full',
      prompt: checkin ? composeCheckinPrompt(c, {status}) : composePrompt(c, 'worker', {site: ctx.site, status, records, claims, rs: turns.worker})});
  }
  if (c.config.auditor) {
    // Claim texts and completed runs the auditor already answered (successfully) are not re-sent, even if no verdict parsed.
    const aud = turns.auditor;
    const answered = new Set(aud.audited_hashes ?? []);
    const unaudited = claims.some(cl => !cl.superseded && !cl.audit && !cl.duplicate && !answered.has(cl.hash));
    const runIds = runsToCheck(records, aud);
    const a = isDue({rs: aud, now, every: {changed: c.config.auditor.every_min ?? 60}, changed: unaudited || runIds.length > 0, activeJobs, closed: true, paused: flags.pauseAuditor});
    aud.next_due_at = a.next_due_at;
    if (a.due) launch(c, 'auditor', {turns, now, site: ctx.site, systemd: ctx.systemd, fingerprint: null, log: ctx.log, persist,
      claimHashes: claimHashes(readText(c.paths.findings, '')), runIds,
      prompt: composePrompt(c, 'auditor', {site: ctx.site, status, records, claims, rs: aud, runIds})});
  }
  writeJson(turnsFile(c), turns);

  const finished = closed && !activeJobs && !turns.worker.active && !turns.auditor.active && fp === turns.worker.last_fingerprint;
  if (finished) phase = 'finished';
  const final = buildStatus({c, records, obs, turns, claims, now, phase, controller: ctx.controller});
  writeJson(c.paths.status, final);
  notifyNewAlerts(ctx, final.alerts);
  if (finished) ctx.log('finished_campaign', {});
  return {finished};
}

// Opt-in: site.notify(alert, ctx) is called once when an alert first appears, and again only after it clears and
// returns. Without a notify hook nothing is sent; files stay the channel.
function notifyNewAlerts(ctx, alerts) {
  const {c, site} = ctx;
  if (typeof site.notify !== 'function') return;
  const file = path.join(c.paths.state, 'notified.json');
  const key = a => `${a.code}:${a.ids.join(',')}`;
  const before = new Set(readJson(file, {keys: []})?.keys ?? []);
  const keys = alerts.map(key);
  for (const a of alerts) {
    if (before.has(key(a))) continue;
    try { site.notify({campaign: c.config.id, ...a}, {campaign: c.config, exec: ctx.slurm.exec}); ctx.log('notified', {code: a.code, ids: a.ids}); }
    catch (err) { ctx.log('notify_error', {code: a.code, error: errText(err)}); }
  }
  if (keys.length !== before.size || keys.some(k => !before.has(k))) writeJson(file, {keys});
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
// True when this process holds the campaign lock (inherited from `flock --no-fork` in the unit).
function holdsLock(lock) {
  if (!fs.existsSync(lock)) return false;
  const real = fs.realpathSync(lock);
  const mine = fs.readdirSync('/proc/self/fd').some(fd => { try { return fs.readlinkSync(`/proc/self/fd/${fd}`) === real; } catch { return false; } });
  if (!mine) return false;
  try { execFileSync('flock', ['-n', lock, 'true'], {stdio: 'ignore'}); return false; } catch { return true; }
}

export async function runController(ref, {tickMs = 30000} = {}) {
  const c = loadCampaign(resolveCampaignDir(ref));
  const lock = path.join(configDir(), 'locks', `${c.config.id}.lock`);
  if (!holdsLock(lock)) throw Error(`refusing to run without the campaign lock ${lock}; start it with arc start (systemd) so only one controller runs`);
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
