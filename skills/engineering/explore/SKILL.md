---
name: explore
description: Pre-ticket codebase exploration — ask questions about the codebase via chat before creating an aven ticket. Uses direct search for quick questions, scout subagents for broad mapping, and hindsight/cognee memory for past decisions and "why" questions. Ends with understanding, or an exit ramp to a oneshot ticket or a feature plan. Trigger on "explore", "help me understand the codebase", "questions before creating a ticket", "how does X work in this repo", "I want to understand X before ticketing it".
---

# Explore (pre-ticket)

Understand first, ticket second. **No aven state is touched** until the user
explicitly picks an exit ramp. The conversation is the artifact.

## Flow

Match the tool to the question size:

1. **Quick, pointed questions** ("where is config parsed", "what calls X") →
   answer directly with `fast_context_search`, `grep`, `read`. Cite
   file:line. Don't spawn agents for what one search answers.
2. **Broad mapping** ("how does the auth flow work end to end", "what would
   adding Y touch") → spawn read-only `scout` subagent(s), parallel OK:

   ```
   subagent({
     name: "scout: <area>",
     agent: "scout",
     task: "Exploration question: <question>\n\nMap the area: file structure, key modules, data/control flow, conventions. The goal is answering the question with file:line evidence, not planning a change.",
   })
   ```

   End your turn after spawning; wait for the `subagent_result` steer.
3. **"Why" questions / past decisions** ("why is it built like this", "didn't
   we already try X") → `hindsight_search_knowledge_pages` first;
   `hindsight_reflect` when pages are too shallow and you need the decided
   rule. `cognee_recall` for SalaryHero specs. Credit memory visibly when it
   informs an answer.

Iterate as long as the user has questions. Correcting a wrong memory →
`hindsight_ingest_document` with a "Correction: <topic>" document.

## Exit ramps (user picks)

### "create ticket" — oneshot-sized

Draft a description that stands alone — what, why, done-when, plus the
file:line pointers gathered during exploration (this is what makes the
oneshot path work later; a vague ticket fails its sanity check):

```bash
aven add "<title, sentence case>" --status todo --description-stdin <<'EOF'
<context and pointers>
EOF
```

Report the created ref. Route to `implement-plan-aven`'s oneshot path when
the user wants it built.

### "plan it" — needs the full lifecycle

Create the ticket the same way, then preserve the exploration so stage 1
doesn't redo it:

```bash
aven note <REF> --stdin <<'EOF'
Exploration findings: <summary with file:line pointers>
EOF
```

Route to `feature-plan-aven` stage 1 — the note feeds the scout/interview.

### Nothing

Understanding was the goal. Stop. No ticket, no state, no notes.

## Boundaries

- **Read-only** — no code changes, no refactors "while we're here".
- **No aven mutations** until the user picks an exit ramp.
- Jira-linked exploration → same flow, but ticket creation routes to Jira,
  not aven.
