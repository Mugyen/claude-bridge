# Project instructions for Claude Code

You are working inside the **claude-bridge** repo. Before touching anything,
load the developer guide:

@DEVELOPER.md

That file contains:
- The owner's vision (8 absolute principles — do not violate)
- 15 hard-learned lessons (do not redo these)
- The documentation update checklist (every code change must touch at least one MD file)
- Release checklist + testing methodology
- Per-task checklists for adding tools, hooks, install flags

This is a project-level CLAUDE.md — it is loaded automatically whenever
Claude Code runs inside this directory. Nothing here leaks into the user's
global `~/.claude/CLAUDE.md`.

For end-user protocol docs (how agents talk to the bridge at runtime), the
canonical source is `skill/SKILL.md` — installed to
`~/.claude/skills/claude-bridge/SKILL.md` by `./claude-bridge`. Do NOT inline that
content here.
