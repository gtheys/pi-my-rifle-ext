---
name: feature-ticket
description: >-
  Use this skill whenever the user describes a feature, change, or improvement
  they want to build in one of their personal projects — e.g. "I want to add
  save functionality to my app", "let's add dark mode", "implement X", "build a
  feature that does Y", or "I need to refactor Z". The skill interviews the user
  to flesh out a vague idea into enough detail to actually implement, then
  records it as a Taskwarrior ticket. Trigger it even when the user doesn't
  mention Taskwarrior or the word "ticket" — any "I want to add/build/implement
  ..." for one of their projects is the cue.
---

# Feature → Taskwarrior Ticket

Turn a one-line feature idea into a ticket that's detailed enough to start
coding. The user gives a short prompt ("add save functionality"); your job is to
ask the few questions that close the gap between that idea and an
implementable plan, then write it into Taskwarrior.

Keep it tight. Ask only what you genuinely can't infer. The goal is a ticket
the user (or you, later) can pick up cold and build — not a spec document.

## Workflow

1. **Ground yourself in the project.** Look for and skim `README.md`,
   `CLAUDE.md`/`AGENTS.md`, and the source files the feature would touch. Most
   answers (language, stack, conventions, where things live) are already there —
   don't ask for what the repo already tells you.

2. **Interview — one focused round.** Ask the questions needed to make the
   feature buildable, grouped into a single message (don't drip them one at a
   time). Aim for 3–6, tailored to the feature. Always offer an out:
   "...or say 'use your judgment' and I'll pick sensible defaults." If the user
   defers, make reasonable choices and mark them as assumptions in the ticket.

   Cover whichever of these actually matter for this feature:
   - **Behavior** — what exactly happens? The core interaction.
   - **Data / scope** — what data or part of the app is involved?
   - **Trigger / UX** — how is it invoked, what does the user see?
   - **Constraints** — existing patterns to follow, deps to use or avoid?
   - **Edge cases** — failures, limits, conflicts to handle?
   - **Boundaries** — what's explicitly out of scope for now?

   Example for "add save functionality": What gets saved (full state vs.
   part)? Where/what format (file, localStorage, DB)? How is it triggered
   (button, shortcut, auto-save)? Overwrite or keep versions? Anything
   deliberately out of scope (cloud sync, multi-device)?

3. **Draft the ticket content.** Capture only what's relevant:
   - **Title** — short and imperative ("Add document auto-save")
   - **Goal** — one line on why it exists
   - **Behavior** — what it does, concretely
   - **Done when** — 1–4 checkable acceptance points
   - **Technical notes** — where it lives, deps, approach
   - **Out of scope** — what this ticket does NOT include
   - **Assumptions / open questions** — anything you guessed or still unknown

   Small feature → a couple of these lines is plenty. Don't pad.

4. **Write it to Taskwarrior.** Create one task with sensible metadata, then
   attach the detail as annotations (so it all lives in the ticket, viewable
   with `task <id> info`). If a shell is available, run the commands; otherwise
   output them ready to paste.

## Taskwarrior output format

Defaults: `project:` = the repo/app name, tag `+feature` (use `+bug`/`+refactor`
if more apt), `priority:` M unless the user says otherwise. Adjust to the
user's own conventions if the repo or user reveals them.

```bash
# Create the task — capture the new id into $ID
ID=$(task add "Add document auto-save" project:myapp +feature priority:M \
      rc.verbose=new-id | grep -oP 'Created task \K[0-9]+')

# Attach the fleshed-out detail as annotations
task "$ID" annotate "Goal: persist work so it survives a reload or crash."
task "$ID" annotate "Behavior: save full doc state (content+cursor+settings) as JSON."
task "$ID" annotate "Trigger: Cmd/Ctrl-S + auto-save every 30s; overwrites in place."
task "$ID" annotate "Storage: localStorage key app:doc:<id>."
task "$ID" annotate "Done when: reload restores exact state; manual save shows a toast."
task "$ID" annotate "Out of scope: cloud sync, multi-device, version history."
task "$ID" annotate "Assumption: single document per app instance."
```

If the `$ID` capture doesn't fit the user's setup, fall back to running
`task add ...` first and using the id it prints for the `annotate` lines.
Prefix each annotation with its label (`Goal:`, `Done when:`, etc.) so the
ticket reads cleanly in `task <id> info`.

## After creating it

Show the user the ticket id and a one-line summary, and confirm the annotations
landed (`task <id> info`). Keep assumptions visible so they can correct any
before building.
