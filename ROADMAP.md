# Roadmap

Where storyhub is, where it is going, and why. Each item says what problem it solves and what "done" means, so it can be picked up without extra context. Near items are concrete; later ones are directions, written down so today's choices do not close them off. Nothing here is a promise of dates.

## Where this is going

Parallel work is becoming the normal way to build UI: a person runs a few branches at once, and coding agents run many more, each in its own worktree. Storybook still shows one checkout at a time. storyhub's long-term aim is to be the one place where every in-flight UI change in a repo can be seen, compared, tested and reviewed, by people and by agents, without checking anything out or starting another server.

These principles decide the trade-offs along the way:

- **One dev server, local first.** Branches are overlays on the checkout you already run, not extra servers. Anything shared beyond your machine is opt-in and runs on infrastructure you control.
- **Honest rendering.** When a branch cannot be rendered exactly as it would be after merging, say so (drift notes) instead of guessing quietly.
- **Agents and people get the same powers.** Everything visible in the UI is reachable from the CLI and MCP, and the other way round.
- **Nothing extra in your supply chain.** No runtime dependencies; optional integrations (Playwright, oxc, addon-mcp) are taken from the project. Pinned toolchain, provenance on every release, no telemetry.
- **Build on Storybook, and shrink over time.** Use its extension points, keep a list of every workaround, and propose upstream changes so storyhub can drop them.

## Shipped

| Version | What |
| --- | --- |
| 0.1 | Branch sections over the main checkout (Vite), drift notes, MCP endpoint, CLI `status` / `doctor` |
| 0.2 | Opt-in selection (`storyhub on` / `off` / `list`), `storyhub clean`, branches above Common, per-branch preview files, zero runtime dependencies, release script |
| 0.3 | webpack 5 support, builder-agnostic reload channel, oxlint, arrow-key release picker |
| 0.4 | Storybook may run from any checkout (the CLI finds it), live toggling from a worktree hub, sidebar race fix |
| 0.5 | One MCP server: addon-mcp tools, resources and prompts passed through; branch-aware story preview and story tests (headless Chromium, regressions and fixes flagged against Common) |
| 0.5.2 | Dev-server routes accept only local hostnames (or `allowedHosts`) and refuse requests from other sites; storyhub's requests to its own server no longer depend on request headers |

Verified on a real app (Storybook 10.5.7, Vite 6, a monorepo with 92 story files, five branches): 168 of 169 story files rendered the same in the branch as in the hub; the one difference was a real "behind main" case, now flagged.

## 0.6: hardening on real repos

The core works; the next risk is the long tail of real setups, and the fact that storyhub now runs browsers on an agent's behalf.

- **Run it daily on real apps.** A Vite 6 monorepo, a single-package Vite 8 app, and a React Native Web app (`@storybook/react-native-web-vite`). Done when each runs a week with branches on and every surprise has a test in the fixture.
- **Test matrix in CI.** A GitHub Actions workflow running lint, typecheck, unit and both E2E builders on every push, on macOS and Linux. Actions pinned by commit SHA, a read-only token, no secrets. Done when a red build blocks `npm run release`.
- **Publish from CI with provenance.** npm trusted publishing from a tagged GitHub Actions run: no npm token anywhere, and a signed link from each version to the commit that built it. Done when `npm view storyhub` shows provenance and the release script tags instead of publishing.
- **Signed history.** Signed commits and release tags, enforced by a ruleset on `main` (no force pushes, no deletion). Done when every commit and tag since the switch shows as verified on GitHub.
- **Canary against Storybook and addon-mcp.** storyhub depends on details that are not public API: the generated `importFn` module, project annotations loading, `api.setRef`, and addon-mcp's tool names for the preview and test tools it replaces. A weekly CI run against `storybook@next` and the newest addon-mcp catches breaks before users do. Done when an upstream change fails the canary before it reaches a Storybook release, and the fixture covers the oldest supported addon-mcp (0.7.0).
- **Move to TypeScript 7.** A trial with 7.0.2 typechecks the whole repo with no errors in about 1 s (4 s on 5.9) and emits correct declarations. What remains:
  1. Pin `typescript` 7.0.2.
  2. Add `tsconfig.build.json` (`src` only, `emitDeclarationOnly`, `outDir: dist`) and run it from `pnpm build` after tsup. tsup's `dts` option cannot be used any more because it needs the TypeScript JS API, which 7 does not ship.
  3. Point the `types` paths of `./vite` and `./webpack` in `package.json` at `dist/vite/index.d.ts` and `dist/webpack/index.d.ts` (declarations become one file per module instead of one bundle per entry).
  4. Add a consumer test: a small project on TypeScript 5.9 that imports all three entry points and typechecks against the packed tarball.

  Done when `release:check` passes on TS 7, including the consumer test.
- **`storyhub off --all` and `storyhub on --only <branch>`.** Quick resets when many branches are on. Done when both work and are listed in `list` output hints.
- **Stale opt-in entries.** A plain `git worktree remove` leaves the branch in `storyhub.include`. `list` should show such entries and `clean` should offer to drop them. Done when no orphaned entry survives a `clean --yes`.
- **Startup and refresh cost.** Measured: about 2.8 s to build the graph for 5 branches on the Vite 6 monorepo pilot. Persist parsed imports to disk (keyed by content hash) and update the graph incrementally from file events instead of re-walking it. Done when a refresh after a one-file edit takes under 200 ms on that app.
- **Windows.** Paths, `fs.watch`, drive letters in `/@fs` URLs and webpack requests. Done when the E2E suite passes on a Windows runner.

## 0.7: seeing the difference

The original idea was "branching or alternative views". Today you switch between the branch section and Common by hand.

- **Compare view.** A toolbar toggle that shows the same story from Common and from a branch side by side, synced on args and viewport. Done when any branch story can be compared in one click and the pairing survives story switches.
- **Visual diff.** An overlay mode (onion skin, or highlighted changed pixels) on top of the compare view, computed in the browser from two screenshots. Done when a one-pixel change is visible without squinting.
- **Branch panel.** A Storybook panel for the selected branch story: branch description (git's `branch.<name>.description`, else the latest commit subject), commits since the split, ahead/behind counts, and the import chain that put this story in the branch. Done when you can tell why a story is in a section without opening a terminal.
- **MCP screenshots.** Return screenshots of the branch and Common versions of a story, plus a pixel-difference score, from the same headless browser the test tool uses. Done when an agent can verify a purely visual change end to end through MCP.
- **Opt in from MCP.** `show-branch` / `hide-branch` tools, so an agent that only has the MCP connection can put its own worktree on screen. Same rules as the CLI (local git config, no other side effects). Done when the agent snippet in the README needs no shell step.

## 0.8: closer to "what main will look like"

- **Rebase preview for "behind main".** Today a branch renders its own copy of files that sit between a story and its changes, even when main has moved on (the `behind main` note). Serving main's version of those files inside the branch's module namespace needs per-branch module identities for unchanged files (a query suffix in Vite, a request suffix in webpack) without breaking loaders and plugins that filter on file paths. Done when the pilot's `behind main` case renders like main plus the branch's changes, with a switch to keep today's behaviour.
- **Stories main added after the split.** They are skipped in branches today because the worktree does not have them. The same per-branch namespace would let them render with the branch's changes. Done when such stories appear in the branch section and render correctly.
- **Dependency drift mode.** When a branch changes `package.json`, optionally resolve its bare imports from the worktree's own `node_modules` (if present) instead of the hub's, accepting a second copy of shared packages for that branch. Done when a branch that upgrades a UI library renders with the upgraded version on request.

## 0.9: frameworks and builders

storyhub is tested on React with Vite and webpack. The overlay model is framework-neutral (it works on files and imports), but each framework adds its own compiler, file types and runtime rules. Every framework below needs a fixture with branch scenarios, an E2E run, and a row in the CI matrix; the notes say what is likely to be hard.

- **Angular** (`@storybook/angular`, webpack through the Angular CLI builder). The Angular compiler builds one TypeScript program for the whole project and reads `templateUrl` and `styleUrls` itself rather than through webpack, so a branch's changed template would not be picked up by the resolver redirect. Needs either a compiler host that maps dirty files to the worktree or a per-branch program limited to the dirty set. Also check standalone components and signal inputs. Analog (`@analogjs/storybook-angular`, Vite) may be the easier first step.
- **Vue 3** (`@storybook/vue3-vite`). The graph already reads `<script>` blocks; also follow `<style src>`, `<template src>` and `@import` in style blocks, and confirm `vite-plugin-vue` HMR keeps branch and hub instances apart.
- **Svelte and SvelteKit** (`@storybook/svelte-vite`, `@storybook/sveltekit`). Script blocks are read today; add `$lib` and the `$app/*` virtual modules, which must always come from the hub.
- **Next.js** (`@storybook/nextjs` on webpack, `@storybook/nextjs-vite`). Next's own SWC loader and its mocks for `next/image`, `next/navigation` and fonts must keep working on worktree files. Server components stay out of scope, as in Storybook itself.
- **Web components** (`@storybook/web-components-vite`, Lit). A branch copy of a module that calls `customElements.define` would try to register a tag the hub already registered, which throws. Each ref renders in its own iframe, so this may be fine, but it needs a test with a component imported by both a branch and the hub's preview.
- **Preact and Solid** (`@storybook/preact-vite`, `storybook-solidjs-vite`). Mostly compiler and HMR plugins (Prefresh, solid-refresh) that key on module ids; confirm branch modules refresh on their own.
- **React Native Web** (`@storybook/react-native-web-vite`). Already piloted; turn it into a fixture so it stays working.
- **HTML and other renderers** (`@storybook/html-vite`, Ember, Qwik). Only on request; the generic path should work, and a fixture proves it.
- **rsbuild and rspack** (`storybook-rsbuild`, `storybook-react-rsbuild`). rspack implements most of webpack's resolver hooks, so the webpack adapter is the starting point. Done when the same E2E suite passes on rsbuild.
- **Content-scanning CSS** (Tailwind, UnoCSS). These generate CSS from class names found in the hub's files, so a class used only in a branch may be missing from its render. Confirm with a fixture, then add each branch's dirty files to the scanner's sources (Tailwind 4's `@source`, Uno's `content`). Done when a branch that adds a new utility class renders it.

## 1.0: a contract you can build on

1.0 is not a feature release. It is the point where other tools, scripts and agents can depend on storyhub without pinning a patch version.

- **Frozen surfaces under semver:** addon options, CLI commands and flags, the git config keys (`storyhub.include` / `storyhub.exclude`), the server record format, the `/__storyhub/*` routes, and MCP tool names, inputs and outputs.
- **Machine-readable CLI.** `--json` on every command, with the same shapes the MCP tools return. Agents should never parse human output.
- **A supported matrix, tested.** Storybook 10 and the current major after it; Vite 6 to 8, webpack 5 and rsbuild; the frameworks from 0.9; Node 20, 22 and 24; macOS, Linux and Windows; all in CI.
- **A deprecation policy.** Anything removed warns for at least one minor release first, in the CLI, the Storybook log and MCP tool descriptions.

Done when the above is documented in the README and every item in it has a test.

## After 1.0

Directions rather than plans. Each still says what "done" would look like, so it is clear when one is ready to become a versioned milestone.

### Many agents, one Storybook

- **Scale to dozens of branches.** An agent fleet may keep 20 to 50 worktrees on at once. Compute a branch's graph only when its section is opened or an MCP call asks for it, and share one background process between Storybook, the CLI and MCP so the work is never repeated. Done when 50 opted-in branches add under five seconds to startup and nothing to idle CPU.
- **Change notifications over MCP.** MCP resources for each branch with update notifications, so an agent is told when one of its stories starts failing instead of polling. Done when an agent can wait for "my stories pass" without a loop.
- **Declared scope and blast radius.** An agent (or a person) states which stories its task should change. storyhub flags every other story whose rendering changed, which catches accidental edits to shared components. Done when a stray change to a shared button is reported before anyone opens Storybook.
- **Cross-branch overlap.** When two shown branches change the same file or story, say so on both ("also changed in feat-x"). Done when parallel agents learn about a coming conflict while they are still working.

### Reviewing many branches at once

- **Review inbox.** One page listing every changed story across all shown branches, with before and after thumbnails, ordered by how much changed. Mark each one approved or needs work; decisions are stored in git (notes or refs) so they travel with the branch. Done when a day of agent work can be reviewed in one place.
- **Combined preview.** Render two or more branches together, as they would look after all of them merge. Branches touching separate files combine directly; branches touching the same file are combined from git's merge result or flagged when they conflict. Done when "what does main look like after these three land" can be answered in Storybook.
- **Pull request summaries.** A command that writes the inbox for one branch (changed stories, screenshots, test results) as Markdown, for CI or a person to post on the pull request. storyhub itself holds no tokens. Done when a PR shows its visual changes without a hosted service.

### Beyond local worktrees

- **Branches without worktrees.** Render a branch straight from git objects through a virtual file system, so you can look at a colleague's branch or a PR without checking it out. Done when `storyhub on origin/feat/x` works with no worktree on disk.
- **Pull request shortcut.** `storyhub on pr/123` fetches the PR into a worktree (or the virtual mode above) and turns it on.
- **Static builds.** `storybook build` with selected branches baked in, for PR previews and visual regression services. Done when a static build shows the same branch sections as dev.
- **A team hub.** A long-running hub on a shared machine or in CI that follows remote branches on its own (for example every open PR touching UI), so a team has one URL showing all in-flight UI work. Self-hosted and opt-in, consistent with "local first". Done when a team can run it from the docs alone.

### Beyond today's Storybook

- **Upstream Storybook improvements.** The sidebar is reordered with CSS because Storybook always draws local stories first, `@storybook/addon-mcp` warns about refs it cannot reach and skips them, and branch indexes are served through private hooks. Proposing ref ordering, same-server refs, and a public way to add stories under a namespace would remove these workarounds and fix keyboard focus order. Done when storyhub uses only documented Storybook APIs.
- **The overlay engine on its own.** The core (diff, import graph, reverse closure, resolver redirect) does not depend on Storybook. The same model could show a whole Vite app with a branch's changes at `/__branch/<id>/`, or serve other component workshops. Exploration only: done when a second consumer uses the core without Storybook, at which point it becomes its own package.

### Trust, all the time

Not a milestone; rules every release keeps.

- No runtime dependencies. A new optional integration is loaded from the user's project or not at all.
- Dev dependencies are pinned exactly and only taken after they have been public for seven days.
- Every release is built in CI with provenance, and the tarball can be rebuilt byte for byte from its tag (to be checked in CI once publishing moves there).
- Network surfaces stay local by default and never collect telemetry.
- Security reports go through GitHub's private vulnerability reporting (see `SECURITY.md`), and fixes ship before details are published.

## Known limitations today

These are deliberate trade-offs, listed so they are not mistaken for bugs:

- A branch renders its own copy of files between a story and its changes, even if main changed them since the split (flagged `behind main`; see 0.8).
- Stories added to main after a branch split do not appear in that branch.
- Branches use the main checkout's dependencies and main Storybook config (flagged `deps changed` / `.storybook changed`).
- The sidebar order is visual only; keyboard focus follows Storybook's order (Common first).
- `@storybook/addon-mcp` logs one "Skipping composed ref" warning per branch at startup.
- Branch story tests need Playwright and Chromium in the project, and run in Chromium only.
- The MCP pass-through recognises addon-mcp's preview and test tools by name; a rename upstream shows both versions until storyhub is updated (see the canary in 0.6).
