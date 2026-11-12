# Changelog

## 0.5.2 (2026-11-12)

- Keep storyhub's dev-server routes for local use

## 0.5.1 (2026-11-12)

- Add a logo, banner, how-it-works diagram and real screenshots to the README
- Prepare for a public repo: security policy, credential ignores, roadmap for frameworks and TypeScript 7
- Roadmap: long-term direction, 0.6 to 1.0 milestones and post-1.0 horizons

## 0.5.0 (2026-11-12)

- Make storyhub the one MCP server agents need for Storybook

## 0.4.0 (2026-11-12)

- Detect which checkout Storybook actually runs from
- Fix a race that could crash the sidebar when a branch is added live
- Watch git metadata when Storybook runs from a linked worktree

## 0.3.0 (2026-11-12)

- Restore oxlint and fix what it found in the webpack work
- Add ROADMAP.md
- Add webpack 5 support
- Make change signalling builder-agnostic
- release: pick the version with arrow keys

## 0.2.1 (2026-11-12)

- Add oxlint and harden the release script

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
