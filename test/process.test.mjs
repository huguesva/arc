// The real controller process (`arc run`) against stand-in scheduler commands on PATH.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {tempRepo, makeCampaign, tempDir} from './helpers.mjs';

const ARC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'arc');

test('arc run writes a heartbeat and exits cleanly on SIGTERM', async () => {
  const {repo, commit} = tempRepo();
  const c = makeCampaign({repo, commit});
  const bin = tempDir('arc-bin-');
  for (const cmd of ['squeue', 'sacct']) { fs.writeFileSync(path.join(bin, cmd), '#!/bin/sh\nexit 0\n'); fs.chmodSync(path.join(bin, cmd), 0o755); }
  const cfg = tempDir('arc-config-');
  fs.writeFileSync(path.join(cfg, 'site.mjs'), 'export function route(r) { return {args: []}; }\n');
  const child = spawn(process.execPath, [ARC, 'run', c.dir], {env: {...process.env, PATH: `${bin}:${process.env.PATH}`, ARC_CONFIG_DIR: cfg}, stdio: ['ignore', 'pipe', 'pipe']});
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  for (let i = 0; i < 100 && !fs.existsSync(c.paths.status); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(fs.existsSync(c.paths.status), `status written; stderr: ${stderr}`);
  const t0 = Date.now();
  child.kill('SIGTERM');
  const code = await new Promise(r => child.on('exit', r));
  assert.equal(code, 0);
  assert.ok(Date.now() - t0 < 5000, 'exits promptly instead of waiting for the next tick');
  const events = fs.readFileSync(c.paths.events, 'utf8');
  assert.match(events, /controller_started/);
  assert.match(events, /controller_exit/);
});
