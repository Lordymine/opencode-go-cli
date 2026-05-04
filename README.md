<div align="center">

# OpenCode Go CLI

**Use OpenCode Go, OpenAI, Qwen, or Z.ai models with Claude Code.**

Bridge Claude Code's Anthropic protocol to multiple provider backends through a local Bun proxy. The CLI handles auth, model selection, proxy startup, and Claude Code launch in one flow.

[![Bun](https://img.shields.io/badge/Runtime-Bun-1E2028?logo=bun&logoColor=f9f1e3)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Compatible-FF6B35?logo=claude&logoColor=white)](https://docs.anthropic.com/en/docs/claude-code)
[![License](https://img.shields.io/badge/License-MIT-green)](#license)

</div>

## Why

Claude Code speaks Anthropic natively. This project runs a local proxy that translates Claude Code requests into the provider-specific API format and streams responses back in real time.

Core capabilities:

- OpenCode Go via API key
- OpenAI/Codex via OAuth
- Qwen via OAuth device flow with multi-account rotation
- Z.ai free GLM models via browser-assisted login
- Interactive provider, model, and permission-mode selection
- WebSearch interception via local SearXNG
- Proxy port fallback when the preferred port is busy
- Shared model injection for Claude Code sub-agents
- Claude Code statusLine installer with provider/model/context display

## Providers

### OpenCode Go (`--provider opencode`)

The OpenCode Go model list is fetched live from
`https://opencode.ai/zen/go/v1/models` and cached locally for one hour. Run
`opencode-go --list` to see the current OpenCode Go catalog. Use
`opencode-go --refresh-models` (or `--list --refresh-models`) to force a
refresh. When the endpoint is unreachable the CLI falls back to a built-in
OpenCode Go snapshot.

### OpenAI (`--provider openai`)

The OpenAI model list is fetched from ChatGPT's Codex model registry for the
authenticated account and cached locally for one hour. This keeps ChatGPT Go,
Plus, Pro, Team, and other plan-specific model availability in sync without a
hardcoded list. Hidden/internal registry entries are filtered out, and the CLI
falls back to the built-in GPT snapshot if the registry is unavailable.

### Qwen (`--provider qwen`)

| ID | Name | Description |
|----|------|-------------|
| `qwen3-coder-plus` | Qwen3 Coder Plus | High-performance Qwen coding model |
| `qwen3-coder-flash` | Qwen3 Coder Flash | Fast, cost-efficient Qwen coding model |

Qwen support includes:

- `--qwen-login` to add an account through device flow
- `--qwen-list` to inspect saved accounts
- `--qwen-test` to validate saved accounts
- `--qwen-remove <id-or-email>` to remove an account
- automatic fallback across saved accounts when one is cooling down or fails

### Z.ai (`--provider zai`)

| ID | Name | Description |
|----|------|-------------|
| `glm-4.7` | GLM-4.7 | Fast and reliable, stable availability |
| `glm-5-turbo` | GLM-5 Turbo | Fast GLM-5 variant |
| `glm-5.1` | GLM-5.1 | Latest GLM with stronger reasoning |
| `glm-5` | GLM-5 | Base GLM-5 model |

Z.ai support uses `--zai-login` to capture a token through a Chromium-based browser session.

## Interactive Flow

When launched without arguments, the CLI shows:

```text
opencode-go
  -> Start / Settings
     -> choose provider
     -> ensure auth for that provider
     -> choose model
     -> choose permission mode
     -> start proxy and launch Claude Code
```

Settings includes API key management, OpenAI login/logout, Qwen login and account tools, Z.ai login, and full reset.

## CLI

```bash
# Interactive mode
opencode-go

# Direct launch
opencode-go --model minimax-m2.7
opencode-go --provider openai --model gpt-5.2-codex
opencode-go --provider qwen --model qwen3-coder-plus
opencode-go --provider zai --model glm-4.7

# Auth
opencode-go --setup
opencode-go --oauth-login
opencode-go --oauth-logout
opencode-go --qwen-login
opencode-go --qwen-list
opencode-go --qwen-test
opencode-go --qwen-remove work@example.com
opencode-go --zai-login

# List models
opencode-go --list
opencode-go --list --provider openai
opencode-go --list --provider qwen
opencode-go --list --provider zai
opencode-go --list --refresh-models   # force OpenCode cache refresh
opencode-go --list --provider openai --refresh-models

# Refresh dynamic model cache without listing
opencode-go --refresh-models
opencode-go --refresh-models --provider openai

# Proxy only
opencode-go --proxy --port 8080

# Claude Code statusline
opencode-go --install-statusline
opencode-go --statusline-snippet
opencode-go --statusline-debug-on
opencode-go --statusline-debug-show
opencode-go --statusline-debug-off

# Pass extra flags through to Claude Code
opencode-go --provider openai --model gpt-5.4 -- --dangerously-load-development-channels server:bridge
```

## Runtime Model

The CLI runs in two stages:

```text
Stage 1: CLI
  -> resolves config and auth
  -> starts local proxy
  -> starts SearXNG when needed for web_search
  -> launches Claude Code with ANTHROPIC_BASE_URL=http://localhost:PORT

Stage 2: Proxy
  -> receives POST /v1/messages in Anthropic format
  -> routes by provider
  -> translates streaming or non-streaming responses back to Anthropic
```

Routing:

- OpenCode Go -> Chat Completions API
- OpenAI -> Responses API
- Qwen -> Chat Completions API with per-request account selection and retry/fallback
- Z.ai -> Free GLM chat API with custom signing and SSE conversion

### Extended Thinking History

Some Chat Completions-compatible reasoning models require prior assistant
tool-call turns to include `reasoning_content` when conversation history is
replayed. The proxy preserves Anthropic `thinking` and `redacted_thinking`
blocks as `reasoning_content`; when a replayed assistant tool-call turn has no
plain reasoning block, it sends a small non-empty placeholder so
Moonshot/Kimi-style upstreams do not reject the request.

## Setup

Requirements:

- Bun runtime
- Claude Code installed and available in `PATH`
- OpenCode Go API key if using `opencode`
- ChatGPT Plus/Pro account if using `openai`
- Browser access for Qwen device-flow approval
- Chromium-based browser available for `zai` login

Global install:

```bash
bun install -g @opencode-go/cli
```

For local development:

```bash
bun run build
bun link
```

Quick start:

```bash
# OpenCode Go
opencode-go --setup
opencode-go

# OpenAI
opencode-go --oauth-login
opencode-go --provider openai --model gpt-5.2-codex

# Qwen
opencode-go --qwen-login
opencode-go --provider qwen --model qwen3-coder-plus

# Z.ai
opencode-go --zai-login
opencode-go --provider zai --model glm-4.7
```

## Configuration

General config is stored in `~/.opencode-go-cli/config.json`.

Example:

```json
{
  "provider": "opencode",
  "apiKey": "sk-opencode-...",
  "openaiTokens": {
    "access": "...",
    "refresh": "...",
    "expiresAt": 1234567890,
    "accountId": "acct_...",
    "planType": "plus"
  },
  "zaiToken": "...",
  "lastModel": "minimax-m2.7",
  "proxyPort": 8080
}
```

Qwen accounts, rotator settings, and model cooldown locks are stored separately in `~/.opencode-go-cli/qwen.db`.

OpenAI model discovery is cached in `~/.opencode-go-cli/openai-models.json`.

`proxyPort` is the preferred local proxy port. In interactive mode the CLI automatically falls forward to the next free port if the preferred one is already in use.

Claude Code statusline support is installed explicitly with `opencode-go --install-statusline`. It writes `~/.opencode-go-cli/statusline.js`, merges `~/.claude/settings.json` only when there is no foreign `statusLine`, and writes safe launch metadata to `~/.opencode-go-cli/statusline-state.json` when Claude Code is started through `opencode-go`. If Claude Code sends `context_window` with null percentages for custom providers, the proxy records the latest safe token usage there and the statusline renders an approximate `ctx ~N%` fallback.

For the OpenAI provider, the statusline also refreshes Codex/ChatGPT usage from `https://chatgpt.com/backend-api/wham/usage` and displays the current `5h` and `7d` windows when the endpoint returns them. The values are cached in the same statusline state file and never store access or refresh tokens.

For troubleshooting, `opencode-go --statusline-debug-on` makes the installed statusline capture Claude Code's raw status JSON locally. Use `opencode-go --statusline-debug-show` after a Claude Code render to inspect the latest payload, and `opencode-go --statusline-debug-off` when done. Captures are stored at `~/.opencode-go-cli/statusline-debug-latest.json` and `~/.opencode-go-cli/statusline-debug.jsonl`.

## Development

```bash
bun run src/index.ts
bun run build
bun run typecheck
bun test
```

The default test command runs the full suite, including the Qwen rotator tests.

## Project Structure

```text
src/
|-- cli.ts
|-- constants.ts
|-- env.ts
|-- config.ts
|-- logger.ts
|-- auth/
|   |-- oauth.ts
|   |-- server.ts
|   |-- qwen/
|   `-- zai/
|-- db/
|   |-- index.ts
|   |-- accounts.ts
|   `-- locks.ts
|-- rotator/
|   |-- index.ts
|   `-- fallback.ts
|-- proxy/
|   |-- server.ts
|   |-- qwen-handler.ts
|   |-- zai-handler.ts
|   |-- zai-signature.ts
|   `-- zai-stream.ts
|-- providers/
|   |-- opencode-models.ts
|   |-- openai-models.ts
|   `-- openai-usage.ts
|-- statusline/
|   |-- format.ts
|   |-- install.ts
|   |-- script.ts
|   `-- state.ts
`-- search/
    `-- searxng.ts
```

## Documentation

| Document | Purpose |
|----------|---------|
| [CLAUDE.md](CLAUDE.md) | Repository guidance for Claude Code |
| [.specs/project/ROADMAP.md](.specs/project/ROADMAP.md) | Milestones and feature status |
| [.specs/codebase/ARCHITECTURE.md](.specs/codebase/ARCHITECTURE.md) | Architecture and data flows |
| [.specs/codebase/STRUCTURE.md](.specs/codebase/STRUCTURE.md) | File structure and module organization |
| [.specs/codebase/INTEGRATIONS.md](.specs/codebase/INTEGRATIONS.md) | External integrations and APIs |

## License

MIT
