#!/usr/bin/env node
// AIDEV-NOTE: mermaid lint for markdown docs. GitHub renders ```mermaid blocks with
// mermaid's own parser. Four constructs break that render with a
// "Parse error ... got 'INVALID'" box that no markdown linter and no Biome check
// ever sees:
//   1. state-id — a stateDiagram state ID containing a hyphen. The lifecycle labels
//      are `planned` / `active` / `review-passed` / `done`, and `review-passed` is
//      not a valid mermaid ID, so `active --> review-passed` broke both §4.1
//      diagrams in docs/piv-flow-personal.md and docs/piv-flow-work.md;
//   2. state-br — `<br/>` inside a stateDiagram line (fine in flowchart and
//      sequence labels, invalid in state diagrams);
//   3. html-label — a raw `<something>` in any label. The renderer reads it as an
//      HTML tag, so `"flow halted at <phase>"` silently drops text;
//   4. subgraph-parens — `subgraph Name (detail)`; the `(` parses as node-shape
//      syntax. Use `subgraph id["title"]`.
// All four are silent at write time: the markdown is valid, only the rendered page
// shows an error box. This script fails the commit instead.
//
// Scope: a deterministic token lint, not a mermaid parser. It reports known-bad
// constructs only — no style opinions, no layout advice.
//
// Run: `bun run check:mermaid` (all tracked .md) or
//      `bun run check-mermaid -- <file...>` from lefthook pre-commit.
// Exit 1 on any finding.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Tags mermaid's htmlLabels actually support (closing forms allowed too).
const ALLOWED_TAGS = new Set([
  "br",
  "b",
  "i",
  "u",
  "s",
  "a",
  "p",
  "div",
  "span",
  "small",
  "sub",
  "sup",
  "code",
  "pre",
  "center",
  "font",
  "img",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "text",
  "tspan",
]);

// stateDiagram line-leading keywords that are not state IDs.
const STATE_KEYWORDS = new Set([
  "direction",
  "state",
  "note",
  "end",
  "hide",
  "empty",
  "states",
  "classDef",
  "class",
  "style",
  "click",
  "accTitle",
  "accDescr",
  "linkStyle",
]);

const VALID_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Arrow forms that connect states/nodes in the diagram types we lint.
const ARROW = "(?:-->|--->|---|-\\.->|==>|<-->|<->|--|-\\|-)";

/**
 * Every ```mermaid block in a file: its body lines plus the 1-based line number of
 * the first body line (`start`).
 */
function mermaidBlocks(source) {
  const lines = source.split("\n");
  const blocks = [];
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trimStart().startsWith("```")) {
      if (current !== null) current.lines.push(line);
      continue;
    }
    const lang = line.trim().slice(3).trim();
    if (current === null) {
      if (lang === "mermaid") current = { start: i + 2, lines: [] };
      continue;
    }
    if (lang === "") {
      blocks.push(current);
      current = null;
      continue;
    }
    // A named fence opens while a block is still open: the open block never closed.
    blocks.push(current);
    current = null;
    if (lang === "mermaid") current = { start: i + 2, lines: [] };
  }
  if (current !== null) blocks.push(current);
  return blocks;
}

/** Strip the transition/description label so only structure remains for ID checks. */
function structureOf(line) {
  const idx = line.indexOf(":");
  if (idx === -1) return line;
  // A colon inside a quoted label is not a label separator.
  const before = line.slice(0, idx);
  const quotes = (before.match(/"/g) || []).length;
  if (quotes % 2 !== 0) return line;
  return before;
}

/** State/node identifiers that appear as arrow endpoints in a line. */
function arrowEndpoints(structure) {
  const ids = [];
  const pattern = new RegExp(
    `([A-Za-z_][A-Za-z0-9_]*|\\[\\*\\])\\s*(?:${ARROW})`,
    "g",
  );
  for (const m of structure.matchAll(pattern)) ids.push(m[1]);
  const tail = new RegExp(`(?:${ARROW})\\s*(\\[\\*\\]|[A-Za-z_][A-Za-z0-9_]*)`, "g");
  for (const m of structure.matchAll(tail)) ids.push(m[1]);
  return ids;
}

/**
 * Every endpoint token of a stateDiagram transition, WHOLE.
 *
 * AIDEV-NOTE: this must not reuse arrowEndpoints: that extractor matches a valid
 * ID prefix, so on `active --> review-passed` it returns `review` and never sees the
 * hyphen — the exact lexer break rule 1 exists to catch. Splitting on the arrow
 * keeps each side intact, so `review-passed` arrives as one token and fails VALID_ID.
 */
function stateSides(structure) {
  if (!/--/.test(structure)) return null;
  // Longest arrow first: `-->` is two hyphens plus '>', so a `-{2,}` + `->?`
  // pattern cannot match it (it needs a third hyphen) and silently returns the
  // whole line as one side — which made rule 1 a no-op.
  return structure
    .split(/(?:<-->|-\.->|-{2,}>|-{3,}|-{2,}|==>|<-|->)/)
    .map((side) => side.trim())
    .filter((side) => side !== "");
}

/** Identifiers declared somewhere in the block, for the dangling-style check. */
function declaredIds(body) {
  const ids = new Set();
  for (const raw of body) {
    const line = raw.trim();
    if (line === "") continue;
    for (const m of line.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*[\[{(]/g)) {
      ids.add(m[1]);
    }
    for (const m of line.matchAll(/\bas\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
      ids.add(m[1]);
    }
    for (const id of arrowEndpoints(structureOf(line))) {
      ids.add(id);
    }
    const solo = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (solo !== null) ids.add(solo[1]);
    const sub = line.match(/^subgraph\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s|$|\[)/);
    if (sub !== null) ids.add(sub[1]);
  }
  return ids;
}

/**
 * stateDiagram-only checks for one line: `<br/>` support and hyphenated state IDs.
 * Kept out of lintMarkdown so the ID extraction stays testable on its own.
 */
function lintStateDiagramLine(at, line) {
  const findings = [];
  if (/<br\s*\/?>/i.test(line)) {
    findings.push(
      `${at} state-br: stateDiagram does not support <br/> — split the clause or drop it`,
    );
  }
  const structure = structureOf(line);
  const sides = stateSides(structure);
  const candidates = [];
  if (sides !== null) {
    for (const side of sides) {
      const aliased = side.match(/\bas\s+(\S+)$/);
      if (aliased !== null) {
        candidates.push(aliased[1]);
        continue;
      }
      // `state "desc" as S` and `hide empty description` are not endpoints.
      if (/^(state|hide|note|direction|class|style|click|acc)/.test(side)) continue;
      const tokens = side.split(/\s+/);
      if (tokens.length > 1) continue; // not a bare ID
      candidates.push(tokens[0]);
    }
  } else {
    const solo = structure.match(/^(\S+)\s*:/);
    if (solo !== null) candidates.push(solo[1]);
  }
  for (const candidate of candidates) {
    if (candidate === "[*]" || candidate === "[**]") continue;
    if (STATE_KEYWORDS.has(candidate)) continue;
    if (!VALID_ID.test(candidate)) {
      findings.push(
        `${at} state-id: '${candidate}' is not a valid mermaid state ID — IDs reject '-' and '.'; name the state after the PHASE and keep the label in the transition text`,
      );
    }
  }
  return findings;
}

/** Lint one file. Returns human-readable "path:line rule: message" findings. */
export function lintMarkdown(path, source) {
  const findings = [];
  for (const block of mermaidBlocks(source)) {
    if (block.lines.length === 0) {
      findings.push(`${path}:${block.start} empty-block: a mermaid fence with no body`);
      continue;
    }
    const head = block.lines[0].trim();
    const isStateDiagram = head.startsWith("stateDiagram");
    const ids = declaredIds(block.lines);
    block.lines.forEach((raw, index) => {
      const line = raw.trim();
      const at = `${path}:${block.start + index}`;
      if (line === "" || line.startsWith("%%")) return;

      for (const m of line.matchAll(/<\s*(\/?)([A-Za-z][A-Za-z0-9]*)/g)) {
        const tag = m[2].toLowerCase();
        if (!ALLOWED_TAGS.has(tag)) {
          findings.push(
            `${at} html-label: '<${tag}' is not a supported label tag — the renderer parses it as HTML, so write the placeholder in words or escape it with &lt;...&gt;`,
          );
        }
      }

      if (isStateDiagram) findings.push(...lintStateDiagramLine(at, line));

      const sub = line.match(/^subgraph\s+(.+)$/);
      if (sub !== null && !sub[1].includes("[") && /[()]/.test(sub[1])) {
        findings.push(
          `${at} subgraph-parens: 'subgraph ${sub[1].trim()}' — '(' parses as node-shape syntax; write subgraph id["title"]`,
        );
      }

      const styled = line.match(/^(?:style|class)\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (styled !== null && !ids.has(styled[1])) {
        findings.push(
          `${at} dangling-style: '${styled[1]}' is styled but no node with that id is declared in this block`,
        );
      }
    });
  }
  const fences = (source.match(/^```/gm) || []).length;
  if (fences % 2 !== 0) {
    findings.push(`${path}:0 unbalanced-fences: ${fences} \`\`\` fences (odd count)`);
  }
  return findings;
}

function trackedMarkdownFiles() {
  const out = execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
    encoding: "utf8",
  });
  return new Set(out.split("\0").filter((f) => f !== ""));
}

function main(argv) {
  // Explicit paths are linted as given (lefthook's glob already restricts to *.md);
  // with no args, every tracked .md is linted.
  const targets = argv.length > 0 ? argv : [...trackedMarkdownFiles()];
  const findings = [];
  for (const file of targets) {
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    findings.push(...lintMarkdown(file, source));
  }
  if (findings.length > 0) {
    console.error(`check-mermaid: ${findings.length} finding(s)`);
    for (const f of findings) console.error(`  ${f}`);
    console.error(
      "\nRules: state-id, state-br, html-label, subgraph-parens, dangling-style, " +
        "unbalanced-fences, empty-block.\nDocs: https://mermaid.js.org/syntax/stateDiagram.html",
    );
    return 1;
  }
  console.log(`check-mermaid: ok — ${targets.length} markdown file(s) linted`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
