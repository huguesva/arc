// arc command line. Every verb writes only human-owned files (control/, steering.md, withdraw/) or calls systemd.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readJson, readText, writeJson, writeAtomic, appendJsonl, isoNow} from './fsutil.mjs';
import {loadCampaign, loadSite, resolveCampaignDir, registryLink, registeredIds, configDir} from './campaign.mjs';
import {validateRequest, validateInRepo} from './request.mjs';
import {commitExists, git, gitStatus} from './git.mjs';
import {claimStates} from './claims.mjs';
import {runController, loadRecords, isLive} from './controller.mjs';
import {runTurn, unitGlob} from './turns.mjs';
import {realSlurm} from './slurm.mjs';
import {systemctl, unitState} from './systemd.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARC = path.join(HERE, '..', 'bin', 'arc');
const PAUSES = {submissions: 'PAUSE_SUBMISSIONS', worker: 'PAUSE_WORKER', auditor: 'PAUSE_AUDITOR'};
const VERDICTS = ['accept', 'reject', 'needs-more'];

const HELP = `arc — Autonomous Research Controller

  arc init <id> --repo <path> [--dir <dir>]   new campaign from templates (in runs_root by default)
  arc start <campaign-dir> [--no-enable]   set up (dirs, worktree, unit) and start; idempotent
  arc status [<id>] [--json]                one campaign, or all
  arc steer <id> -m "text" | -f file [-t title]
  arc pause|resume <id> [submissions|worker|auditor]
  arc priority <id> <request> <n>
  arc withdraw <id> <request> -m "reason"   queued: dropped; submitted (pending or running): cancelled
  arc claims <id>
  arc review <id> <claim> accept|reject|needs-more --hash <h> -m "note"   (h as shown by arc claims)
  arc reconcile <id> <request> --adopt <job> | --abandon
  arc restart <id>
  arc stop <id> [--cancel-jobs] -m "reason"
  arc archive <id> [--force]
  arc check-request <file> [--campaign <dir>]
  arc run <id> | arc turn <dir> <role> <n>   internal entry points`;

function parse(argv) {
  const pos = [], opt = {};
  const valued = new Set(['-m', '-f', '-t', '--campaign', '--adopt', '--repo', '--dir', '--hash']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued.has(a)) opt[a.replace(/^-+/, '')] = argv[++i];
    else if (a.startsWith('--')) opt[a.slice(2)] = true;
    else pos.push(a);
  }
  return {pos, opt};
}

const need = (v, what) => { if (v === undefined || v === '') throw Error(`missing ${what}\n\n${HELP}`); return v; };
const campaign = ref => loadCampaign(resolveCampaignDir(need(ref, 'campaign')));
const unit = c => `arc@${c.config.id}.service`;
const which = (bin, PATH) => { try { return execFileSync('sh', ['-c', 'command -v "$1"', 'sh', bin], {encoding: 'utf8', env: {...process.env, PATH}}).trim(); } catch { return null; } };

function renderUnit(site) {
  const tpl = readText(path.join(HERE, '..', 'templates', 'arc@.service'));
  const vars = {NODE: process.execPath, ARC: ARC, CONFIG: configDir(), FLOCK: which('flock', process.env.PATH) ?? '/usr/bin/flock',
    PATH: site.path ?? process.env.PATH, SITE: process.env.ARC_SITE ? `Environment=ARC_SITE=${process.env.ARC_SITE}` : ''};
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

async function init(id, opt) {
  const site = await loadSite();
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(id ?? '')) throw Error('usage: arc init <id> --repo <path> [--dir <campaign dir>]');
  const repo = path.resolve(need(opt.repo, '--repo <path>'));
  const dir = path.resolve(opt.dir ?? path.join(need(site.runs_root, 'runs_root in site.mjs (or pass --dir)'), id));
  if (fs.existsSync(path.join(dir, 'campaign.json'))) throw Error(`${dir} already holds a campaign`);
  const tpl = name => readText(path.join(HERE, '..', 'templates', name));
  const config = {...JSON.parse(tpl('campaign.json')), id, repo, base_commit: git(repo, ['rev-parse', 'HEAD']).trim(), job_prefix: id.slice(0, 16).replace(/-+$/, '')};
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  writeJson(path.join(dir, 'campaign.json'), config);
  for (const f of ['brief.md', 'steering.md']) writeAtomic(path.join(dir, f), tpl(f));
  console.log(`created ${dir}\nnext: edit campaign.json (models, GPU cap, deadline) and brief.md, then: arc start ${dir}`);
  return 0;
}

async function start(ref, opt) {
  const site = await loadSite();
  need(ref, 'campaign directory');
  const dir = path.resolve(fs.existsSync(ref) || !site.runs_root ? ref : path.join(site.runs_root, ref));
  const c = loadCampaign(dir);
  const {config, paths} = c;
  const problems = [];
  if (!fs.existsSync(paths.brief)) problems.push('brief.md is missing');
  if (!commitExists(config.repo, config.base_commit)) problems.push(`base_commit ${config.base_commit} not found in ${config.repo}`);
  if (config.evaluator && !commitExists(config.repo, config.evaluator.commit)) problems.push(`evaluator.commit ${config.evaluator.commit} not found`);
  for (const role of ['worker', 'auditor']) {
    const rc = config[role];
    if (rc && !which(rc.bin ?? rc.agent, site.path ?? process.env.PATH)) problems.push(`${role} agent binary ${rc.bin ?? rc.agent} not found on PATH`);
  }
  try { realSlurm().queue(); } catch (err) { problems.push(`cannot query the scheduler: ${String(err.stderr || err.message).trim()}`); }
  const link = registryLink(config.id);
  if (fs.existsSync(link) && fs.realpathSync(link) !== fs.realpathSync(dir)) problems.push(`campaign id ${config.id} is already registered for ${fs.realpathSync(link)}`);
  if (problems.length) throw Error(`cannot start ${config.id}:\n- ${problems.join('\n- ')}`);

  for (const d of [paths.control, paths.requests, paths.withdraw, path.join(paths.state, 'requests'), paths.artifacts, paths.turns, paths.reconcile]) fs.mkdirSync(d, {recursive: true, mode: 0o700});
  if (!fs.existsSync(paths.steering)) writeAtomic(paths.steering, '# Steering\n\nDated notes from the coordinator. Later entries supersede earlier ones.\n');
  if (!fs.existsSync(paths.worktree)) {
    const branch = `arc/${config.id}`;
    const exists = gitStatus(config.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
    git(config.repo, ['worktree', 'add', paths.worktree, ...(exists ? [branch] : ['-b', branch, config.base_commit])]);
    console.log(`worktree ${paths.worktree} on branch ${branch}`);
  }
  fs.mkdirSync(path.dirname(link), {recursive: true});
  if (!fs.existsSync(link)) fs.symlinkSync(dir, link);
  fs.mkdirSync(path.join(configDir(), 'locks'), {recursive: true, mode: 0o700});
  fs.rmSync(path.join(paths.control, 'STOP'), {force: true});
  if (opt['no-enable']) { console.log(`${config.id}: set up, not started (--no-enable)`); return 0; }

  const unitFile = path.join(os.homedir(), '.config', 'systemd', 'user', 'arc@.service');
  const rendered = renderUnit(site);
  if (readText(unitFile) !== rendered) { writeAtomic(unitFile, rendered, 0o644); systemctl('daemon-reload'); }
  const before = Date.now();
  systemctl('enable', '--now', unit(c));
  for (let i = 0; i < 90; i++) {
    const s = readJson(paths.status);
    if (s && Date.parse(s.controller?.heartbeat_at) >= before - 1000) { console.log(`${config.id}: running (${unitState(unit(c))}); arc status ${config.id}`); return 0; }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`${config.id}: unit ${unitState(unit(c))} but no heartbeat after 90 s; check journalctl --user -u ${unit(c)}`);
  return 1;
}

function ageText(iso) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

function statusOne(c, opt) {
  const s = readJson(c.paths.status);
  const u = unitState(unit(c));
  if (opt.json) { console.log(JSON.stringify({unit: u, status: s}, null, 2)); return 0; }
  if (!s) { console.log(`${c.config.id}: no status yet (unit ${u})`); return 0; }
  const stale = Date.now() - Date.parse(s.controller.heartbeat_at) > 180000;
  const dead = (stale || u !== 'active') && !['stopped', 'finished'].includes(s.controller.phase);
  const L = [];
  L.push(`${s.campaign}: ${dead ? 'CONTROLLER NOT RUNNING — ' : ''}${s.controller.phase}, unit ${u}, heartbeat ${ageText(s.controller.heartbeat_at)} ago`);
  for (const a of s.alerts) L.push(`  ! ${a.code}: ${a.message}${a.ids.length ? ` [${a.ids.join(', ')}]` : ''}`);
  L.push(`  GPUs ${s.budget.reserved}/${s.budget.cap} reserved; deadline ${s.deadline.at ?? 'none'}${s.deadline.closed ? ' (closed)' : ''}`);
  L.push(`  requests ${Object.entries(s.counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  L.push(`  claims ${s.claims.total}: ${s.claims.awaiting_review} awaiting your review, ${s.claims.stale} stale, ${s.claims.audited_unsupported} flagged by the auditor, ${s.claims.accepted} accepted`);
  for (const [role, r] of Object.entries(s.roles)) if (r.configured) {
    L.push(`  ${role}: ${r.active ? `turn ${r.active.turn} running since ${ageText(r.active.started_at)}` : `idle, next ${r.next_due_at ?? 'on news'}`}; ${r.health}${r.last_error ? ` — ${r.last_error}` : ''}; ${r.totals.turns} turns${r.totals.checkins ? ` (${r.totals.checkins} check-ins)` : ''}, ${(r.totals.input_tokens / 1e6).toFixed(1)}M input tokens`);
  }
  if (s.jobs.active.length) L.push(`  active: ${s.jobs.active.map(j => `${j.request} (${j.job_id} ${j.state})`).join(', ')}`);
  if (s.queue.length) L.push(`  queue: ${s.queue.slice(0, 10).map(q => `${q.id} [${q.waiting_for}]`).join(', ')}${s.queue.length > 10 ? ` … +${s.queue.length - 10}` : ''}`);
  console.log(L.join('\n'));
  return 0;
}

function statusAll() {
  const ids = registeredIds();
  if (!ids.length) { console.log('no registered campaigns'); return 0; }
  let total = 0;
  for (const id of ids) {
    try {
      const c = campaign(id);
      const s = readJson(c.paths.status);
      total += s?.budget.reserved ?? 0;
      console.log(`${id.padEnd(28)} ${(s?.controller.phase ?? '-').padEnd(16)} unit ${unitState(unit(c)).padEnd(9)} GPUs ${s?.budget.reserved ?? '?'}/${c.config.gpu_cap}  alerts ${s?.alerts.length ?? '?'}  claims awaiting ${s?.claims.awaiting_review ?? '?'}`);
    } catch (err) { console.log(`${id.padEnd(28)} error: ${err.message.split('\n')[0]}`); }
  }
  console.log(`total GPUs reserved by arc campaigns: ${total}`);
  return 0;
}

function stop(c, opt) {
  const {paths, config} = c;
  writeAtomic(path.join(paths.control, 'STOP'), `${isoNow()} ${need(opt.m, 'reason (-m)')}\n`);
  try { systemctl('stop', unit(c)); } catch (err) { console.log(`warning: ${String(err.stderr || err.message).trim()}`); }
  try { systemctl('stop', unitGlob(config.id)); } catch { /* no turn units */ }
  const prefix = `arc:${config.id}:`;
  let queue = [];
  try { queue = realSlurm().queue().filter(r => r.comment.startsWith(prefix)); } catch (err) { console.log(`warning: cannot query scheduler: ${err.message}`); }
  if (opt['cancel-jobs']) {
    const ids = [...new Set([...loadRecords(c).filter(isLive).map(r => r.job_id).filter(Boolean), ...queue.map(r => r.id)])];
    if (ids.length) { realSlurm().cancel(ids); console.log(`cancelled ${ids.length} jobs: ${ids.join(' ')}`); }
    queue = [];
  }
  const lock = path.join(configDir(), 'locks', `${config.id}.lock`);
  let lockFree = true;
  try { execFileSync('flock', ['-n', lock, 'true']); } catch { lockFree = false; }
  const turnUnits = (() => { try { return systemctl('list-units', '--plain', '--no-legend', unitGlob(config.id)).trim(); } catch { return ''; } })();
  console.log(`${config.id}: controller ${unitState(unit(c))}, lock ${lockFree ? 'free' : 'STILL HELD'}, turn units ${turnUnits ? 'STILL ACTIVE:\n' + turnUnits : 'none'}`);
  if (queue.length) console.log(`jobs preserved in Slurm: ${queue.map(r => `${r.id} (${r.state})`).join(', ')}`);
  return lockFree && !turnUnits && unitState(unit(c)) !== 'active' ? 0 : 1;
}

async function checkRequest(file, opt) {
  const text = fs.readFileSync(need(file, 'request file'), 'utf8');
  let r;
  try { r = JSON.parse(text); } catch (err) { console.log(`invalid JSON: ${err.message}`); return 1; }
  let errors = validateRequest(r, {fileId: path.basename(file).replace(/\.json$/, '')});
  const dir = opt.campaign ?? process.env.ARC_CAMPAIGN_DIR;
  if (!errors.length && dir) {
    const c = loadCampaign(dir);
    const site = await loadSite().catch(() => null);
    errors = validateInRepo(r, c.config.repo, site?.forbidden(r) ?? []);
    if (!errors.length && site) { try { site.validate(r); } catch (err) { errors = [`cluster rules: ${err.message}`]; } }
  }
  console.log(errors.length ? errors.map(e => `- ${e}`).join('\n') : `OK${dir ? '' : ' (schema only; pass --campaign to check the commit and script)'}`);
  return errors.length ? 1 : 0;
}

export async function main(argv) {
  const [verb, ...rest] = argv;
  const {pos, opt} = parse(rest);
  switch (verb) {
    case 'init': return init(pos[0], opt);
    case 'start': return start(pos[0], opt);
    case 'status': return pos[0] ? statusOne(campaign(pos[0]), opt) : statusAll();
    case 'steer': {
      const c = campaign(pos[0]);
      const text = opt.m ?? (opt.f ? fs.readFileSync(opt.f, 'utf8') : need(undefined, 'text (-m or -f)'));
      const title = opt.t ?? text.trim().split('\n')[0].slice(0, 70);
      fs.appendFileSync(c.paths.steering, `\n## ${isoNow().slice(0, 16)}Z — ${title}\n\n${text.trim()}\n`);
      console.log(`appended to ${c.paths.steering}; the next turns will read it`);
      return 0;
    }
    case 'pause': case 'resume': {
      const c = campaign(pos[0]);
      const name = pos[1] === 'advisor' ? 'auditor' : pos[1]; // the auditor's old name
      const which = name ? [need(PAUSES[name], 'submissions|worker|auditor')] : Object.values(PAUSES);
      for (const f of which) {
        const p = path.join(c.paths.control, f);
        if (verb === 'pause') writeAtomic(p, `${isoNow()} ${opt.m ?? ''}\n`); else fs.rmSync(p, {force: true});
        if (verb === 'resume' && f === 'PAUSE_AUDITOR') fs.rmSync(path.join(c.paths.control, 'PAUSE_ADVISOR'), {force: true});
      }
      console.log(`${verb}d ${which.join(', ')}`);
      return 0;
    }
    case 'priority': {
      const c = campaign(pos[0]);
      const n = Number(need(pos[2], 'priority'));
      if (!Number.isInteger(n)) throw Error('priority must be an integer');
      writeJson(c.paths.priority, {...readJson(c.paths.priority, {}), [need(pos[1], 'request')]: n});
      return 0;
    }
    case 'withdraw': {
      const c = campaign(pos[0]);
      const p = path.join(c.paths.withdraw, need(pos[1], 'request'));
      writeAtomic(p, `${need(opt.m, 'reason (-m)')}\n`);
      console.log(`withdrawal of ${pos[1]} recorded; the controller drops it if queued or cancels its job if submitted`);
      return 0;
    }
    case 'claims': {
      const states = claimStates(campaign(pos[0]));
      const order = ['stale', 'audited', 'new', 'reviewed:needs-more', 'reviewed:reject', 'reviewed:accept', 'superseded'];
      states.sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
      for (const cl of states) console.log(`${cl.id.padEnd(5)} [${cl.state}] ${cl.hash.slice(0, 8)}  ${cl.title}${cl.audit ? `\n      audit: ${cl.audit.verdict}${cl.audit.detail ? ` — ${cl.audit.detail}` : ''}` : ''}${cl.review ? `\n      you: ${cl.review.verdict}${cl.review.note ? ` — ${cl.review.note}` : ''}` : ''}`);
      if (!states.length) console.log('no claims in findings.md yet');
      return 0;
    }
    case 'review': {
      const c = campaign(pos[0]);
      const id = need(pos[1], 'claim id');
      const verdict = need(pos[2], 'verdict');
      if (!VERDICTS.includes(verdict)) throw Error(`verdict must be one of ${VERDICTS.join(', ')}`);
      const cl = claimStates(c).find(x => x.id === id && !x.superseded);
      if (!cl) throw Error(`no current claim ${id} in findings.md`);
      const shown = need(opt.hash, '--hash <h> (the hash shown by arc claims, so the verdict binds to the text you read)');
      if (!cl.hash.startsWith(shown)) throw Error(`${id} changed since you read it (now ${cl.hash.slice(0, 8)}); run arc claims again`);
      appendJsonl(c.paths.reviews, {claim: id, verdict, note: opt.m ?? '', hash: cl.hash, at: isoNow(), by: os.userInfo().username});
      console.log(`${id}: ${verdict} (bound to the current text of the claim)`);
      return 0;
    }
    case 'reconcile': {
      const c = campaign(pos[0]);
      const req = need(pos[1], 'request');
      const cmd = opt.adopt ? {action: 'adopt', job: String(opt.adopt)} : opt.abandon ? {action: 'abandon'} : need(undefined, '--adopt <job> or --abandon');
      writeJson(path.join(c.paths.reconcile, `${req}.json`), {...cmd, at: isoNow()});
      console.log('recorded; the controller applies it on its next tick');
      return 0;
    }
    case 'restart': { const c = campaign(pos[0]); systemctl('restart', unit(c)); console.log(`${unit(c)} ${unitState(unit(c))}`); return 0; }
    case 'stop': return stop(campaign(pos[0]), opt);
    case 'archive': {
      const c = campaign(pos[0]);
      if (unitState(unit(c)) === 'active') throw Error('stop the campaign first');
      if (fs.existsSync(c.paths.worktree)) git(c.config.repo, ['worktree', 'remove', ...(opt.force ? ['--force'] : []), c.paths.worktree]);
      try { systemctl('disable', unit(c)); } catch { /* not enabled */ }
      fs.rmSync(registryLink(c.config.id), {force: true});
      console.log(`${c.config.id}: archived; data kept in ${c.dir}; branch arc/${c.config.id} kept`);
      return 0;
    }
    case 'check-request': return checkRequest(pos[0], opt);
    case 'run': await runController(need(pos[0], 'campaign')); return 0;
    case 'turn': return runTurn(need(pos[0], 'campaign dir'), need(pos[1], 'role'), need(pos[2], 'turn number'));
    case undefined: case 'help': case '--help': case '-h': console.log(HELP); return 0;
    default: throw Error(`unknown command ${verb}\n\n${HELP}`);
  }
}
