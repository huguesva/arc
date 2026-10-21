// Claims live in findings.md (worker-owned). Reviews live in control/reviews.jsonl (human-only).
// Audits and reviews count only while the claim's text hash is unchanged.
import {sha256, readText, readJsonl, readJson} from './fsutil.mjs';
import path from 'node:path';

const CLAIM_HEADING = /^###\s+(C\d+)\s*(?:[—–:-]\s*)?(.*)$/;

export function parseClaims(text) {
  const claims = [];
  let section = '', current = null;
  const flush = () => { if (current) { const body = current.lines.join('\n').trim(); claims.push({...current, text: body, hash: sha256(body)}); } current = null; };
  for (const line of (text ?? '').split('\n')) {
    const h2 = /^##\s+(.*)$/.exec(line);
    const claim = CLAIM_HEADING.exec(line);
    if (claim) { flush(); current = {id: claim[1], title: claim[2].trim(), superseded: /supersed|retract/i.test(section), lines: [line]}; continue; }
    if (h2 || /^#{1,3}\s/.test(line)) { flush(); if (h2) section = h2[1]; continue; }
    if (current) current.lines.push(line);
  }
  flush();
  return claims.map(({lines, ...c}) => c);
}

// Advisor verdict lines: "C3: supported — evidence".
const VERDICT = /^\s*[-*]?\s*\**(C\d+)\**\s*:\s*\**(supported|unsupported|can['’]?t tell|cannot tell)\**\s*(.*)$/i;
export function parseVerdicts(report) {
  const out = {};
  for (const line of (report ?? '').split('\n')) {
    const m = VERDICT.exec(line);
    if (m) out[m[1]] = {verdict: m[2].toLowerCase().replace(/[’']/g, "'").replace('cannot tell', "can't tell").replace('cant tell', "can't tell"), detail: m[3].replace(/^[—–-]\s*/, '').trim()};
  }
  return out;
}

export function latestReviews(file) {
  const latest = {};
  for (const r of readJsonl(file)) if (r.claim) latest[r.claim] = r;
  return latest;
}

// Derived state per claim, newest work first for the human.
export function claimStates(campaign) {
  const {paths} = campaign;
  const claims = parseClaims(readText(paths.findings, ''));
  const audits = readJson(path.join(paths.state, 'claims.json'), {audits: {}}).audits ?? {};
  const reviews = latestReviews(paths.reviews);
  const seen = new Set();
  return claims.map(c => {
    const duplicate = seen.has(c.id); seen.add(c.id);
    const audit = audits[c.id]?.hash === c.hash ? audits[c.id] : null;
    const review = reviews[c.id];
    let state;
    if (c.superseded) state = 'superseded';
    else if (review && review.hash === c.hash) state = `reviewed:${review.verdict}`;
    else if (review) state = 'stale';
    else if (audit) state = 'audited';
    else state = 'new';
    return {...c, duplicate, state, audit, review: review ?? null};
  });
}

export function claimCounts(states) {
  const live = states.filter(c => c.state !== 'superseded');
  return {
    total: live.length,
    awaiting_review: live.filter(c => c.state === 'new' || c.state === 'audited').length,
    stale: live.filter(c => c.state === 'stale').length,
    audited_unsupported: live.filter(c => c.audit && c.audit.verdict !== 'supported' && !c.state.startsWith('reviewed')).length,
    accepted: live.filter(c => c.state === 'reviewed:accept').length,
    rejected: live.filter(c => c.state === 'reviewed:reject').length,
  };
}
