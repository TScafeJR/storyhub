# Roadmap

Where storyhub is, what comes next, and why. Each item says what problem it solves and what "done" means, so it can be picked up without extra context. Items move up as they become clearer; nothing here is a promise of dates.

## Shipped

| Version | What |
| --- | --- |
| 0.1 | Branch sections over the main checkout (Vite), drift notes, MCP endpoint, CLI `status` / `doctor` |
| 0.2 | Opt-in selection (`storyhub on` / `off` / `list`), `storyhub clean`, branches above Common, per-branch preview files, zero runtime dependencies, release script |
| 0.3 | webpack 5 support, builder-agnostic reload channel, oxlint, arrow-key release picker |
| 0.4 | Storybook may run from any checkout (the CLI finds it), live toggling from a worktree hub, sidebar race fix |
| next | One MCP server: addon-mcp passed through, branch-aware story preview and story tests with regression flags |

Verified on a real app (fossix/platform: Storybook 10.5.7, Vite 6, 92 story files, five branches): 168 of 169 story files rendered the same in the branch as in the hub; the one difference was a real "behind main" case, now flagged.

## 0.4: hardening on real repos

The core works; the next risk is the long tail of real setups.

- **Run it daily in your own repos.** fossix/platform (Vite 6, monorepo `frontend/`), nba-kevin-bacon-visual (Vite 8), whistle (`@storybook/react-native-web-vite`). Done when each runs a week with branches on and every surprise has a test in the fixture.
- **Test matrix in CI.** A GitHub Actions workflow running lint, typecheck, unit and both E2E builders on every push, on macOS and Linux. Done when a red build blocks `npm run release`.
- **Publish from CI with provenance.** npm trusted publishing from a tagged GitHub Actions run: no npm token anywhere, and a signed link from each version to the commit that built it. Done when `npm view storyhub` shows provenance and the release script tags instead of publishing.
- **`storyhub off --all` and `storyhub on --only <branch>`.** Quick resets when many branches are on. Done when both work and are listed in `list` output hints.
- **Stale opt-in entries.** A plain `git worktree remove` leaves the branch in `storyhub.include`. `list` should show such entries and `clean` should offer to drop them. Done when no orphaned entry survives a `clean --yes`.
- **Startup and refresh cost.** Measured: about 2.8 s to build the graph for 5 branches on fossix. Persist parsed imports to disk (keyed by content hash) and update the graph incrementally from file events instead of re-walking it. Done when a refresh after a one-file edit takes under 200 ms on fossix.
- **Windows.** Paths, `fs.watch`, drive letters in `/@fs` URLs and webpack requests. Done when the E2E suite passes on a Windows runner.

## 0.5: seeing the difference

The original idea was "branching or alternative views". Today you switch between the branch section and Common by hand.

- **Compare view.** A toolbar toggle that shows the same story from Common and from a branch side by side, synced on args and viewport. Done when any branch story can be compared in one click and the pairing survives story switches.
- **Visual diff.** An overlay mode (onion skin, or highlighted changed pixels) on top of the compare view, computed in the browser from two screenshots. Done when a one-pixel change is visible without squinting.
- **Branch panel.** A Storybook panel for the selected branch story: branch description (git's `branch.<name>.description`, else the latest commit subject), commits since the split, ahead/behind counts, and the import chain that put this story in the branch. Done when you can tell why a story is in a section without opening a terminal.
- **MCP for agents: screenshots.** Branch preview URLs and branch story tests (with regressions against Common) shipped in 0.5; next is returning screenshots of both versions and a pixel-difference score from the same headless browser, so an agent can confirm a visual change without a human looking. Done when an agent can verify a purely visual change end to end through MCP.

## 0.6: closer to "what main will look like"

- **Rebase preview for "behind main".** Today a branch renders its own copy of files that sit between a story and its changes, even when main has moved on (the `behind main` note). Serving main's version of those files inside the branch's module namespace needs per-branch module identities for unchanged files (a query suffix in Vite, a request suffix in webpack) without breaking loaders and plugins that filter on file paths. Done when the fossix `support-and-req` case renders like main plus the branch's changes, with a switch to keep today's behaviour.
- **Stories main added after the split.** They are skipped in branches today because the worktree does not have them. The same per-branch namespace would let them render with the branch's changes. Done when such stories appear in the branch section and render correctly.
- **Dependency drift mode.** When a branch changes `package.json`, optionally resolve its bare imports from the worktree's own `node_modules` (if present) instead of the hub's, accepting a second copy of shared packages for that branch. Done when a branch that upgrades a UI library renders with the upgraded version on request.

## Later

- **More builders and frameworks.** rsbuild (`storybook-rsbuild`), Next.js (`@storybook/nextjs`, webpack), Angular, Vue 3, Svelte and web components on Vite. The graph already reads Vue and Svelte script blocks and MDX imports; each needs a fixture and an E2E run. Done per framework when it joins the CI matrix.
- **Static builds.** `storybook build` with selected branches baked in, for PR previews and visual regression services. Done when a static build shows the same branch sections as dev.
- **Branches without worktrees.** Render a branch straight from git objects through a virtual file system, so you can glance at a colleague's branch or a PR without checking it out. Done when `storyhub on origin/feat/x` works with no worktree on disk.
- **Pull request shortcut.** `storyhub on pr/123` fetches the PR into a worktree (or the virtual mode above) and turns it on.
- **Upstream Storybook improvements.** The sidebar is reordered with CSS because Storybook always draws local stories first, and `@storybook/addon-mcp` warns about refs it cannot reach. Proposing a ref ordering option and a way to mark same-server refs would remove both workarounds and fix keyboard focus order.

## Known limitations today

These are deliberate trade-offs, listed so they are not mistaken for bugs:

- A branch renders its own copy of files between a story and its changes, even if main changed them since the split (flagged `behind main`; see 0.6).
- Stories added to main after a branch split do not appear in that branch.
- Branches use the main checkout's dependencies and main Storybook config (flagged `deps changed` / `.storybook changed`).
- The sidebar order is visual only; keyboard focus follows Storybook's order (Common first).
- `@storybook/addon-mcp` logs one "Skipping composed ref" warning per branch at startup.
