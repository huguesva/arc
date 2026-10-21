// Agent adapters: role config -> command line, transcript -> {ok, report, model, usage, error}.
import {readText} from './fsutil.mjs';

const WORKER_TOOLS = 'Bash,Read,Edit,Write,Glob,Grep';
const ADVISOR_TOOLS = 'Read,Glob,Grep,Bash';
const ADVISOR_ALLOWED = 'Read,Glob,Grep,Bash(git show:*),Bash(git diff:*),Bash(git log:*)'; // read-only git only

export function agentCommand(role, rc, {worktree, campaignDir, reportFile, gitDir}) {
  const readOnly = role === 'advisor';
  if (rc.agent === 'codex') {
    const args = ['exec', ...(rc.profile ? ['-p', rc.profile] : []), '--model', rc.model, '--ephemeral',
      '--sandbox', readOnly ? 'read-only' : 'danger-full-access', '-c', 'approval_policy="never"', '-c', 'notify=[]',
      ...(rc.effort ? ['-c', `model_reasoning_effort="${rc.effort}"`] : []),
      '--cd', worktree, '--add-dir', campaignDir, '--json', '--output-last-message', reportFile, ...(rc.args ?? []), '-'];
    return {bin: rc.bin ?? 'codex', args};
  }
  const tools = readOnly ? ADVISOR_TOOLS : WORKER_TOOLS;
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--model', rc.model,
    ...(rc.effort ? ['--effort', rc.effort] : []), '--permission-mode', 'dontAsk', '--tools', tools, '--allowedTools', readOnly ? ADVISOR_ALLOWED : tools,
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--add-dir', campaignDir, ...(gitDir ? ['--add-dir', gitDir] : []), ...(rc.args ?? [])];
  return {bin: rc.bin ?? 'claude', args};
}

function jsonLines(raw) {
  const rows = [];
  for (const line of raw.split('\n')) { if (line.trim().startsWith('{')) { try { rows.push(JSON.parse(line)); } catch { /* skip */ } } }
  return rows;
}

// Provider errors are often JSON nested inside a message string.
function unwrap(message) {
  try { const inner = JSON.parse(message); return inner?.error?.message ?? inner?.message ?? message; } catch { return message; }
}

export function parseTranscript(rc, {raw, stderr, code, reportFile}) {
  const rows = jsonLines(raw);
  let report = '', model = null, error = null, failed = false;
  const usage = {input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, cost_usd: null};
  if (rc.agent === 'codex') {
    report = readText(reportFile, '') ?? '';
    model = rc.model; // codex does not echo the resolved model
    for (const r of rows) {
      if (r.type === 'turn.completed' && r.usage) {
        usage.input_tokens += r.usage.input_tokens ?? 0;
        usage.cached_input_tokens += r.usage.cached_input_tokens ?? 0;
        usage.output_tokens += r.usage.output_tokens ?? 0;
      }
      if (r.type === 'turn.failed') { failed = true; error ??= unwrap(r.error?.message ?? 'turn failed'); }
      if (r.type === 'error') error ??= unwrap(r.message ?? 'error');
    }
  } else {
    for (const r of rows) {
      if (r.type === 'system' && r.subtype === 'init') model = r.model ?? model;
      if (r.type === 'result') {
        report = r.result ?? '';
        if (r.is_error) { failed = true; error ??= report || r.subtype; }
        const u = r.usage ?? {};
        usage.input_tokens += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        usage.cached_input_tokens += u.cache_read_input_tokens ?? 0;
        usage.output_tokens += u.output_tokens ?? 0;
        if (typeof r.total_cost_usd === 'number') usage.cost_usd = (usage.cost_usd ?? 0) + r.total_cost_usd;
      }
    }
    if (model && model !== rc.model) { failed = true; error = `model mismatch: configured ${rc.model}, provider reported ${model}; no substitution`; }
  }
  if (code !== 0 && !error) error = `exit ${code}: ${String(stderr).trim().slice(-500) || 'no stderr'}`;
  if (!report.trim() && !error) error = 'no report produced';
  const ok = code === 0 && !failed && !!report.trim();
  return {ok, report, model, usage, error: ok ? null : error};
}
