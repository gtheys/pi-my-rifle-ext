#!/usr/bin/env node
// harness-profiler: records every tool call of a coding agent session and
// prints the calls as a tree. One file, no dependencies, Node 18+.
//
//   hp capture <harness>          hook entry point: reads one payload on stdin
//   hp tree [id-prefix] [--branch <name>] [--verbose] [--format text|html]
//   hp init claude                commits the hook into this repo (Claude Code on the web)
//   hp doctor                     says whether capture works here and why not
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SCHEMA_VERSION = 2;
const TRACE_DIR = '.harness-profile';
const TOOL_EVENTS = ['PostToolUse', 'PostToolUseFailure'];
const SESSION_EVENTS = ['PreCompact', 'PostCompact', 'SessionStart', 'SubagentStop'];
const LAUNCHED = 'async_launched';
const CAPTURED_EVENTS = [...TOOL_EVENTS, ...SESSION_EVENTS];
const COPY_AGENT_TYPE = 'fork';
const MAIN = 'main';
const VIEW_TEMPLATE = 'view.html';
const SHOW_SKILL = path.join('skills', 'show-profile');
const DATA_SLOT = '/*DATA*/null';
const DUPLICATE_EVENT_MS = 5000;
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
const ANSI_COLORS = [36, 33, 35, 32, 34, 31];
const PARENT_TOOLS = ['Skill', 'Agent'];
const HANDBACK = 'SubagentHandback';
const DEFAULT_AGENT = 'general-purpose';
const NAME_LIMIT = 80;
const ARGS_LIMIT = 200;
const RESULT_LIMIT = 300;
const LINE_LIMIT = 4096;
const TREE_WIDTH = 160;
const CONTEXT_WIDTH = 6;
const SESSION_WIDTH = 8;
const SHORT_SHA = 7;
const NEWLINE = ' ⏎ ';
const ELLIPSIS = '…';
const SECRETS = [
  [/\b(Bearer|Basic|token)\s+[\w.~+/=-]{8,}/gi, '$1 [redacted]'],
  [/\b((?:api[_-]?key|access[_-]?token|token|secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)[^\s"'&]+/gi, '$1[redacted]'],
  [/\b(?:gh[pousr]_|github_pat_|sk-|xox[abp]-)[\w-]{10,}/g, '[redacted]'],
];
const SECRET_KEY = /token|secret|password|api_?key|authorization|credential/i;
const LAUNCHER = 'hp.sh';
// Before 0.2.0 the launcher was `hp`, and a committed hook ran it by that name.
const OLD_LAUNCHER = 'hp';
const hookCommand = (launcher) => `sh "$CLAUDE_PROJECT_DIR/.claude/harness-profiler/${launcher}" capture claude`;
const HOOK_COMMAND = hookCommand(LAUNCHER);
const OLD_HOOK_COMMAND = hookCommand(OLD_LAUNCHER);
const HOOK_TIMEOUT_S = 5;
const HOOK_DIR = path.join('.claude', 'harness-profiler');
const HOOK_FILES = [LAUNCHER, 'hp.js', VIEW_TEMPLATE];

// ---------- text helpers ----------

function mask(text) {
  return SECRETS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

function clip(text, limit) {
  return text.length <= limit ? text : text.slice(0, Math.max(limit - 1, 0)) + ELLIPSIS;
}

function oneLine(text) {
  return String(text).trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(NEWLINE);
}

function firstLine(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
}

// ---------- git, without spawning git ----------

function gitRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// A worktree's `.git` is a file pointing at its own git dir.
function gitDir(root) {
  const dotGit = path.join(root, '.git');
  if (fs.statSync(dotGit).isDirectory()) return dotGit;
  const target = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m)[1].trim();
  return path.resolve(root, target);
}

// Worktrees share `info/exclude` with the main repository.
function commonGitDir(dir) {
  const pointer = path.join(dir, 'commondir');
  return fs.existsSync(pointer) ? path.resolve(dir, fs.readFileSync(pointer, 'utf8').trim()) : dir;
}

function branchOf(start) {
  try {
    const root = gitRoot(start);
    if (!root) return undefined;
    const head = fs.readFileSync(path.join(gitDir(root), 'HEAD'), 'utf8').trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return ref ? ref[1] : head.slice(0, SHORT_SHA);
  } catch {
    return undefined;
  }
}

function excludeTraces(projectDir) {
  const root = gitRoot(projectDir);
  if (!root) return;
  const exclude = path.join(commonGitDir(gitDir(root)), 'info', 'exclude');
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (current.split(/\r?\n/).includes(`${TRACE_DIR}/`)) return;
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${TRACE_DIR}/\n`);
}

// Claude Code sets CLAUDE_PROJECT_DIR to the launch directory, which can sit
// below the git root. Traces go to the git root so `hp tree` finds them from
// anywhere in the repository.
function projectDir(cwd, env = hookEnv()) {
  const start = env.CLAUDE_PROJECT_DIR || cwd;
  return gitRoot(start) || start;
}

// The one variable the hook needs. The plugin directory's scan holds a plugin
// that hands the whole environment around.
function hookEnv() {
  return { CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR };
}

// ---------- capture ----------

function toolOf(name) {
  return name.startsWith('mcp__') ? 'mcp' : name;
}

function nameOf(payload) {
  const input = payload.tool_input || {};
  switch (payload.tool_name) {
    case 'Skill': return input.skill;
    case 'Agent': return input.subagent_type || DEFAULT_AGENT;
    case 'Bash': return firstLine(input.command || '').replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, '');
    default:
      return payload.tool_name.startsWith('mcp__') ? payload.tool_name.split('__').pop() : undefined;
  }
}

function argsOf(payload) {
  const input = payload.tool_input || {};
  switch (payload.tool_name) {
    case 'Skill': return input.args;
    case 'Agent': return [input.description, firstLine(input.prompt || '')].filter(Boolean).join(': ');
    case 'Bash': return input.command;
    case HANDBACK: return undefined;
    default: {
      const safe = {};
      for (const [key, value] of Object.entries(input)) safe[key] = SECRET_KEY.test(key) ? '[redacted]' : value;
      return Object.keys(safe).length ? JSON.stringify(safe) : undefined;
    }
  }
}

function responseText(response) {
  if (response == null) return '';
  if (typeof response === 'string') return response;
  if (typeof response.result === 'string') return response.result;
  if (Array.isArray(response.content)) {
    return response.content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('\n');
  }
  return [response.stdout, response.stderr].filter((s) => typeof s === 'string').join('\n');
}

// Claude Code may open a subagent's reply with the tools it used:
//   <tools-used-before-summary>Bash</tools-used-before-summary>\nS  => S
const TOOLS_USED = /^\s*<tools-used-before-summary>[\s\S]*?<\/tools-used-before-summary>/;

// Claude Code's reply to a call it started in the background:
//   Agent  {"status":"async_launched","agentId":"a1"}
//   Skill  {"status":"forked","background":true,"agentId":"a1","result":"Running in the background as @validator"}
function isBackground(response) {
  return Boolean(response) && (response.status === LAUNCHED || response.background === true);
}

// A background subagent reports to its caller with a SubagentHandback call:
//   tool_input     {"message":"Both verdicts are PASS.\n\n- **Implementation:** ..."}
//   tool_response  "Report delivered to your caller."
// The stop that follows has an empty last_assistant_message.
function resultOf(payload) {
  const response = payload.tool_response;
  if (payload.tool_name === HANDBACK) return firstLine((payload.tool_input || {}).message || '') || undefined;
  if (payload.tool_name === 'Skill' && !(response && response.agentId)) return undefined;
  if (isBackground(response)) return undefined;
  const text = firstLine(responseText(response).replace(TOOLS_USED, '')) || firstLine(payload.error || '');
  return text || undefined;
}

// How full the calling context was when the model asked for this call: the
// usage on the assistant message that holds the tool_use, read from the tail
// of Claude Code's transcript. A subagent writes its own transcript:
//   <session>.jsonl                          main
//   <session>/subagents/agent-<id>.jsonl     subagent <id>
// The transcript format is Claude Code's own and undocumented, so any miss
// leaves the field out.
function contextTokensOf(payload) {
  try {
    if (!payload.transcript_path || !payload.tool_use_id) return undefined;
    const file = payload.agent_id ? subagentTranscript(payload.transcript_path, payload.agent_id) : payload.transcript_path;
    const size = fs.statSync(file).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buffer, 0, length, size - length); } finally { fs.closeSync(fd); }
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].includes(payload.tool_use_id)) continue;
      const found = usageByToolUse(lines[i]).get(payload.tool_use_id);
      if (found !== undefined) return found;
    }
  } catch { /* no transcript, or not the format we know */ }
  return undefined;
}

// tool_use id -> context tokens, for one transcript line.
function usageByToolUse(line) {
  const found = new Map();
  let entry;
  try { entry = JSON.parse(line); } catch { return found; }
  const message = (entry && entry.message) || {};
  const usage = message.usage;
  if (!usage || !Array.isArray(message.content)) return found;
  const total = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  for (const c of message.content) if (c && c.type === 'tool_use' && c.id) found.set(c.id, total);
  return found;
}

function subagentTranscript(main, id) {
  return path.join(main.replace(/\.jsonl$/, ''), 'subagents', `agent-${id}.jsonl`);
}

// Every transcript a trace names: main's, recorded on SessionStart, and each
// subagent's next to it.
function transcriptFiles(records) {
  const files = [];
  for (const main of new Set(records.filter((r) => r.transcript).map((r) => r.transcript))) {
    files.push({ ctx: MAIN, file: main });
    const dir = path.join(main.replace(/\.jsonl$/, ''), 'subagents');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { /* no subagents */ }
    for (const f of names) {
      const id = /^agent-(.+)\.jsonl$/.exec(f);
      if (id) files.push({ ctx: id[1], file: path.join(dir, f) });
    }
  }
  return files;
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}

// An async hook can run before Claude Code flushes the transcript, so calls
// recorded without context_tokens get them from the transcripts at render time,
// if those files still exist.
function fillContextTokens(records) {
  const missing = records.filter((r) => r.tool && r.tool_use_id && r.context_tokens === undefined);
  if (!missing.length) return records;
  const found = new Map();
  for (const { file } of transcriptFiles(records)) {
    const text = readText(file);
    if (text === undefined) continue;
    for (const line of text.split('\n')) {
      if (line.includes('"tool_use"')) for (const [id, n] of usageByToolUse(line)) found.set(id, n);
    }
  }
  return records.map((r) => (r.tool && r.context_tokens === undefined && found.has(r.tool_use_id) ? { ...r, context_tokens: found.get(r.tool_use_id) } : r));
}

// What a context spent, summed over its model calls. Each call sends the whole
// history again: what the prompt cache already held is `cached`, the rest
// (plain input and cache writes) is `new`, and the reply is `out`. They cost
// different amounts, so they stay apart. One response can span several
// transcript lines with the same message id.
function spentTokens(text) {
  const seen = new Set();
  const spend = { new: 0, cached: 0, out: 0, calls: 0 };
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const message = entry && entry.type === 'assistant' && entry.message;
    if (!message || !message.usage) continue;
    if (message.id && seen.has(message.id)) continue;
    if (message.id) seen.add(message.id);
    const u = message.usage;
    spend.new += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    spend.cached += u.cache_read_input_tokens || 0;
    spend.out += u.output_tokens || 0;
    spend.calls += 1;
  }
  return spend.calls ? spend : undefined;
}

function spentByChild(payload, childId) {
  if (!payload.transcript_path || !childId) return undefined;
  const text = readText(subagentTranscript(payload.transcript_path, childId));
  return text === undefined ? undefined : spentTokens(text);
}

// context id -> { new, cached, out, calls }: from the transcripts while they exist,
// otherwise what capture recorded for each subagent.
function contextSpend(records) {
  const spend = new Map();
  for (const r of uniqueCalls(records)) {
    if (r.child_agent_id && r.child_spend) spend.set(r.child_agent_id, r.child_spend);
  }
  for (const stop of subagentStops(records).values()) {
    if (stop.spend) spend.set(stop.agent_id, stop.spend);
  }
  for (const { ctx, file } of transcriptFiles(records)) {
    const text = readText(file);
    const spent = text === undefined ? undefined : spentTokens(text);
    if (spent) spend.set(ctx, spent);
  }
  return spend;
}

// Record fields in schema order; absent values are left out.
function buildRecord(payload, harness, now = new Date()) {
  const response = payload.tool_response || {};
  const isParent = PARENT_TOOLS.includes(payload.tool_name);
  const name = nameOf(payload);
  const args = argsOf(payload);
  const result = resultOf(payload);
  const childId = isParent ? response.agentId : undefined;
  // A background subagent is still at work: its end, result and spend come with
  // its SubagentStop.
  const background = isBackground(response);
  const spent = background ? undefined : spentByChild(payload, childId);
  const input = payload.tool_input || {};
  const record = {
    v: SCHEMA_VERSION,
    harness,
    at: now.toISOString(),
    session: payload.session_id,
    agent_id: payload.agent_id,
    agent_type: payload.agent_type,
    tool_use_id: payload.tool_use_id,
    tool: toolOf(payload.tool_name),
    name: name && clip(mask(String(name)), NAME_LIMIT),
    duration_ms: payload.duration_ms,
    ok: payload.hook_event_name !== 'PostToolUseFailure',
    child_agent_id: childId,
    child_agent_type: childId ? response.agentType || (payload.tool_name === 'Agent' ? input.subagent_type : undefined) : undefined,
    background: background || undefined,
    child_spend: spent,
    tokens: typeof response.totalTokens === 'number' ? response.totalTokens : undefined,
    context_tokens: contextTokensOf(payload),
    branch: branchOf(payload.cwd || process.cwd()),
    args: args ? clip(mask(oneLine(typeof args === 'string' ? args : JSON.stringify(args))), ARGS_LIMIT) : undefined,
    result: result ? clip(mask(result), RESULT_LIMIT) : undefined,
  };
  return JSON.parse(JSON.stringify(record));
}

// `result`, then `args`, give way until the line fits.
function serialize(record) {
  let line = JSON.stringify(record);
  const fitted = { ...record };
  for (const key of ['result', 'args']) {
    while (Buffer.byteLength(line) > LINE_LIMIT && fitted[key]) {
      const shorter = Math.floor(fitted[key].length / 2);
      if (shorter < 1) delete fitted[key];
      else fitted[key] = clip(fitted[key], shorter);
      line = JSON.stringify(fitted);
    }
  }
  return line;
}

// Compaction and session starts are markers, not calls: no `tool`.
function buildEventRecord(payload, harness, now = new Date()) {
  const record = {
    v: SCHEMA_VERSION,
    harness,
    at: now.toISOString(),
    session: payload.session_id,
    agent_id: payload.agent_id,
    event: payload.hook_event_name,
    trigger: payload.trigger,
    source: payload.source,
    context_tokens: typeof payload.context_tokens === 'number' ? payload.context_tokens : undefined,
    transcript: payload.hook_event_name === 'SessionStart' ? payload.transcript_path : undefined,
  };
  if (payload.hook_event_name === 'SubagentStop') {
    const text = readText(payload.agent_transcript_path || '');
    const spent = text === undefined ? undefined : spentTokens(text);
    const result = firstLine(String(payload.last_assistant_message || '').replace(TOOLS_USED, ''));
    Object.assign(record, {
      agent_type: payload.agent_type || undefined,
      spend: spent,
      result: result ? clip(mask(result), RESULT_LIMIT) : undefined,
    });
  }
  return JSON.parse(JSON.stringify(record));
}

function sessionFile(dir, session) {
  return path.join(dir, TRACE_DIR, `${String(session).replace(/[^\w.-]/g, '_')}.jsonl`);
}

function capture(harness, input, env = hookEnv(), now = new Date()) {
  const payload = JSON.parse(input);
  const isTool = TOOL_EVENTS.includes(payload.hook_event_name);
  if (!CAPTURED_EVENTS.includes(payload.hook_event_name) || !payload.session_id || (isTool && !payload.tool_name)) return null;
  const dir = projectDir(payload.cwd || process.cwd(), env);
  const file = sessionFile(dir, payload.session_id);
  if (!fs.existsSync(path.dirname(file))) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    excludeTraces(dir);
  }
  // One small O_APPEND write per record keeps concurrent hooks from interleaving.
  const record = isTool ? buildRecord(payload, harness, now) : buildEventRecord(payload, harness, now);
  fs.appendFileSync(file, serialize(record) + '\n');
  return file;
}

// ---------- tree ----------

function readTrace(file) {
  const records = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* a torn line is skipped */ }
  }
  return records;
}

function startOf(record) {
  return Date.parse(record.at) - (record.duration_ms || 0);
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  const tenths = Math.round(ms / 100) / 10;
  return tenths < 10 ? `${tenths.toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

function formatCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}`;
}

function formatSpend(spend) {
  return [`${formatCount(spend.new)} new`, `${formatCount(spend.cached)} cached`, `${formatCount(spend.out)} out`];
}

function clock(ms) {
  return new Date(ms).toISOString().slice(11, 19);
}

// Plugin and committed hook on one machine record everything twice.
function uniqueCalls(records) {
  const seen = new Set();
  const stops = subagentStops(records);
  const handbacks = new Map(records.filter((r) => r.tool === HANDBACK && r.agent_id && r.result).map((r) => [r.agent_id, r.result]));
  return records.filter((record) => {
    if (!record.tool) return false;
    if (!record.tool_use_id) return true;
    if (seen.has(record.tool_use_id)) return false;
    seen.add(record.tool_use_id);
    return true;
  }).map((record) => withStop(record, stops.get(record.child_agent_id), handbacks.get(record.child_agent_id)));
}

// A background subagent stops each time it has nothing to do and is woken when
// a child of its own reports, so the last stop is the one that ends it:
//   22:13:31  "Waiting on reviewer."
//   22:13:44  "**PASS** ..."
function subagentStops(records) {
  const stops = new Map();
  for (const r of records) if (r.event === 'SubagentStop' && r.agent_id) stops.set(r.agent_id, { ...stops.get(r.agent_id), ...r });
  return stops;
}

// Traces captured before a background skill was told apart from a finished one
// hold Claude Code's launch notice as the call's result.
const LAUNCH_NOTICE = /^Running in the background as @/;

// A background subagent's call returns at once; it ends at its SubagentStop.
// Its result is what it handed back. A later notice can wake it once more,
// and that stop's message is a remark, not the report:
//   17:58:18  SubagentHandback  "Both verdicts are PASS."
//   17:58:21  SubagentStop      "The completion notice adds nothing new: ..."
// Until its first stop it is `running`: the duration recorded so far is the
// launch, about 25 ms, not the work.
function withStop(record, stop, handback) {
  const { result, ...launched } = record;
  const call = LAUNCH_NOTICE.test(result || '') ? { ...launched, background: true } : record;
  if (!stop) return call.background ? { ...call, running: true } : call;
  const merged = { ...call, child_agent_type: call.child_agent_type || stop.agent_type };
  if (!call.background) return merged;
  const start = startOf(call);
  return { ...merged, at: stop.at, duration_ms: Math.max(0, Date.parse(stop.at) - start), result: handback || call.result || stop.result };
}

function uniqueEvents(records) {
  const kept = [];
  for (const record of records) {
    if (record.tool || !record.event) continue;
    const at = Date.parse(record.at);
    const twin = kept.find((k) => k.event === record.event && k.agent_id === record.agent_id
      && k.trigger === record.trigger && k.source === record.source && Math.abs(Date.parse(k.at) - at) < DUPLICATE_EVENT_MS);
    if (!twin) kept.push(record);
  }
  return kept;
}

const TOOL_WORDS = { Skill: 'skill', Agent: 'agent' };

// The name leads and the kind follows: `review (skill)`, `counter (agent)`,
// `wc -l notes.txt (Bash)`.
function callLabel(tool, name) {
  const word = TOOL_WORDS[tool] || tool;
  return name ? `${name} (${word})` : word;
}

function contextOf(record) {
  return record.agent_id || MAIN;
}

function shortId(id) {
  return id === MAIN ? MAIN : id.slice(0, CONTEXT_WIDTH);
}

// A context is one conversation history: main, or a subagent started by a
// forked Skill or an Agent call. Inline skills and compactions are markers in
// one. A `fork` subagent starts with a copy of its parent's history; every
// other subagent starts with its prompt only.
function contextsOf(records) {
  const calls = uniqueCalls(records);
  const contexts = [{ id: MAIN, parent: undefined, kind: 'root', label: MAIN }];
  const known = new Set([MAIN]);
  for (const r of calls) {
    if (!r.child_agent_id || known.has(r.child_agent_id)) continue;
    known.add(r.child_agent_id);
    contexts.push({
      id: r.child_agent_id,
      parent: contextOf(r),
      kind: r.child_agent_type === COPY_AGENT_TYPE ? 'copy' : 'fresh',
      label: callLabel(r.tool, r.name),
      name: r.name,
      tool: r.tool,
      start: startOf(r),
      end: Date.parse(r.at),
    });
  }
  for (const r of calls) {
    const id = contextOf(r);
    if (known.has(id)) continue;
    known.add(id);
    contexts.push({ id, parent: undefined, kind: 'fresh', label: callLabel('Agent', r.agent_type || DEFAULT_AGENT), name: r.agent_type || DEFAULT_AGENT, tool: 'Agent' });
  }

  // Calls are recorded when they end, so order by start: a caller's lifeline
  // stays left of the contexts it starts. Unrecorded parents go last.
  const started = contexts.slice(1).sort((x, y) => (x.start ?? Infinity) - (y.start ?? Infinity));
  contexts.splice(1, started.length, ...started);

  // Color follows history: a copy keeps its parent's hue, a fresh context gets the next one.
  const hues = new Map();
  let nextHue = 0;
  for (const c of contexts) {
    c.hue = c.kind === 'copy' && hues.has(c.parent) ? hues.get(c.parent) : nextHue++;
    hues.set(c.id, c.hue);
  }

  const markers = calls
    .filter((r) => r.tool === 'Skill' && !r.child_agent_id)
    .map((r) => ({ kind: 'inline', ctx: contextOf(r), at: startOf(r), name: r.name }));
  let open;
  for (const e of uniqueEvents(records)) {
    if (e.event === 'PreCompact') {
      open = { kind: 'compact', ctx: contextOf(e), at: Date.parse(e.at), trigger: e.trigger };
      markers.push(open);
    } else if (e.event === 'PostCompact') {
      if (!open) markers.push({ kind: 'compact', ctx: contextOf(e), at: Date.parse(e.at), trigger: e.trigger });
      open = undefined;
    }
  }
  markers.sort((a, b) => a.at - b.at);
  return { contexts, markers };
}

function buildForest(records, markers = []) {
  const nodes = uniqueCalls(records).map((record, index) => ({ record, index, start: startOf(record), children: [] }));
  const byChild = new Map(nodes.filter((n) => n.record.child_agent_id).map((n) => [n.record.child_agent_id, n]));
  const placeholders = new Map();
  const roots = [];
  const containerOf = (agent, start, index, agentType) => {
    if (!agent) return roots;
    let parent = byChild.get(agent);
    if (!parent) {
      parent = placeholders.get(agent);
      if (!parent) {
        parent = { placeholder: true, agent, agentType, start, index, children: [] };
        placeholders.set(agent, parent);
        roots.push(parent);
      }
      parent.start = Math.min(parent.start, start);
    }
    return parent.children;
  };
  for (const node of nodes) containerOf(node.record.agent_id, node.start, node.index, node.record.agent_type).push(node);
  for (const marker of markers) {
    const ctx = marker.ctx === MAIN ? undefined : marker.ctx;
    containerOf(ctx, marker.at, Infinity).push({ marker, start: marker.at, index: Infinity, children: [] });
  }
  sortTree(roots);
  return roots;
}

function sortTree(nodes) {
  nodes.sort((a, b) => a.start - b.start || a.index - b.index);
  for (const node of nodes) sortTree(node.children);
}

function visible(node, verbose) {
  return verbose || node.placeholder || node.marker || PARENT_TOOLS.includes(node.record.tool);
}

// How the call relates to contexts: `inline` for a skill that ran in its
// caller's context, `new context <id>` for one that started a subagent, plus
// `copy of <parent>` when that subagent began with the caller's history.
function contextWords(record, kinds) {
  if (record.child_agent_id) {
    const words = [`new context ${shortId(record.child_agent_id)}`];
    if (kinds.get(record.child_agent_id) === 'copy') words.push(`copy of ${shortId(contextOf(record))}`);
    if (record.background) words.push('background');
    return words.join(', ');
  }
  return record.tool === 'Skill' ? 'inline' : '';
}

function detail(record, budget) {
  let args = record.args && record.args !== record.name ? record.args : undefined;
  let result = PARENT_TOOLS.includes(record.tool) || record.ok === false ? record.result : undefined;
  if (budget !== undefined) {
    args = args && clip(args, result ? Math.floor(budget / 2) : budget);
    result = result && clip(result, budget - (args ? args.length + 3 : 0) - 3);
  }
  return [args && `(${args})`, result && `-> ${result}`].filter(Boolean).join(' ');
}

function paint(text, ctx, colors) {
  const code = colors && colors.get(ctx);
  return code ? `\x1b[${code}m${text}\x1b[0m` : text;
}

const BAR_CELLS = 8;
// In the duration column of a background call that has not stopped yet.
const RUNNING = 'running';
const BAR_EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const BAR_STEPS = BAR_EIGHTHS.length;
const COLUMNS = [['time', 8, 'left'], ['duration', 8, 'right'], ['', BAR_CELLS, 'left'], ['new', 6, 'right'], ['cached', 7, 'right'], ['out', 6, 'right']];
const COLUMN_GAP = '  ';

function cell(text, [, width, align]) {
  return align === 'right' ? text.padStart(width) : text.padEnd(width);
}

function columns(values) {
  return COLUMNS.map((col, i) => cell(values[i] || '', col)).join(' ') + COLUMN_GAP;
}

// A square-root scale: the longest call fills the bar, a call a quarter as long
// fills half and one a hundredth as long a tenth, so short calls stay visible
// without hiding the long ones.
function durationBar(ms, longest) {
  if (!longest || !ms) return '';
  const steps = Math.round(Math.sqrt(Math.min(ms, longest) / longest) * BAR_CELLS * BAR_STEPS);
  return '█'.repeat(Math.floor(steps / BAR_STEPS)) + BAR_EIGHTHS[steps % BAR_STEPS];
}

function treeHeader() {
  return columns(COLUMNS.map(([name]) => name)) + 'call';
}

function formatLine(node, depth, { verbose, kinds, colors, spend, longest }) {
  const indent = '  '.repeat(depth);
  if (node.placeholder) {
    return columns([]) + paint(`${indent}${callLabel('Agent', node.agentType || DEFAULT_AGENT)} [${shortId(node.agent)}] parent not recorded`, node.agent, colors);
  }
  if (node.marker) {
    const m = node.marker;
    return columns([clock(m.at)]) + paint(`${indent}-- ${shortId(m.ctx)} compacted (${m.trigger || 'unknown trigger'})`, m.ctx, colors);
  }
  const r = node.record;
  const ctx = contextOf(r);
  const ms = r.running ? 0 : r.duration_ms || 0;
  const spent = r.child_agent_id && spend.get(r.child_agent_id);
  const prefix = columns([clock(node.start), r.running ? RUNNING : formatDuration(ms), durationBar(ms, longest), ...(spent ? [spent.new, spent.cached, spent.out].map(formatCount) : [])]);
  const words = [contextWords(r, kinds), r.ok === false ? 'failed' : ''].filter(Boolean).join(' ');
  const head = `${indent}${callLabel(r.tool, r.name)}`;
  const plainHead = words ? `${head} ${words}` : head;
  const budget = verbose ? undefined : TREE_WIDTH - prefix.length - plainHead.length - 2;
  const tail = detail(r, budget);
  const shownWords = words && r.child_agent_id ? words.replace(/^new context \S+/, (w) => paint(w, r.child_agent_id, colors)) : words;
  return prefix + [paint(head, ctx, colors), shownWords, tail].filter(Boolean).join(' ');
}

// Main keeps the terminal's own color, and so does a copy of main.
function ansiColors(contexts) {
  return new Map(contexts.filter((c) => c.hue > 0).map((c) => [c.id, ANSI_COLORS[(c.hue - 1) % ANSI_COLORS.length]]));
}

function renderTree(records, { verbose = false, color = false } = {}) {
  const { contexts, markers } = contextsOf(records);
  const options = { verbose, kinds: new Map(contexts.map((c) => [c.id, c.kind])), colors: color ? ansiColors(contexts) : undefined, spend: contextSpend(records) };
  const shown = [];
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      if (!visible(node, verbose)) continue;
      shown.push([node, depth]);
      walk(node.children, depth + 1);
    }
  };
  walk(buildForest(records, markers.filter((m) => m.kind === 'compact')), 0);
  options.longest = Math.max(0, ...shown.map(([node]) => (node.record && node.record.duration_ms) || 0));
  return [treeHeader(), ...shown.map(([node, depth]) => formatLine(node, depth, options))].join('\n');
}

// One self-contained page: the template from libexec/ with the trace inlined.
// `<` is escaped so tool output in the JSON can't close the script tag.
function renderHtml(session) {
  const calls = uniqueCalls(fillContextTokens(session.records));
  const { contexts, markers } = contextsOf(session.records);
  const spend = contextSpend(session.records);
  const data = {
    session: session.id,
    branch: (calls.find((r) => r.branch) || {}).branch,
    contexts: contexts.map((c) => ({ ...c, spent: spend.get(c.id) })),
    markers,
    calls: calls.map((r) => ({
      ctx: contextOf(r), tool: r.tool, name: r.name, start: startOf(r), dur: r.duration_ms || 0,
      ok: r.ok !== false, ctxTokens: r.context_tokens, args: r.args, result: r.result, child: r.child_agent_id, background: r.background, running: r.running,
    })),
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const template = fs.readFileSync(path.join(__dirname, VIEW_TEMPLATE), 'utf8');
  return template.replace(DATA_SLOT, () => json);
}

function listSessions(dir) {
  const traces = path.join(dir, TRACE_DIR);
  if (!fs.existsSync(traces)) return [];
  return fs.readdirSync(traces)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const records = readTrace(path.join(traces, f));
      const starts = records.map(startOf).filter(Number.isFinite);
      return { id: f.replace(/\.jsonl$/, ''), records, first: Math.min(...starts), last: Math.max(...records.map((r) => Date.parse(r.at)).filter(Number.isFinite)) };
    })
    .filter((s) => s.records.length);
}

const FORMATS = ['text', 'html'];
const VALUE_FLAGS = ['--branch', '--format'];

function parseTreeArgs(argv) {
  const options = { verbose: false, format: 'text' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--verbose' || arg === '-v') options.verbose = true;
    else if (VALUE_FLAGS.includes(arg)) options[arg.slice(2)] = argv[(i += 1)];
    else if (!arg.startsWith('-')) options.prefix = arg;
  }
  if (!FORMATS.includes(options.format)) throw new UsageError(`Unknown format ${options.format}; use ${FORMATS.join(' or ')}.`);
  return options;
}

function stamp(session) {
  return `${new Date(session.first).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

function tree(argv, dir, { color = false } = {}) {
  const { verbose, format, branch, prefix } = parseTreeArgs(argv);
  const sessions = listSessions(dir);
  if (!sessions.length) throw new UsageError(`No traces in ${path.join(dir, TRACE_DIR)}. Run a session with the hook installed first.`);

  let chosen;
  if (branch) {
    chosen = sessions.filter((s) => s.records.some((r) => r.branch === branch)).sort((a, b) => a.first - b.first);
    if (!chosen.length) throw new UsageError(`No session recorded on branch ${branch}.`);
  } else if (prefix) {
    chosen = sessions.filter((s) => s.id.startsWith(prefix));
    if (chosen.length !== 1) throw new UsageError(chosen.length ? `Session prefix ${prefix} is ambiguous.` : `No session starts with ${prefix}.`);
  } else {
    chosen = [sessions.reduce((a, b) => (b.last > a.last ? b : a))];
  }
  if (format === 'html') {
    if (chosen.length > 1) {
      const list = chosen.map((s) => `  ${s.id.slice(0, SESSION_WIDTH)}  ${stamp(s)}`).join('\n');
      throw new UsageError(`The html page shows one session. Pick one by id prefix:\n${list}`);
    }
    return renderHtml(chosen[0]);
  }
  if (!branch) return renderTree(chosen[0].records, { verbose, color });
  return chosen
    .map((s) => `# session ${s.id} (${stamp(s)})\n${renderTree(s.records, { verbose, color })}`)
    .join('\n\n');
}

// ---------- init ----------

function hookEntry() {
  return { matcher: '*', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_S, async: true }] };
}

const isOurCommand = (command) => command === HOOK_COMMAND || command === OLD_HOOK_COMMAND;
const isOurs = (entry) => (entry.hooks || []).some((h) => isOurCommand(h.command));

// Replaces an entry an older `init` wrote, so a re-run picks up new hook options.
function mergeHooks(settings) {
  const merged = { ...settings, hooks: { ...(settings.hooks || {}) } };
  for (const event of CAPTURED_EVENTS) {
    const entries = merged.hooks[event] || [];
    const at = entries.findIndex(isOurs);
    merged.hooks[event] = at < 0 ? [...entries, hookEntry()]
      : [...entries.slice(0, at), hookEntry(), ...entries.slice(at + 1).filter((e) => !isOurs(e))];
  }
  return merged;
}

function init(argv, cwd) {
  if (argv[0] !== 'claude') throw new UsageError('Usage: harness-profiler init claude');
  const repo = gitRoot(cwd);
  if (!repo) throw new UsageError('Run harness-profiler init inside a git repository.');
  const target = path.join(repo, HOOK_DIR);
  fs.mkdirSync(target, { recursive: true });
  for (const file of HOOK_FILES) fs.copyFileSync(path.join(__dirname, file), path.join(target, file));
  fs.chmodSync(path.join(target, LAUNCHER), 0o755);
  fs.rmSync(path.join(target, OLD_LAUNCHER), { force: true });
  // Cloud sessions don't install plugins, so the skill that shows the trace
  // goes into the repository's own skills.
  const skill = path.join(repo, '.claude', SHOW_SKILL);
  fs.mkdirSync(skill, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', SHOW_SKILL, 'SKILL.md'), path.join(skill, 'SKILL.md'));

  const settingsFile = path.join(repo, '.claude', 'settings.json');
  const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
  fs.writeFileSync(settingsFile, JSON.stringify(mergeHooks(settings), null, 2) + '\n');
  return [
    `Copied the hook to ${path.relative(repo, target)}/, registered it in .claude/settings.json, and added the show-profile skill.`,
    'Commit them; Claude Code on the web picks the hook up in the next session:',
    '  git add .claude/harness-profiler .claude/skills/show-profile .claude/settings.json',
  ].join('\n');
}

// ---------- doctor ----------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function hookSources(repo, home) {
  const sources = [];
  const installed = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'));
  if (installed && JSON.stringify(installed.plugins || installed).includes('harness-profiler')) sources.push('plugin');
  const settingsFiles = [
    ['committed hooks', path.join(repo, '.claude', 'settings.json')],
    ['local settings hooks', path.join(repo, '.claude', 'settings.local.json')],
    ['user settings hooks', path.join(home, '.claude', 'settings.json')],
  ];
  for (const [label, file] of settingsFiles) {
    const settings = readJson(file);
    if (settings && JSON.stringify(settings.hooks || {}).includes('harness-profiler/hp')) sources.push(label);
  }
  return sources;
}

// What a hook committed by an older `init` lacks: events added since, `async`,
// and the files as this copy has them.
function staleHook(repo) {
  const settings = readJson(path.join(repo, '.claude', 'settings.json'));
  const hooks = (settings && settings.hooks) || {};
  const ours = (event) => (hooks[event] || []).filter(isOurs).flatMap((e) => e.hooks.filter((h) => isOurCommand(h.command)));
  if (!CAPTURED_EVENTS.some((event) => ours(event).length)) return undefined;
  const missing = CAPTURED_EVENTS.filter((event) => !ours(event).length);
  const blocking = CAPTURED_EVENTS.some((event) => ours(event).some((h) => h.async !== true));
  const changed = HOOK_FILES.filter((file) => readText(path.join(repo, HOOK_DIR, file)) !== readText(path.join(__dirname, file)));
  const gaps = [missing.length && `misses ${missing.join(', ')}`, blocking && 'is not async', changed.length && `has another version of ${changed.join(', ')}`].filter(Boolean);
  return gaps.length ? gaps.join(' and ') : undefined;
}

function doctor(cwd, env = hookEnv(), home = os.homedir()) {
  const dir = projectDir(cwd, env);
  const sessions = listSessions(dir);
  const newest = sessions.length ? Math.max(...sessions.map((s) => s.last)) : undefined;
  const repo = gitRoot(cwd) || cwd;
  const sources = hookSources(repo, home);
  const stale = staleHook(repo);
  return [
    `node:    ${process.execPath} (${process.version})`,
    `traces:  ${path.join(dir, TRACE_DIR)}`,
    `hook:    ${sources.length ? sources.join(', ') : 'not installed (install the plugin, or run harness-profiler init claude)'}`,
    stale && `update:  the committed hook ${stale}; run harness-profiler init claude again and commit`,
    `newest:  ${newest ? new Date(newest).toISOString() : 'no calls recorded yet'}`,
  ].filter(Boolean).join('\n');
}

// ---------- entry point ----------

class UsageError extends Error {}

const USAGE = `Usage:
  harness-profiler tree [session-id-prefix] [--branch <name>] [--verbose] [--format text|html]
  harness-profiler init claude
  harness-profiler doctor
  harness-profiler capture <harness>  (run by the hook, not by hand)`;

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'capture') {
    // A profiler must never break or slow down the session it watches, so no error leaves capture.
    try { capture(rest[0] || 'unknown', readStdin()); } catch { /* see above */ }
    return 0;
  }
  try {
    switch (command) {
      case 'tree': {
        const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
        console.log(tree(rest, projectDir(process.cwd()), { color }));
        return 0;
      }
      case 'init': console.log(init(rest, process.cwd())); return 0;
      case 'doctor': console.log(doctor(process.cwd())); return 0;
      default: console.log(USAGE); return command ? 1 : 0;
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { fillContextTokens, contextSpend, spentTokens, buildRecord, buildEventRecord, capture, serialize, contextsOf, renderTree, renderHtml, buildForest, tree, mergeHooks, init, doctor, mask, HOOK_COMMAND, OLD_HOOK_COMMAND };
