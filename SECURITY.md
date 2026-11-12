# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: [open a private advisory](https://github.com/TScafeJR/storyhub/security/advisories/new). Do not open a public issue or pull request for them.

Include what you found, how to reproduce it, and which version you tested. You should get a reply within a week. Fixes are released before details are made public, and you are credited in the advisory unless you prefer not to be.

## Supported versions

Only the latest minor release gets security fixes. storyhub is below 1.0, so upgrading to the latest version is the fix path.

## Scope

storyhub runs inside `storybook dev` on a developer's machine. Things worth reporting include:

- a web page or another machine being able to reach storyhub's dev-server routes (`/storyhub/mcp`, `/__storyhub/*`) when Storybook is not exposed on purpose;
- reading files, running commands, or making requests through those routes or the MCP tools beyond what they document;
- the CLI (`storyhub on`, `off`, `clean`) changing or deleting anything other than the worktrees and git config entries it reports;
- problems in the published npm package itself, such as unexpected files or install scripts.

storyhub has no runtime dependencies, so reports about Storybook, Vite, webpack or Playwright belong with those projects.
