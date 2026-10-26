# Contributing to SurfCode

Thanks for helping make SurfCode better! Bug reports, ideas and pull requests are all welcome.

## Setup

```bash
git clone https://github.com/Geetank/surfcode.git
cd surfcode
npm install          # installs dependencies and builds dist/
npm run dev          # run the TUI from source
```

Requires Node.js 22 or newer.

## Before you open a PR

```bash
npm run typecheck
npm test
```

Tests use local mock servers, so no API keys are needed. Please add or update a test when you change behavior.

## Adding a tool

1. Implement a `ToolDefinition` in `src/tools/`.
2. Export it in `createTools()` (`src/tools/index.ts`).
3. Set `readOnly` and the permission `action`.
4. Add a renderer branch in `src/tui/render.ts` if the output needs a custom card.

## Adding a provider dialect

1. Add the dialect to `Dialect` in `src/core/types.ts`.
2. Implement the streaming adapter in `src/core/chat/`.
3. Dispatch it from `src/core/chat/index.ts`.
4. Map it in `inferDialect()`.

## Guidelines

- Keep changes focused. One idea per pull request.
- Never log or persist API keys or tokens.
- Describe what changed and why in the PR description.

By contributing, you agree your work is released under the [MIT License](LICENSE).
