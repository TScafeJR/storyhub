# storyhub

One Storybook for all your git worktrees. Each worktree you opt in gets its own section at the top of the sidebar, containing only the stories its changes affect. The rest of the stories sit below under "Common". Branch stories render from the worktree's changed files layered over the main checkout's modules, so there is one dev server, one dependency install and one module cache.

```
⎇ feat/login              ← only stories this branch changes
  Components / Button
  Components / LoginForm
⎇ fix/toast · behind main
  Components / Toast
Common                    ← the main checkout, as usual
  Components / Badge
  ...
```

It also ships an MCP endpoint, so agents can see which stories each branch changes, why, and where to view them.

## Requirements

- Storybook 10.5 or newer on a Vite-based framework (`@storybook/react-vite`, `@storybook/react-native-web-vite`, `@storybook/vue3-vite`, ...).
- Node 20.19 or newer.
- Your worktrees are worktrees of the repo that runs Storybook (`git worktree add`).

storyhub has no runtime dependencies. It uses the oxc parser Storybook already installs and Vite's own file watcher.

## Setup

```sh
npm install --save-dev --save-exact storyhub
```

```ts
// .storybook/main.ts
export default {
  addons: ['storyhub'],
};
```

Start Storybook from the main checkout as you normally would. Nothing appears until you turn branches on.

## Turning branches on and off

Branches are opt-in. Run the CLI inside a worktree:

```sh
npx storyhub on      # show the worktree you are in
npx storyhub off     # hide it again
npx storyhub list    # every worktree and whether it is on
```

Or name them from anywhere in the repo:

```sh
npx storyhub on feat/login        # a branch, worktree directory name, id or path
npx storyhub on 'feat/*'          # a glob, saved as a pattern so future worktrees match too
npx storyhub off feat/old-thing   # switch one off even when a glob matches it
```

Changes show up in the running Storybook within a second, with no restart. Agents working in a worktree can run `npx storyhub on` themselves when they want their work visible.

The selection is stored as `storyhub.include` and `storyhub.exclude` entries in the repo's local `.git/config`. It is never committed and every worktree sees it. Team-wide defaults can go in the addon options (see below).

## Cleaning up worktrees

```sh
npx storyhub clean                         # dry run: what could go and why
npx storyhub clean --older-than 30         # also list worktrees idle for 30+ days
npx storyhub clean --yes                   # remove the removable ones
npx storyhub clean --yes --delete-branches # and delete their merged branches
```

A worktree is a candidate when its branch is merged into the base (`origin/HEAD`, else `main`), when every file it changed already matches the base (squash or rebase merges), when it has no commits of its own, or when it is older than `--older-than`. These are always kept:

- worktrees with uncommitted changes
- locked worktrees
- detached HEADs with commits that are not in the base

Removal uses `git worktree remove` without `--force`, and branch deletion uses `git branch -d`, so git refuses anything that would lose work. Removed worktrees are also dropped from the opt-in config. Use `--base <ref>` to compare against a different branch and `--json` for scripting.

## MCP

Add the endpoint to your MCP client next to `@storybook/addon-mcp` (`.mcp.json`):

```json
{
  "mcpServers": {
    "storyhub": { "type": "http", "url": "http://localhost:6006/storyhub/mcp" }
  }
}
```

| Tool | What it returns |
| --- | --- |
| `list-worktrees` | Every worktree and whether it is shown, plus the CLI commands to change that |
| `list-branches` | Shown branches with changed file counts, affected story counts and drift flags |
| `get-branch-changes` | A branch's changed files and every affected story, each with the import chain that explains why, and URLs |
| `get-story-variants` | For a story id, its URL in Common plus its URL in every branch that changes it, for side-by-side comparison |

The MCP tools are read-only. Turning branches on and off goes through the CLI.

## Options

```ts
addons: [
  {
    name: 'storyhub',
    options: {
      mode: 'opt-in',            // or 'all' to show every worktree unless excluded
      include: ['release/*'],    // patterns always on (merged with git config)
      exclude: ['*-scratch'],    // patterns always off
      branchesPosition: 'top',   // or 'bottom' to keep Storybook's default order
      commonLabel: 'Common',     // heading for the main checkout's stories
    },
  },
],
```

## How it works

For each branch that is on, storyhub:

1. Diffs the worktree (including uncommitted and untracked files) against its merge base with the main checkout.
2. Walks the import graph from every story file, using Vite's own resolver so aliases, tsconfig paths and workspace packages behave as they do in your app.
3. Marks a file dirty when it changed or imports something that did. Stories that are dirty are the ones that branch shows.
4. Serves the branch as a Storybook composition ref from the same dev server. When a branch module imports something, the import resolves as it would from the main checkout. The target is loaded from the worktree only if it is dirty, otherwise the main checkout's module instance is shared. Unchanged code is never transformed twice, and React contexts stay single instances.
5. If a branch dirties something your `.storybook/preview` imports (a context provider, say), that branch's iframe loads the worktree's copy of the preview so providers and consumers match.

Edits in a worktree hot-reload in its section. Adding a story, changing imports, or switching a branch on or off updates the sidebar live.

## Drift flags

A branch title can carry notes:

| Note | Meaning |
| --- | --- |
| `deps changed` | `package.json` or a lockfile changed in the branch. The branch still renders with the main checkout's dependencies. |
| `.storybook changed` | Storybook config other than preview files changed in the branch. The main checkout's config is used. |
| `diverged` | Some files changed on both sides since the split. The branch's version is used. |
| `behind main` | Main changed files that sit between a story and the branch's changes. The branch renders its own older copy of those files. Rebase or merge main to see them current. |
| `missing deps` | The branch imports packages the main checkout cannot resolve. Those stories will error. |
| `no story changes` | The branch changes nothing a story imports. |

## Limitations

- Vite builder only for now. The core is builder-agnostic; a webpack adapter can be added behind the same interface.
- A story that main added after a branch split is not shown in that branch, because the worktree does not have it.
- `@storybook/addon-mcp` logs a warning at startup for each branch ref ("Skipping composed ref"). It skips them and keeps working; use storyhub's MCP tools for branch data.
- The sidebar order is changed visually. Keyboard focus order follows Storybook's DOM order (Common first).

## Development

```sh
pnpm install
pnpm test        # unit tests against a generated fixture repo with real worktrees
pnpm test:e2e    # builds, runs a real storybook dev server, drives it with Playwright and the MCP SDK client
pnpm fixture     # generate the fixture repo to poke at by hand
```

The repo's own installs refuse package versions newer than 7 days and save exact versions (`pnpm-workspace.yaml`).

## Releasing

Publishing always rebuilds `dist` (`prepack`) and runs the typecheck and unit tests first (`prepublishOnly`), so a broken or stale build cannot go out.

```sh
pnpm release:check          # optional but recommended: everything, including the browser E2E suite
npm version patch           # or minor / major: bumps package.json, commits and tags vX.Y.Z
pnpm publish                # refuses unless the tree is clean and you are on main
git push --follow-tags
```

The first time, log in with `npm login`. If your npm account uses two-factor auth, pnpm prompts for the code (or pass `--otp <code>`).
