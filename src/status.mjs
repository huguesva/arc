// status.json is rebuilt from state on every tick. Alerts are derived conditions; they clear themselves.
import path from 'node:path';
import {readText, isoNow} from './fsutil.mjs';
import {TERMINAL} from './slurm.mjs';
import {claimCounts} from './claims.mjs';
import {deadlineMs} from './campaign.mjs';

const FINDINGS_SOFT_LINES = 150;
const isActiveJob = r => r.status === 'submitted' && !TERMINAL.has(r.slurm_state);

export function buildStatus({c, records, obs, turns, claims, now, phase, controller}) {
  const dl = deadlineMs(c.config);
  const alerts = [];
  const alert = (code, message, ids = []) => alerts.push({code, message, ids});
  const uncertain = records.filter(r => r.status === 'uncertain');
  if (uncertain.length) alert('uncertain_submission', 'submission outcome unknown; GPUs stay reserved until exactly one matching job is found or `arc reconcile` decides', uncertain.map(r => r.id));
  if (obs.orphans.length) alert('orphan_job', 'campaign-tagged jobs in the queue that match no request record; their GPUs count against the budget', obs.orphans.map(o => o.id));
  if (obs.mutated.length) alert('request_mutated', 'request files changed after first sight; the original content is used and the edit ignored', obs.mutated);
  if (obs.badFiles.length) alert('bad_request_file', 'files in requests/ that are not <valid-id>.json are ignored', obs.badFiles);
  if (obs.withdrawUncertain.length) alert('withdraw_uncertain', 'withdrawal waits until the uncertain submission is resolved (arc reconcile)', obs.withdrawUncertain);
  for (const [role, rs] of Object.entries(turns)) if (rs.consecutive_failures >= 3) alert('role_failing', `${role} failed ${rs.consecutive_failures} times in a row; retrying with backoff. Last error: ${rs.last_error}`, [role]);
  if (obs.tickError) alert('controller_error', `last tick failed: ${obs.tickError}`);
  const modified = records.filter(r => isActiveJob(r) && r.evaluator_status === 'modified').map(r => r.id);
  if (modified.length) alert('evaluator_modified', 'active runs use a modified evaluator; their results are exploratory', modified);
  const findingsLines = (readText(c.paths.findings, '') || '').split('\n').length;
  if (findingsLines > FINDINGS_SOFT_LINES) alert('findings_long', `findings.md has ${findingsLines} lines; the worker is asked to consolidate`);
  const blocked = (readText(c.paths.blocked, '') || '').trim();
  if (blocked) alert('blocked', `worker reports a blocker: ${blocked.split('\n')[0].slice(0, 200)}`);
  const dupes = [...new Set(claims.filter(cl => cl.duplicate).map(cl => cl.id))];
  if (dupes.length) alert('duplicate_claim_id', 'claim ids appear more than once in findings.md', dupes);

  const job = r => ({request: r.id, job_id: r.job_id ?? null, state: r.slurm_state ?? r.status, gpus: r.request?.gpus ?? 0,
    exit: r.exit_code ?? null, withdrawn: r.withdrawn ?? null, artifacts: path.join(c.paths.artifacts, r.id)});
  const recent = records.filter(r => r.status === 'finished').sort((a, b) => (b.finished_at ?? '').localeCompare(a.finished_at ?? '')).slice(0, 15);
  const counts = {};
  for (const r of records) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const role = (name, rs) => ({
    configured: !!c.config[name], active: rs.active ? {turn: rs.active.n, unit: rs.active.unit, started_at: isoNow(rs.active.started_at)} : null,
    last_started: rs.last_started_at ? isoNow(rs.last_started_at) : null, last_finished: rs.last_finished_at ? isoNow(rs.last_finished_at) : null,
    next_due_at: rs.next_due_at ? isoNow(rs.next_due_at) : null, idle_streak: rs.idle_streak ?? 0,
    consecutive_failures: rs.consecutive_failures, last_error: rs.last_error,
    health: rs.consecutive_failures >= 3 ? 'failing' : rs.consecutive_failures ? 'retrying' : 'ok', totals: rs.totals,
    ...(name === 'auditor' ? {audits: rs.audits} : {}),
  });
  return {
    schema: 'arc.status/2',
    campaign: c.config.id,
    generated_at: isoNow(now),
    controller: {...controller, heartbeat_at: isoNow(now), phase},
    deadline: {at: dl ? isoNow(dl) : null, remaining_s: dl ? Math.max(0, Math.round((dl - now) / 1000)) : null, closed: dl !== null && now >= dl},
    budget: {cap: c.config.gpu_cap, reserved: obs.reserved, free: Math.max(0, c.config.gpu_cap - obs.reserved), orphan_gpus: obs.orphans.reduce((n, o) => n + o.gpus, 0)},
    counts,
    queue: obs.queue,
    jobs: {active: records.filter(isActiveJob).map(job), recent: recent.map(job)},
    roles: {worker: role('worker', turns.worker), auditor: role('auditor', turns.auditor)},
    claims: claimCounts(claims),
    blocked: blocked || null,
    alerts,
  };
}
