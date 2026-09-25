/**
 * Nerd Font file icons + tree rendering (ported from pi-pretty).
 * Disable with PI_TOOL_PILLS_ICONS=off.
 *
 * AIDEV-NOTE: never emit \x1b[0m here — pi's tool Box paints row bg by
 * wrapping the whole line; a full reset kills it. Use fg-only (39m) and
 * bold-off (22m) resets, like pi's own theme helpers.
 */

import { basename, extname } from 'node:path'

const FR = '\x1b[39m' // fg reset (not \x1b[0m — see AIDEV-NOTE above)
const BR = '\x1b[22m' // bold off
export const FG_DIM = '\x1b[38;2;80;80;80m'
export const FG_RULE = '\x1b[38;2;220;220;220m'
export const FG_BLUE = '\x1b[38;2;100;140;220m'

const USE_ICONS =
  (process.env.PI_TOOL_PILLS_ICONS ?? 'nerd').toLowerCase() !== 'off'

const NF_DIR = `${FG_BLUE}\ue5ff${FR}`
const NF_DEFAULT = `${FG_DIM}\uf15b${FR}`

// AIDEV-NOTE: icon tables copied verbatim from pi-pretty config.ts
const EXT_ICON: Record<string, string> = {
  ts: `\x1b[38;2;49;120;198m\ue628${FR}`,
  tsx: `\x1b[38;2;49;120;198m\ue7ba${FR}`,
  js: `\x1b[38;2;241;224;90m\ue74e${FR}`,
  jsx: `\x1b[38;2;97;218;251m\ue7ba${FR}`,
  mjs: `\x1b[38;2;241;224;90m\ue74e${FR}`,
  cjs: `\x1b[38;2;241;224;90m\ue74e${FR}`,
  py: `\x1b[38;2;55;118;171m\ue73c${FR}`,
  rs: `\x1b[38;2;222;165;132m\ue7a8${FR}`,
  go: `\x1b[38;2;0;173;216m\ue724${FR}`,
  java: `\x1b[38;2;204;62;68m\ue738${FR}`,
  swift: `\x1b[38;2;255;172;77m\ue755${FR}`,
  rb: `\x1b[38;2;204;52;45m\ue739${FR}`,
  kt: `\x1b[38;2;126;103;200m\ue634${FR}`,
  c: `\x1b[38;2;85;154;211m\ue61e${FR}`,
  cpp: `\x1b[38;2;85;154;211m\ue61d${FR}`,
  cs: `\x1b[38;2;104;33;122m\ue648${FR}`,
  html: `\x1b[38;2;228;77;38m\ue736${FR}`,
  css: `\x1b[38;2;66;165;245m\ue749${FR}`,
  scss: `\x1b[38;2;207;100;154m\ue749${FR}`,
  vue: `\x1b[38;2;65;184;131m\ue6a0${FR}`,
  svelte: `\x1b[38;2;255;62;0m\ue697${FR}`,
  json: `\x1b[38;2;241;224;90m\ue60b${FR}`,
  yaml: `\x1b[38;2;160;116;196m\ue6a8${FR}`,
  yml: `\x1b[38;2;160;116;196m\ue6a8${FR}`,
  toml: `\x1b[38;2;160;116;196m\ue6b2${FR}`,
  xml: `\x1b[38;2;228;77;38m\ue619${FR}`,
  md: `\x1b[38;2;66;165;245m\ue73e${FR}`,
  mdx: `\x1b[38;2;66;165;245m\ue73e${FR}`,
  sql: `\x1b[38;2;218;218;218m\ue706${FR}`,
  sh: `\x1b[38;2;137;180;130m\ue795${FR}`,
  bash: `\x1b[38;2;137;180;130m\ue795${FR}`,
  zsh: `\x1b[38;2;137;180;130m\ue795${FR}`,
  lua: `\x1b[38;2;81;160;207m\ue620${FR}`,
  php: `\x1b[38;2;137;147;186m\ue73d${FR}`,
  dart: `\x1b[38;2;87;182;240m\ue798${FR}`,
  png: `\x1b[38;2;160;116;196m\uf1c5${FR}`,
  jpg: `\x1b[38;2;160;116;196m\uf1c5${FR}`,
  svg: `\x1b[38;2;255;180;50m\uf1c5${FR}`,
  webp: `\x1b[38;2;160;116;196m\uf1c5${FR}`,
  lock: `\x1b[38;2;130;130;130m\uf023${FR}`,
  env: `\x1b[38;2;241;224;90m\ue615${FR}`,
  graphql: `\x1b[38;2;224;51;144m\ue662${FR}`,
  dockerfile: `\x1b[38;2;56;152;236m\ue7b0${FR}`,
}

const NAME_ICON: Record<string, string> = {
  'package.json': `\x1b[38;2;137;180;130m\ue71e${FR}`,
  'package-lock.json': `\x1b[38;2;130;130;130m\ue71e${FR}`,
  'tsconfig.json': `\x1b[38;2;49;120;198m\ue628${FR}`,
  '.gitignore': `\x1b[38;2;222;165;132m\ue702${FR}`,
  '.env': `\x1b[38;2;241;224;90m\ue615${FR}`,
  dockerfile: `\x1b[38;2;56;152;236m\ue7b0${FR}`,
  makefile: `\x1b[38;2;130;130;130m\ue615${FR}`,
  'readme.md': `\x1b[38;2;66;165;245m\ue73e${FR}`,
  license: `\x1b[38;2;218;218;218m\ue60a${FR}`,
}

export function fileIcon(fp: string): string {
  if (!USE_ICONS) return ''
  const base = basename(fp).toLowerCase()
  if (NAME_ICON[base]) return `${NAME_ICON[base]} `
  const ext = extname(fp).slice(1).toLowerCase()
  if (EXT_ICON[ext]) return `${EXT_ICON[ext]} `
  return `${NF_DEFAULT} `
}

export function dirIcon(): string {
  if (!USE_ICONS) return ''
  return `${NF_DIR} `
}

/**
 * Render flat ls output (one entry per line, dirs end with '/') as a tree
 * with Nerd Font icons. Ported from pi-pretty renderTree.
 * `colorName` styles file names (pass theme.fg('toolOutput', …)).
 */
export function renderTree(
  text: string,
  colorName: (s: string) => string = (s) => s,
): string {
  const lines = text.trim().split('\n').filter(Boolean)
  if (!lines.length) return `${FG_DIM}(empty directory)${FR}`

  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const entry = lines[i].trim()
    const prefix = i === lines.length - 1 ? '└── ' : '├── '
    const isDir = entry.endsWith('/')
    const name = isDir ? entry.slice(0, -1) : entry
    const icon = isDir ? dirIcon() : fileIcon(name)
    const label = isDir ? `${FG_BLUE}\x1b[1m${name}${BR}${FR}` : colorName(name)
    out.push(`${FG_RULE}${prefix}${FR}${icon}${label}`)
  }
  return out.join('\n')
}

/** Prepend file icons to a plain list of paths (find results). */
export function iconizePaths(
  text: string,
  colorName: (s: string) => string = (s) => s,
): string {
  return text
    .split('\n')
    .map((l) => (l.trim() ? `${fileIcon(l.trim())}${colorName(l)}` : l))
    .join('\n')
}
