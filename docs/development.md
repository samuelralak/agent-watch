# Development

```sh
npm install
npm run build
npm test
```

| Script | Does |
| --- | --- |
| `npm run dev` | runs the view from the sources |
| `npm test` | runs every test |
| `npm run typecheck` | checks types |
| `npm run lint` | Biome and ESLint; a warning fails |

## Conventions

- Imports go one way: `domain` ← `application` ← `adapters` ← `tui`, `cli`, `hook`.
- Files are named by role: `*.port.ts`, `*.adapter.ts`, `*.service.ts`, `*.policy.ts`.
- Every `if` has braces. An empty line follows declarations and surrounds blocks.
- A function has at most 50 lines.
- Input is validated where it enters, with zod.
- Tests are named as sentences.
- Commits are one line: `type(scope): summary`, 50 characters or fewer.

`npm run lint` enforces the layout rules.

## Tests

The tests never touch `~/.claude`, your real state, the fingerprint sensor or `/usr/local`.
They build to `test/.build`, so an installed agentwatch is not changed.

## Trying a change safely

Point agentwatch at scratch folders, then use a throwaway Claude Code session:

| Variable | Default |
| --- | --- |
| `AGENTWATCH_STATE_DIR` | `~/.local/state/agentwatch` |
| `AGENTWATCH_SHARE_DIR` | `~/.local/share/agentwatch` |
| `AGENTWATCH_LOCK_DIR` | `/usr/local/libexec/agentwatch` |

## A new Claude Code version

Check a prompt, a tool call, a subagent and a message in a throwaway session, then add the
version to `src/adapters/claude/verified-versions.ts`.
