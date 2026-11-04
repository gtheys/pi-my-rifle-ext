import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildDeviationGateSection,
  buildValidatePrompt,
} from '../validate/prompt.ts'

const HEADING = 'Deviation gate'

describe('buildDeviationGateSection: spec-source variants', () => {
  it('work mode: resolves spec file via resolve_spec_path + acli Jira text', () => {
    const section = buildDeviationGateSection('work', 'DP-123', false)
    assert.match(section, /resolve_spec_path/)
    assert.match(section, /acli/)
    assert.match(section, /DP-123/)
  })

  it('personal planned: reads plan.md via plan-path metadata from aven show --full', () => {
    const section = buildDeviationGateSection('personal', 'PMR-XXXX', false)
    assert.match(section, /plan-path/)
    assert.match(section, /aven show PMR-XXXX --full/)
    assert.match(section, /plan\.md/)
    // never trust show --json metadata on aven 0.1.39
    assert.match(section, /--json/)
  })

  it('personal oneshot: spec is the ticket description', () => {
    const section = buildDeviationGateSection('personal', 'PMR-YYYY', true)
    assert.match(section, /ticket description/)
    assert.match(section, /PMR-YYYY/)
  })

  it('personal planned: missing plan-path metadata fails closed', () => {
    const section = buildDeviationGateSection('personal', 'PMR-ZZZZ', false)
    assert.match(section, /STOP/)
    assert.match(section, /never invent/)
  })
})

describe('buildValidatePrompt: deviation gate wiring', () => {
  it('work prompt contains the deviation gate section', () => {
    const prompt = buildValidatePrompt({
      mode: 'work',
      ref: 'DP-9',
      scriptsDir: '/scripts',
    })
    assert.ok(prompt.includes(HEADING))
    assert.match(prompt, /resolve_spec_path/)
  })

  it('personal prompt contains the deviation gate section', () => {
    const prompt = buildValidatePrompt({
      mode: 'personal',
      ref: 'PMR-A1',
      scriptsDir: null,
    })
    assert.ok(prompt.includes(HEADING))
    assert.match(prompt, /plan-path/)
  })

  it('gate ordering: deviation gate runs after 0-blocker review, before flow_phase_complete', () => {
    const prompt = buildValidatePrompt({
      mode: 'work',
      ref: 'DP-9',
      scriptsDir: '/s',
    })
    const gateIdx = prompt.indexOf(HEADING)
    const reviewIdx = prompt.indexOf('blockers_count is 0')
    const phaseIdx = prompt.indexOf('flow_phase_complete', reviewIdx)
    assert.ok(gateIdx > reviewIdx, 'deviation gate after review gate')
    assert.ok(
      prompt.indexOf('BEFORE', gateIdx) !== -1,
      'deviation gate states it runs before the phase-complete call',
    )
    void phaseIdx
  })

  it('both prompts: fail-closed artifact parsing wording present', () => {
    for (const prompt of [
      buildValidatePrompt({ mode: 'work', ref: 'DP-1', scriptsDir: null }),
      buildValidatePrompt({
        mode: 'personal',
        ref: 'PMR-B2',
        scriptsDir: null,
      }),
    ]) {
      // PMR-R9EN: D3/D4 now name the deviation_review tool (a registered
      // tool the agent can actually call), not TS functions.
      assert.match(
        prompt,
        /ERROR tool result[\s\S]*means re-run deviation_review/,
      )
      assert.match(prompt, /deviation_review/)
      assert.match(prompt, /decideDeviationRoute/)
      assert.match(prompt, /call the deviation_review tool/)
    }
  })

  it('both prompts: 0 deviations records the aven note and proceeds', () => {
    for (const prompt of [
      buildValidatePrompt({ mode: 'work', ref: 'DP-1', scriptsDir: null }),
      buildValidatePrompt({
        mode: 'personal',
        ref: 'PMR-B2',
        scriptsDir: null,
      }),
    ]) {
      assert.match(prompt, /no deviation from spec/)
    }
  })

  it('both prompts: >0 deviations routes through ask_user_question with accept/fix', () => {
    for (const prompt of [
      buildValidatePrompt({ mode: 'work', ref: 'DP-1', scriptsDir: null }),
      buildValidatePrompt({
        mode: 'personal',
        ref: 'PMR-B2',
        scriptsDir: null,
      }),
    ]) {
      assert.match(prompt, /ask_user_question/)
      assert.match(prompt, /"accept"/)
      assert.match(prompt, /"fix"/)
      assert.match(prompt, /\/implement DP-1|\/implement PMR-B2/)
    }
  })

  it('both prompts: human decision recorded as an aven note either way', () => {
    for (const prompt of [
      buildValidatePrompt({ mode: 'work', ref: 'DP-1', scriptsDir: null }),
      buildValidatePrompt({
        mode: 'personal',
        ref: 'PMR-B2',
        scriptsDir: null,
      }),
    ]) {
      assert.match(prompt, /Record the human decision as an aven note/)
    }
  })
})
