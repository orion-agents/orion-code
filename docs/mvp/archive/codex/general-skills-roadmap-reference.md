# OpenHorse Skills Support and Roadmap

## Current Status

OpenHorse now supports turn-time skills.

Implemented capabilities:

- Built-in skills under `src/skills/builtin/<name>/SKILL.md`.
- User skills under `~/.openhorse/skills/<name>/SKILL.md`.
- Project skills under `.openhorse/skills/<name>/SKILL.md`.
- YAML frontmatter parsing through `src/skills/loader.ts`.
- Skill registry lookup through `src/skills/registry.ts`.
- `/skills` command for listing loaded skills.
- System prompt injection of skill names, descriptions, triggers, and declared tools.
- Turn-time skill resolution through `resolveSkillsForTurn(input, context)`.
- Full `SKILL.md` prompt injection only when a skill trigger matches the current turn.
- Tool scoping: if an active skill declares `tools`, only the union of those tools is exposed to the LLM for that turn.
- Project skills override user skills, and user skills override built-ins when names conflict.
- Skill resource roots are tracked, and relative resources are resolved from the skill directory.
- Applied skill names are recorded on session user messages, session metadata, and the Context Harness ledger.

The base prompt keeps a lightweight skill index, while the complete skill instructions are injected only for matched skills. This keeps ordinary turns smaller and makes skill behavior more predictable.

## Current Skill Format

```markdown
---
name: code-review
description: Review code for quality, bugs, and best practices
trigger: /review
tools:
  - read_file
  - glob
  - grep
priority: 60
---

# Code Review Skill

Skill-specific instructions go here.
```

## Runtime Behavior

- A user input such as `/review src` can trigger the `code-review` skill even though `/review` is not a built-in slash command.
- Matched skills are sorted by priority and capped by `MAX_AUTO_SKILLS`.
- If no matched skill declares a tool scope, all normal tools remain available.
- If one or more matched skills declare tools, the active tool list is filtered to that union.
- Relative paths referenced by a skill should be resolved from the emitted `Resource root`.

## Remaining Enhancements

1. Add a `/skill <name>` explicit activation command for skills without text triggers.
2. Add a conflict report in `/skills` so users can see which skill overrode another.
3. Add optional skill asset listing in `/skills --verbose`.
4. Add per-skill enable/disable settings if users want to suppress built-ins.
5. Add richer session analytics for skill success rate and tool usage.

## v0.1.22 Recommendation

Ship the current triggered-skill runtime as part of v0.1.22. Keep the remaining enhancements as follow-up work after UI v2 and turn interruption stabilize.
