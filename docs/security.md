# Security

## In short

- Every message is signed. A session delivers only messages that are validly signed,
  addressed to it, unexpired and not seen before. Anything else is rejected and shown.
- A message is never an approval. Claude Code shows it as hook feedback, not as you typing.
- By default the signing key is a file that any program running as you could read.
- Locking makes your messages need your fingerprint. It raises the bar; it is not a wall.

## Locked sending

Needs a Mac with Touch ID and the Xcode command-line tools.

```sh
agentwatch lock enable      # asks for your password once
agentwatch lock status
agentwatch lock disable
```

`lock enable` makes a key in the Secure Enclave and stores its public half, with the policy
for agents, in `/usr/local/libexec/agentwatch/`, owned by root. From then on:

- A message in your name needs your fingerprint, once per agentwatch window.
- A message in your name signed with the file key is rejected.

Touch the sensor only right after sending your first message in a window. Any program can
raise a fingerprint prompt: refuse one you did not cause.

## Messages from agents

An agent can run `agentwatch send --session <id or name> <text>`. The message is always
marked as an agent's, never as yours. With sending locked, `lock enable --agents <how>` sets
what is allowed:

| Policy | Effect |
| --- | --- |
| `approve` (default) | each message needs your fingerprint |
| `free` | agents may send |
| `off` | agents may not send |

Without the lock, agents may send.

## Limits

- The hooks run scripts and code that belong to you. A program running as you can rewrite
  them, or your Claude Code settings, and get a message accepted without a fingerprint.
- A program that can run commands can also type into a session's terminal.
- Activity, unlike messages, is not signed: a program could add made-up entries to the view.

The lock stops casual misuse. Only Claude Code's own sandboxing makes your account a boundary.

## What agentwatch does not touch

- Claude Code's peer sockets and per-session keys.
- Your settings, except through `hooks install` and `hooks uninstall`, which keep a backup.
- Anything at all while no agentwatch window is open.
