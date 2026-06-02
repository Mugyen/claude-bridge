# claude-bridge — read this first (AI agents)

This file is auto-loaded for any AI/agent working in this repo. First decide which
of the two cases you're in — they are very different.

## ➡️ Case 1 — you were asked to INSTALL or USE claude-bridge  (the common case)

Run ONE command from the repo root:

```bash
./claude-bridge install
```

That is the **entire install** — it configures the hooks, the MCP server, the
skill, the Desktop app config, and puts the `claude-bridge` command on your PATH.

Then, optionally:

```bash
./claude-bridge doctor      # verify everything is wired up
./claude-bridge start       # start the bridge server
```

🚫 **DO NOT run the test suite to install or verify.** Do not run `npm test`,
`tests/run-all.sh`, or any file under `tests/`. Those exist only for developers
*changing* the code — they spin up throwaway bridges on scratch ports and have
nothing to do with installing or using claude-bridge. **Installing is just
`./claude-bridge install`.** To check it worked, use `./claude-bridge doctor`,
never the tests.

- How to use it (tools, Desktop, troubleshooting) → **USAGE.md**
- Link machines across networks → **docs/CROSS-NETWORK.md**

Once installed, you're done — you do not need anything below this line.

## 🛠️ Case 2 — you were asked to DEVELOP or MODIFY claude-bridge

**Only if you are changing the code:** open **`DEVELOPER.md`** and read it before
touching anything. It contains the owner's vision (8 absolute principles), the
hard-learned lessons (don't redo them), the documentation-update checklist, the
release checklist, the **testing methodology** (this is the *only* place `npm
test` belongs — for development, never for install), and per-task checklists for
adding tools / hooks / install flags.

---

- This is a project-level `CLAUDE.md`, auto-loaded only inside this directory;
  nothing here leaks into the user's global `~/.claude/CLAUDE.md`.
- End-user runtime protocol docs (how agents talk to the bridge) live in
  `skill/SKILL.md`, installed to `~/.claude/skills/claude-bridge/SKILL.md` by
  `./claude-bridge install`. Don't inline that content here.
