/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Alt+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 */

import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { Box, Text } from '@mariozechner/pi-tui'
import { Type } from '@sinclair/typebox'
import { createSubagentActivityRecorder } from './activity.ts'
import {
  type AskRecord,
  type AskReplyRecord,
  readAskRecord,
  readAskSidecar,
  readReplyRecord,
  removeAskRecord,
  removeReplyRecord,
  writeAskRecord,
  writeAskSidecar,
} from './asks.ts'
import { loadSubagentsConfig } from './config.ts'
import {
  type ControlAck,
  type ControlRecord,
  readControlRecord,
  writeAckSidecar,
} from './control.ts'
import { ensureSubagentsDataDir } from './dataroot.ts'
import { sendOwnerMessage } from './inbox.ts'
import {
  type ChildIdentity,
  inboxDir,
  listLivePeers,
  publishPresence,
  readInbox,
  removeInboxEntry,
  resolvePeer,
  sendPeerMessage,
} from './peers.ts'

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg?.role === 'assistant') {
        return msg.stopReason !== 'aborted'
      }
    }
  }

  return true
}

/** Pure pump decision: should this reply be delivered into this child? */
export type ReplyPumpDecision = 'idle' | 'identity_mismatch' | 'deliver'

export function decideReplyDelivery(params: {
  reply: AskReplyRecord | null
  record: AskRecord | null
  childId: string
  sessionFile: string
}): ReplyPumpDecision {
  if (!params.reply || !params.record) return 'idle'
  if (params.record.childId !== params.childId) return 'identity_mismatch'
  if (params.record.sessionFile !== params.sessionFile) {
    return 'identity_mismatch'
  }
  if (params.record.askId !== params.reply.askId) return 'identity_mismatch'
  return 'deliver'
}

export interface SubagentErrorInfo {
  errorMessage: string
  stopReason: 'error'
}

/**
 * Payload the auto-exit path should write to the `.exit` sidecar: `{type:'error'}`
 * when the turn ended with stopReason=error, `{type:'done'}` otherwise.
 *
 * AIDEV-NOTE: clean auto-exits previously wrote NO sidecar, so the parent's
 * only completion signal was scraping the pane's last 5 visible rows for the
 * `__SUBAGENT_DONE_` sentinel. The post-exit shell prompt (time report +
 * multi-line prompt, more when lines wrap) pushes the sentinel out of that
 * window and the parent never wakes. Always write the sidecar.
 */
export function exitSidecarPayload(
  messages: any[] | undefined,
):
  | { type: 'error'; errorMessage: string; stopReason: 'error' }
  | { type: 'done' } {
  const errorInfo = findLatestAssistantError(messages)
  if (errorInfo) return { type: 'error', ...errorInfo }
  return { type: 'done' }
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role !== 'assistant') continue
    if (msg.stopReason !== 'error') return null
    const raw =
      typeof msg.errorMessage === 'string' ? msg.errorMessage.trim() : ''
    return {
      errorMessage:
        raw ||
        'Subagent agent loop ended with stopReason=error (no errorMessage field).',
      stopReason: 'error',
    }
  }
  return null
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

/** stopReason of the latest assistant message, or null when none. */
export function findLastStopReason(messages: any[] | undefined): string | null {
  if (!messages) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role !== 'assistant') continue
    if (typeof msg.stopReason === 'string') return msg.stopReason
    return null
  }
  return null
}

/**
 * Pure ack decision for the parent→child interrupt handshake (PMR-DNPZ).
 *
 * AIDEV-NOTE: Escape is observed at the aborted turn boundary, not instantly —
 * pi aborts the in-flight agent turn, which surfaces here as `agent_end` with
 * `stopReason === 'aborted'`. That boundary is the earliest reliable signal
 * that the interrupt took effect, so the ack lands there. A child that exits
 * normally instead (the interrupt-raced-completion case) never acks; the
 * parent sees `.exit` and the request times out harmlessly.
 */
export function interruptAckPayload(
  stopReason: string | undefined,
  record: ControlRecord | null,
): ControlAck | null {
  if (stopReason !== 'aborted') return null
  if (!record || record.kind !== 'interrupt') return null
  return {
    requestId: record.requestId,
    accepted: true,
    code: 'idle',
    message: 'turn aborted by interrupt',
  }
}

/**
 * Pure one-shot intercept decision for threshold compaction (PMR-HVM8).
 *
 * AIDEV-NOTE: first threshold compaction on a gated child is cancelled so the
 * child can converge (finish up, call subagent_done) instead of being
 * summarized mid-flight. The SECOND threshold event must fall through to
 * native compaction — canceling forever would loop-block the child against
 * a context it can never shrink. Manual/emergency compaction is never
 * touched (the user or pi asked for summarization explicitly).
 */
export interface ThresholdInterceptDecision {
  cancel: boolean
  retire: boolean
}

export function decideThresholdIntercept(params: {
  reason: string
  enabled: boolean
  isChild: boolean
  interceptUsed: boolean
}): ThresholdInterceptDecision {
  if (!params.enabled || !params.isChild)
    return { cancel: false, retire: false }
  if (params.interceptUsed) return { cancel: false, retire: false }
  if (params.reason !== 'threshold') return { cancel: false, retire: false }
  return { cancel: true, retire: true }
}

const CONVERGE_GUIDANCE =
  'Context retirement: this subagent session hit its compaction threshold. ' +
  'Compaction was cancelled once so you can converge instead of being ' +
  'summarized mid-task. Wrap up NOW: finish (or safely abandon) whatever you ' +
  'are doing and call the subagent_done tool with your final summary. Do not ' +
  'start new work. If this session hits the threshold again, native ' +
  'compaction will proceed and this guidance will not repeat.'

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = []
  let denied: string[] = []
  let expanded = false

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? ''
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? ''
  const deniedToolsValue = process.env.PI_DENY_TOOLS
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === '1'
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  })

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      'subagent-tools',
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) =>
          theme.bg('toolSuccessBg', text),
        )

        const label = subagentAgent || subagentName
        const agentTag = label
          ? theme.bold(theme.fg('accent', `[${label}]`))
          : ''

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg('dim', ` — ${toolNames.length} available`)
          const hint = theme.fg('muted', '  (Alt+J to collapse)')

          const toolList = toolNames
            .map((name: string) => theme.fg('dim', name))
            .join(theme.fg('muted', ', '))

          let deniedLine = ''
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg('error', name))
              .join(theme.fg('muted', ', '))
            deniedLine = `\n${theme.fg('muted', 'denied: ')}${deniedList}`
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          )
          box.addChild(content)
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg('dim', ` — ${toolNames.length} tools`)
          const deniedInfo =
            denied.length > 0
              ? theme.fg('dim', ' · ') +
                theme.fg('error', `${denied.length} denied`)
              : ''
          const hint = theme.fg('muted', '  (Alt+J to expand)')

          const content = new Text(
            `${agentTag}${countInfo}${deniedInfo}${hint}`,
            0,
            0,
          )
          box.addChild(content)
        }

        return box
      },
      { placement: 'aboveEditor' },
    )
  }

  let userTookOver = false
  let agentStarted = false

  // Show widget + status bar on session start
  // AIDEV-NOTE: the ack correlates on the CURRENT control record's requestId;
  // if the parent already superseded it, this ack is discarded parent-side by
  // requestId correlation.
  function tryAckInterrupt(stopReason: string): void {
    const childId = process.env.PI_SUBAGENT_ID
    const sessionFile = process.env.PI_SUBAGENT_SESSION
    if (!childId || !sessionFile) return
    const record = readControlRecord(childId)
    const ack = interruptAckPayload(stopReason, record)
    if (ack) writeAckSidecar(sessionFile, ack)
  }

  // ── Mailbox pump (PMR-WXG0 phase 5) ──
  // Watches the parent-owned reply record for this child's pending ask and
  // delivers the answer into THIS session as a normal user turn.
  //
  // AIDEV-NOTE: at-least-once window — the reply record is only deleted AFTER
  // sendMessage succeeds and the ingestion ack is written. A pump failure (crash
  // before sendMessage, failed ack write) leaves the record in place so the next
  // pump tick (or a resumed session's first tick) re-delivers the same answer;
  // worst case the child sees the answer twice. Identity is revalidated on every
  // tick: the ask record must name THIS childId + sessionFile and the reply's
  // askId must match — a stale/superseded reply is never delivered.
  let pumpBusy = false

  function pumpReplies(): void {
    if (pumpBusy) return
    const childId = process.env.PI_SUBAGENT_ID
    const sessionFile = process.env.PI_SUBAGENT_SESSION
    if (!childId || !sessionFile) return
    pumpBusy = true
    try {
      const reply = readReplyRecord(childId)
      const record = readAskRecord(childId)
      if (
        decideReplyDelivery({ reply, record, childId, sessionFile }) !==
        'deliver'
      ) {
        return
      }
      if (!reply || !record) return // unreachable per decideReplyDelivery
      pi.sendMessage(
        {
          customType: 'subagent-answer',
          content:
            `The owner answered your question (${reply.askId}):\n\n` +
            reply.message,
          display: true,
          details: { askId: reply.askId },
        },
        { triggerTurn: true },
      )
      writeAckSidecar(sessionFile, {
        requestId: reply.askId,
        accepted: true,
        code: 'idle',
        message: 'answer ingested',
      })
      removeReplyRecord(childId)
      removeAskRecord(childId)
    } catch {
      // Durable record stays — the next tick re-delivers (see AIDEV-NOTE above).
    } finally {
      pumpBusy = false
    }
  }

  // Delivery cadence: 500ms pumpMailboxes interval (see AIDEV-NOTE below —
  // fs.watch was removed after it wedged child startup).
  // AIDEV-NOTE: no fs.watch here — a watcher whose listener runs the pump
  // during pi's startup wedges the event loop before the first turn (found
  // 2026-10-15 via integration repro: child pi spins at 100% CPU, never
  // creates its session file; watch+noop listener is fine, interval-only is
  // fine). Polling every 500ms is the documented delivery path and is
  // sufficient — fs.watch bought sub-second latency at the cost of a
  // startup-deadlock we never fully isolated. Do not re-add without a
  // startup regression test.
  function startReplyWatcher(): void {
    const childId = process.env.PI_SUBAGENT_ID
    if (!childId || !process.env.PI_SUBAGENT_SESSION) return
    try {
      ensureSubagentsDataDir('asks')
    } catch {
      // asks dir missing — the 500ms pump re-checks every tick anyway.
    }
  }

  const isChildSession = Boolean(
    process.env.PI_SUBAGENT_ID && process.env.PI_SUBAGENT_SESSION,
  )

  if (isChildSession) {
    startReplyWatcher()
    startPeerWatcher()
    const pumpInterval = setInterval(pumpMailboxes, 500)
    pumpInterval.unref()
  }

  // ── Context retirement, child side (PMR-HVM8) ──
  // AIDEV-NOTE: one-shot intercept — see decideThresholdIntercept. The hook
  // is only registered for gated children; non-child sessions and
  // contextRetirement.enabled=false never see it.
  const retirementEnabled =
    loadSubagentsConfig(process.cwd()).config.contextRetirement?.enabled ===
    true
  if (isChildSession && retirementEnabled) {
    let thresholdInterceptUsed = false
    pi.on('session_before_compact', (event) => {
      // pi's extension typings (0.65) omit `reason`; the runtime (0.84) always
      // passes it. Narrow structurally instead of bumping types.
      const reason = (event as { reason?: string }).reason ?? ''
      const decision = decideThresholdIntercept({
        reason,
        enabled: retirementEnabled,
        isChild: isChildSession,
        interceptUsed: thresholdInterceptUsed,
      })
      if (decision.retire) {
        thresholdInterceptUsed = true
        recorder.retiring()
        pi.sendMessage(
          {
            customType: 'subagent-converge',
            content: CONVERGE_GUIDANCE,
            display: true,
          },
          { triggerTurn: true },
        )
      }
      if (decision.cancel) return { cancel: true }
    })
  }

  // ── Peer inbox drain (PMR-98S6) ──
  // AIDEV-NOTE: at-least-once — an inbox entry is unlinked only AFTER its
  // sendMessage succeeds; a crash before that re-delivers the same peer
  // message next tick (duplicate turn worst case). Mirrors pumpReplies.
  let peerDrainBusy = false
  let releasePresence: (() => void) | null = null

  function childIdentity(): ChildIdentity | null {
    const childId = process.env.PI_SUBAGENT_ID
    const sessionFile = process.env.PI_SUBAGENT_SESSION
    if (!childId || !sessionFile) return null
    const identity: ChildIdentity = {
      childId,
      sessionFile,
      name: subagentName || childId,
      cwd: process.cwd(),
    }
    if (subagentAgent) identity.agent = subagentAgent
    return identity
  }

  function pumpInbox(): void {
    if (peerDrainBusy) return
    const identity = childIdentity()
    if (!identity) return
    peerDrainBusy = true
    try {
      for (const entry of readInbox(identity.childId)) {
        const from = entry.message.from
        const who = from.name || from.childId
        const details: Record<string, unknown> = {
          messageId: entry.message.messageId,
        }
        if (entry.message.resultRef !== undefined) {
          details.resultRef = entry.message.resultRef
        }
        pi.sendMessage(
          {
            customType: 'subagent-peer-message',
            content:
              `Peer message from ${who} (${from.childId}):\n\n` +
              entry.message.message,
            display: true,
            details,
          },
          { triggerTurn: true },
        )
        removeInboxEntry(entry.path)
      }
    } catch {
      // Entries stay durable — next tick re-delivers (see AIDEV-NOTE above).
    } finally {
      peerDrainBusy = false
    }
  }

  function pumpMailboxes(): void {
    pumpReplies()
    pumpInbox()
  }

  // AIDEV-NOTE: polling-only like startReplyWatcher (same startup-wedge
  // reason, see that note). Kept as a named function so the pump structure
  // stays symmetric.
  function startPeerWatcher(): void {
    const identity = childIdentity()
    if (!identity) return
    try {
      ensureSubagentsDataDir('peers')
    } catch {
      // peers dir missing — the 500ms pump re-checks every tick anyway.
    }
  }

  pi.registerTool({
    name: 'list_peers',
    label: 'List Peers',
    description:
      'List other live subagents you can message. Returns yourself plus every ' +
      'currently-running peer (dead/stale peers are filtered). Use childId or name ' +
      'as the `peer` argument of message_peer.',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const identity = childIdentity()
      if (!identity) {
        throw new Error(
          'list_peers is only available in subagent contexts. ' +
            'PI_SUBAGENT_ID/PI_SUBAGENT_SESSION environment variables are not set.',
        )
      }
      const peers = listLivePeers(identity)
      const lines: string[] = []
      for (const p of peers) {
        const agentTag = p.agent ? ` [${p.agent}]` : ''
        const selfMark = p.self ? ' (you)' : ''
        lines.push(`- ${p.name}${agentTag} childId=${p.childId}${selfMark}`)
      }
      let text = 'No live peers right now.'
      if (lines.length > 0) {
        text = `Live peers (including you):\n${lines.join('\n')}`
      }
      return {
        content: [{ type: 'text', text }],
        details: { peers },
      }
    },
  })

  pi.registerTool({
    name: 'message_peer',
    label: 'Message Peer',
    description:
      'Send a durable message to another live subagent WITHOUT blocking: the message is ' +
      'delivered to the peer as a new turn in ITS session and you keep working immediately. ' +
      'Resolve recipients with list_peers first. Max 8 KiB per message.',
    parameters: Type.Object({
      peer: Type.String({
        description: 'Recipient childId or name (from list_peers)',
      }),
      message: Type.String({ description: 'Message body' }),
      resultRef: Type.Optional(
        Type.String({
          description:
            'Optional result ref (result:<name>#<n>) to forward so the peer can load it',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const identity = childIdentity()
      if (!identity) {
        throw new Error(
          'message_peer is only available in subagent contexts. ' +
            'PI_SUBAGENT_ID/PI_SUBAGENT_SESSION environment variables are not set.',
        )
      }
      const target = resolvePeer(params.peer, identity)
      if (target.self) {
        throw new Error('Cannot message yourself — just continue working.')
      }
      const sent = sendPeerMessage({
        toChildId: target.childId,
        from: identity,
        message: params.message,
        resultRef: params.resultRef,
      })
      return {
        content: [
          {
            type: 'text',
            text: `Message delivered to ${target.name} (${target.childId}). You can keep working — the peer will pick it up as its next turn.`,
          },
        ],
        details: { messageId: sent.messageId, path: sent.path },
      }
    },
  })

  pi.on('session_start', (_event, ctx) => {
    recorder.sessionStart()
    // Publish peer presence (PMR-98S6): the record lives exactly as long as
    // our process-lock claim; release removes it on shutdown.
    const peerIdentity = childIdentity()
    if (peerIdentity && !releasePresence) {
      try {
        releasePresence = publishPresence(peerIdentity)
      } catch {
        // Presence is best-effort — list_peers just won't include us.
      }
    }
    const tools = pi.getAllTools()
    toolNames = tools.map((t) => t.name).sort()
    denied = parseDeniedTools(deniedToolsValue)

    renderWidget(ctx, null)
  })

  pi.on('input', () => {
    recorder.input()
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return
    userTookOver = true
  })

  pi.on('before_agent_start', () => {
    recorder.beforeAgentStart()
  })

  pi.on('agent_start', () => {
    agentStarted = true
    recorder.agentStart()
  })

  pi.on('agent_end', (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined

    // Request/ack handshake: if the parent just interrupted us, confirm via
    // the `.ack` sidecar. Best effort — the parent falls back to
    // fire-and-forget on timeout, so a failed ack write is never fatal.
    const lastStopReason = findLastStopReason(messages)
    if (lastStopReason) {
      tryAckInterrupt(lastStopReason)
    }

    const shouldExit =
      autoExit && shouldAutoExitOnAgentEnd(userTookOver, messages)

    if (shouldExit) {
      // Surface the exit via the `.exit` sidecar so the parent's pollForExit
      // fast path fires for clean completions too — not just errors or explicit
      // subagent_done calls. Without this the parent depends on the fragile
      // screen-sentinel scrape (see exitSidecarPayload note).
      const sessionFile = process.env.PI_SUBAGENT_SESSION
      if (sessionFile) {
        try {
          const payload = exitSidecarPayload(messages)
          // Never overwrite an existing sidecar — subagent_done/caller_ping may
          // have already written their own payload before shutdown.
          const exitFile = `${sessionFile}.exit`
          if (payload.type === 'error' || !existsSync(exitFile)) {
            writeFileSync(exitFile, JSON.stringify(payload))
          }
        } catch {
          // Best effort — even without the sidecar, watcher's session-file
          // fallback can still recover the errorMessage.
        }
      }

      recorder.agentEndDone()
      ctx.shutdown()
      return
    }

    recorder.agentEndWaiting()
    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest agent turn completed normally, not by who initiated it.
      userTookOver = false
    }
  })

  pi.on('turn_start', (event) => {
    recorder.turnStart((event as any).turnIndex)
  })

  pi.on('turn_end', (event) => {
    recorder.turnEnd((event as any).turnIndex)
  })

  pi.on('before_provider_request', () => {
    recorder.beforeProviderRequest()
  })

  pi.on('after_provider_response', () => {
    recorder.afterProviderResponse()
  })

  pi.on('message_update', (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type)
  })

  pi.on('tool_execution_start', (event) => {
    recorder.toolExecutionStart(
      (event as any).toolCallId,
      (event as any).toolName,
    )
  })

  pi.on('tool_call', (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName)
  })

  pi.on('tool_execution_update', (event) => {
    recorder.toolExecutionUpdate(
      (event as any).toolCallId,
      (event as any).toolName,
    )
  })

  pi.on('tool_result', (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName)
  })

  pi.on('tool_execution_end', (event) => {
    recorder.toolExecutionEnd(
      (event as any).toolCallId,
      (event as any).toolName,
    )
  })

  pi.on('session_shutdown', (event) => {
    recorder.sessionShutdown((event as any).reason)
    if (releasePresence) {
      try {
        releasePresence()
      } catch {}
      releasePresence = null
    }
  })

  // Toggle expand/collapse with Alt+J
  pi.registerShortcut('alt+j', {
    description: 'Toggle subagent tools widget',
    handler: (ctx) => {
      expanded = !expanded
      renderWidget(ctx, null)
    },
  })

  pi.registerTool({
    name: 'caller_ping',
    label: 'Caller Ping',
    description:
      'Send a help request to the parent agent and exit this session. ' +
      'The parent will be notified with your message and can resume this session with a response. ' +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: 'What you need help with' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION
      if (!sessionFile) {
        throw new Error(
          'caller_ping is only available in subagent contexts. ' +
            'PI_SUBAGENT_SESSION environment variable is not set.',
        )
      }

      recorder.callerPing()
      const exitData = {
        type: 'ping' as const,
        name: process.env.PI_SUBAGENT_NAME ?? 'subagent',
        message: params.message,
      }
      writeFileSync(`${sessionFile}.exit`, JSON.stringify(exitData))

      ctx.shutdown()
      return {
        content: [
          {
            type: 'text',
            text: 'Ping sent. Session will exit and parent will be notified.',
          },
        ],
        details: {},
      }
    },
  })

  pi.registerTool({
    name: 'ask_owner',
    label: 'Ask Owner',
    description:
      'Ask the parent agent a question WITHOUT ending this session. ' +
      'The parent is woken immediately with your question and its answer arrives as your next user message; you continue the same session afterwards. ' +
      'MUST be the only tool call in this turn and the last thing you do before ending the turn. ' +
      'Only one outstanding ask at a time. Use for genuine blockers (missing decisions, unclear requirements); for final completion use subagent_done instead.',
    parameters: Type.Object({
      question: Type.String({ description: 'What you need from the owner' }),
      files: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Relevant file paths, if any',
        }),
      ),
    }),
    // AIDEV-NOTE (PMR-WXG0): this extension is only loaded into Pi-backed
    // children, so Claude-CLI children can never call ask_owner — for them the
    // tool simply does not exist (their "unsupported" signal is the absent
    // tool; they finish with subagent_done semantics instead).
    // The sole+final rule is conveyed via description + the returned guidance
    // text; herdsman's harder eligibility gates do not transfer (multi-turn
    // resumable children).
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const childId = process.env.PI_SUBAGENT_ID
      const sessionFile = process.env.PI_SUBAGENT_SESSION
      if (!childId || !sessionFile) {
        throw new Error(
          'ask_owner is only available in subagent contexts. ' +
            'PI_SUBAGENT_ID/PI_SUBAGENT_SESSION environment variables are not set.',
        )
      }

      // One outstanding ask per child — fail closed on a second call.
      const pending = readAskSidecar(sessionFile)
      if (pending || readAskRecord(childId)) {
        throw new Error(
          "You already have an outstanding ask. Wait for the owner's answer " +
            '(it arrives as your next user message) before asking again.',
        )
      }

      const askId = randomUUID()
      const record = {
        askId,
        childId,
        name: process.env.PI_SUBAGENT_NAME,
        question: params.question,
        files: params.files,
        sessionFile,
        createdAt: new Date().toISOString(),
      }
      // Durable first, sidecar second: the parent's poller keys on the
      // sidecar, so it can only observe a fully-written record.
      writeAskRecord(record)
      writeAskSidecar(sessionFile, askId)
      recorder.blockedAsking()

      return {
        content: [
          {
            type: 'text',
            text:
              'Question delivered to the owner. End your turn NOW — do not ' +
              'call any other tool. The answer will arrive as your next user ' +
              'message and you continue this same session afterwards.',
          },
        ],
        details: { askId },
      }
    },
  })

  pi.registerTool({
    // AIDEV-NOTE (PMR-QCVA): like ask_owner, this extension is only loaded
    // into Pi-backed children — Claude-CLI children never see message_owner
    // (absent tool is their unsupported signal). Fire-and-forget: the tool
    // writes a durable record and returns immediately; the parent drains it
    // on its 1s status loop. Never call ctx.shutdown or end the turn.
    name: 'message_owner',
    label: 'Message Owner',
    description:
      'Send a durable message to the parent agent WITHOUT blocking and WITHOUT ' +
      'ending the session: you keep working immediately and the parent picks it ' +
      'up on its next refresh tick. Use for progress updates, findings, or ' +
      'coordination that must not interrupt your run; for genuine blockers use ' +
      'ask_owner, for final completion use subagent_done. Max 8 KiB per message.',
    parameters: Type.Object({
      message: Type.String({ description: 'Message body' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const childId = process.env.PI_SUBAGENT_ID
      const parentSessionId = process.env.PI_SUBAGENT_PARENT_SESSION
      if (!childId || !parentSessionId) {
        throw new Error(
          'message_owner is only available in subagent contexts. ' +
            'PI_SUBAGENT_ID/PI_SUBAGENT_PARENT_SESSION environment variables are not set.',
        )
      }
      const sent = sendOwnerMessage({
        parentSessionId,
        childId,
        name: subagentName || childId,
        message: params.message,
      })
      return {
        content: [
          {
            type: 'text',
            text: 'Message delivered to the owner. Keep working — no response is expected; the owner reads it on its next refresh tick.',
          },
        ],
        details: { messageId: sent.messageId, path: sent.path },
      }
    },
  })

  pi.registerTool({
    name: 'subagent_done',
    label: 'Subagent Done',
    description:
      'Call this tool when you have completed your task. ' +
      'It will close this session and return your results to the main session. ' +
      'Your LAST assistant message before calling this becomes the summary returned to the caller.',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION
      recorder.subagentDone()
      if (sessionFile) {
        writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: 'done' }))
      }
      ctx.shutdown()
      return {
        content: [{ type: 'text', text: 'Shutting down subagent session.' }],
        details: {},
      }
    },
  })
}
