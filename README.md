# storyhub

[![npm](https://img.shields.io/npm/v/storyhub)](https://www.npmjs.com/package/storyhub) [![license](https://img.shields.io/npm/l/storyhub)](LICENSE)

One Storybook for all your git worktrees.

When you work on several UI changes at once, each in its own `git worktree`, storyhub puts them side by side in the Storybook you already run. Every worktree you opt in gets a section at the top of the sidebar that lists only the stories its changes affect. Your normal stories stay below under "Common".

```
⎇ feat/login              ← only the stories this branch changes
  Components / Button
  Components / LoginForm
⎇ fix/toast · behind main
  Components / Toast
Common                    ← your main checkout, as usual
  Components / Badge
  ...
```

There is still one dev server, one dependency install and one module cache. Branch stories render from the worktree's changed files layered over your main checkout's modules. An MCP endpoint lets coding agents see which stories each branch changes, why, and where to view them.

## Requirements

- Storybook 10.5 or newer with a Vite-based framework. Tested with `@storybook/react-vite` on Vite 6 and 8. Other Vite frameworks should work but are untested so far.
- Node 20.19 or newer.
- Your branches are worktrees of the repo that runs Storybook (`git worktree add ../my-feature -b my-feature`).

storyhub has no runtime dependencies.

## Install

Install it in the package that runs Storybook. In a monorepo that is the app or workspace with the `.storybook` folder, not necessarily the repo root.

```sh
npm install --save-dev --save-exact storyhub
# or
yarn add --dev --exact storyhub
pnpm add --save-dev --save-exact storyhub
bun add --dev --exact storyhub
```

Register the addon:

```ts
// .storybook/main.ts
const config: StorybookConfig = {
  // ...
  addons: [
    // ...your other addons
    'storyhub',
  ],
};
```

Check the setup from that same package directory:

```sh
npx --no-install storyhub doctor
```

Then start Storybook from your main checkout the way you always do (`npm run storybook`). Nothing new appears until you turn a branch on.

## Turn branches on

Branches are opt-in. From inside a worktree:

```sh
npx --no-install storyhub on      # show the worktree you are in
npx --no-install storyhub off     # hide it again
npx --no-install storyhub list    # every worktree and whether it is on
```

From anywhere in the repo, including the main checkout, name what you want:

```sh
npx --no-install storyhub on feat/login        # a branch, worktree directory name or path
npx --no-install storyhub on 'feat/*'          # a glob, saved as a pattern so future worktrees match too
npx --no-install storyhub off feat/old-thing   # switch one off even when a glob matches it
```

The running Storybook picks changes up within a second, with no restart.

`--no-install` makes npx use the copy installed in your project and fail rather than download a package from the registry. If a worktree has no `node_modules` of its own, run the command from the main checkout and pass the branch name. Inside `package.json` scripts, plain `storyhub on` works.

The selection is stored as `storyhub.include` and `storyhub.exclude` entries in the repo's local `.git/config`. It is never committed, and every worktree of the repo sees the same selection.

## Let your agents do it

Agents working in a worktree can opt their own work in. Add something like this to your `CLAUDE.md` or `AGENTS.md`:

```md
## Storybook
This repo uses storyhub. When you change UI in a worktree, make it visible in the shared Storybook by
running `npx --no-install storyhub on` inside the worktree (or `npx --no-install storyhub on <branch>`
from the main checkout). Run `npx --no-install storyhub off` when you are done. Use the `storyhub`
MCP tools to find the stories your branch affects and their URLs.
```

## Connect MCP

storyhub serves an MCP endpoint from the running Storybook at `/storyhub/mcp`. Add it to your MCP client next to `@storybook/addon-mcp`. With Claude Code, put this in `.mcp.json` (change the port to yours):

```json
{
  "mcpServers": {
    "storyhub": { "type": "http", "url": "http://localhost:6006/storyhub/mcp" }
  }
}
```

| Tool | Returns |
| --- | --- |
| `list-worktrees` | Every worktree, whether it is shown, and the commands to change that |
| `list-branches` | Shown branches with changed file counts, affected story counts and drift notes |
| `get-branch-changes` | A branch's changed files and every affected story, each with the import chain that explains why, plus URLs |
| `get-story-variants` | For a story id, its URL in Common and in every branch that changes it, for side-by-side comparison |

The tools are read-only. Turning branches on and off goes through the CLI.

## Clean up old worktrees

```sh
npx --no-install storyhub clean                          # dry run: what could go and why
npx --no-install storyhub clean --older-than 30          # also list worktrees idle for 30+ days
npx --no-install storyhub clean --yes                    # remove the removable ones
npx --no-install storyhub clean --yes --delete-branches  # and delete their merged branches
```

A worktree is a candidate when its branch is merged into the base (`origin/HEAD`, else `main`), when every file it changed already matches the base (squash or rebase merges), when it has no commits of its own, or when it is older than `--older-than`. These are always kept:

- worktrees with uncommitted changes
- locked worktrees
- detached HEADs with commits that are not in the base

Removal uses `git worktree remove` without `--force`, and branch deletion uses `git branch -d`, so git refuses anything that would lose work. Removed worktrees are dropped from the opt-in list too. Pass `--base <ref>` to compare against another branch, or `--json` for scripts.

## Options

All optional:

```ts
addons: [
  {
    name: 'storyhub',
    options: {
      mode: 'opt-in',            // or 'all': show every worktree unless excluded
      include: ['release/*'],    // patterns that are always on, for the whole team (merged with git config)
      exclude: ['*-scratch'],    // patterns that are always off
      branchesPosition: 'top',   // or 'bottom' to keep Storybook's default order
      commonLabel: 'Common',     // heading for the main checkout's stories
    },
  },
],
```

## CLI reference

| Command | What it does |
| --- | --- |
| `storyhub on [target...]` | Show worktrees. No target means the worktree you are in. |
| `storyhub off [target...]` | Hide worktrees. |
| `storyhub list [--json]` | List every worktree and whether it is on. |
| `storyhub clean [--base <ref>] [--older-than <days>] [--delete-branches] [--yes] [--json]` | Find and remove merged or idle worktrees. Dry run unless `--yes`. |
| `storyhub status [--url <storybook url>] [--json]` | Affected stories and drift per branch, from the running Storybook. |
| `storyhub doctor [-c <config dir>]` | Check that this package is set up correctly. |
| `storyhub --version` | Print the installed version. |

## How it works

For each branch that is on, storyhub:

1. Diffs the worktree, including uncommitted and untracked files, against its merge base with your main checkout.
2. Walks the import graph from every story file, using Vite's own resolver, so aliases, tsconfig paths and workspace packages behave as they do in your app.
3. Marks a file dirty when it changed or imports something that did. The dirty story files are what the branch's section shows.
4. Serves the branch as a Storybook composition ref from the same dev server. Imports from branch modules resolve as they would in your main checkout. A target loads from the worktree only if it is dirty; otherwise the main checkout's module is shared. Unchanged code is never transformed twice, and React contexts stay single instances.
5. If a branch dirties something your `.storybook/preview` imports, such as a context provider, that branch's iframe loads the worktree's copy of the preview so providers and consumers match.

Edits in a worktree hot-reload in its section. Adding stories, changing imports, or turning a branch on or off updates the sidebar live.

## Notes on branch titles

| Note | Meaning |
| --- | --- |
| `deps changed` | `package.json` or a lockfile changed in the branch. The branch still renders with your main checkout's dependencies. |
| `.storybook changed` | Storybook config other than preview files changed. Your main checkout's config is used. |
| `diverged` | Some files changed on both sides since the branch split. The branch's version is used. |
| `behind main` | Main changed files that sit between a story and the branch's changes. The branch renders its own older copy of those files. Rebase or merge main to see them current. |
| `missing deps` | The branch imports packages your main checkout cannot resolve. Those stories will error. |
| `no story changes` | The branch changes nothing a story imports. |

## Limitations

- Vite builder only for now.
- A story that main added after a branch split does not appear in that branch, because the worktree does not have it.
- `@storybook/addon-mcp` logs a "Skipping composed ref" warning at startup for each branch. It keeps working; use storyhub's MCP tools for branch data.
- The sidebar is reordered visually. Keyboard focus order follows Storybook's DOM order, which puts Common first.

## Contributing

```sh
pnpm install
pnpm lint           # oxlint, warnings fail the run (pnpm lint:fix applies safe fixes)
pnpm test           # unit tests against a generated fixture repo with real worktrees
pnpm test:e2e       # builds, runs a real Storybook dev server, drives it with Playwright and the MCP SDK client
pnpm fixture        # generate the fixture repo to explore by hand
```

This repo's own installs refuse package versions published less than 7 days ago and always save exact versions (see `pnpm-workspace.yaml`).

### Releasing

```sh
npm run release              # or: pnpm release
npm run release -- --full    # also run the browser E2E suite first
npm run release -- --dry-run # walk through every step without changing anything
```

It checks you are on an up-to-date `main` and logged in to npm, offers `git commit -p` for any pending changes, runs the linter, typecheck and unit tests, asks for patch, minor or major, drafts the `CHANGELOG.md` entry from commit subjects since the last release tag (you can edit it), then bumps the version, commits, tags, pushes and runs `pnpm publish`. Nothing changes until you confirm the plan. If your npm account uses two-factor auth, pnpm prompts for the code.

The script is called `release`, not `publish`, because `pnpm publish` runs a script named `publish` itself.

## License

MIT
