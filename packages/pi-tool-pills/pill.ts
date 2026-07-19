/**
 * Shared pill badge renderer for tool headers.
 *
 * Produces an inverted-colour badge like ` write ` using theme semantic roles.
 */
import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent'

/** Map tool name → theme semantic colour role for the pill badge. */
const TOOL_ROLES: Partial<Record<string, ThemeColor>> = {
  ls: 'success',
  read: 'success',
  find: 'mdCode',
  grep: 'mdCode',
  bash: 'error',
  write: 'accent',
  create: 'accent',
  edit: 'warning',
}

/** Render an inverted-colour pill badge: ` name ` */
export function pill(name: string, theme: Theme): string {
  const role: ThemeColor = TOOL_ROLES[name] ?? 'dim'
  return theme.bold(theme.inverse(theme.fg(role, ` ${name} `)))
}
