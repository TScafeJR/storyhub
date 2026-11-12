# Changelog

## 0.2.0 (2026-11-12)

- Add an interactive release script (npm run release)
- Rewrite docs for npm users; doctor and --version for installed setups

## 0.1.0

First release.

- Storybook addon that shows opted-in git worktrees as branch sections above the main checkout's stories ("Common"). Each section lists only the stories that branch's changes affect.
- Branches render from the worktree's changed files (and the files that import them) layered over the main checkout's modules, in one dev server. Preview files are swapped per branch when a branch changes something they import, so context providers keep working.
- Drift notes on branch titles: deps changed, .storybook changed, diverged, behind main, missing deps.
- CLI: `storyhub on`, `off`, `list` (opt-in selection in local git config), `clean` (remove merged or idle worktrees, dry run by default), `status`, `doctor`.
- MCP endpoint at `/storyhub/mcp`: `list-worktrees`, `list-branches`, `get-branch-changes`, `get-story-variants`.
- No runtime dependencies.
- Requires Storybook 10.5+ with a Vite-based framework and Node 20.19+. Tested with `@storybook/react-vite` on Vite 6 and 8.
