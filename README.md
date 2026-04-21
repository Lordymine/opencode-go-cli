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

## Providers

### OpenCode Go (`--provider opencode`)

The OpenCode Go model list is fetched live from
`https://opencode.ai/zen/v1/models` and cached locally for one hour. Run
`opencode-go --list` to see the current catalog (40+ models at the time of
writing, including Claude, Gemini, GPT, GLM, MiniMax, Kimi, Qwen, and free-tier
entries). Use `opencode-go --refresh-models` (or `--list --refresh-models`)
to force a refresh. When the endpoint is unreachable the CLI falls back to a
built-in snapshot of the most common models.

### OpenAI (`--provider openai`)

| ID | Name | Description |
|----|------|-------------|
| `gpt-5.2` | GPT-5.2 | Latest GPT-5 model |
| `gpt-5.3` | GPT-5.3 | High performance GPT-5 |
| `gpt-5.4` | GPT-5.4 | Balanced GPT-5 |
| `gpt-5.1-codex` | GPT-5.1 Codex | Code-optimized GPT-5.1 |
| `gpt-5.2-codex` | GPT-5.2 Codex | Code-optimized GPT-5.2 |
| `gpt-5.3-codex` | GPT-5.3 Codex | Code-optimized GPT-5.3 |

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
opencode-go --list --refresh-models   # force OpenCode model cache refresh

# Refresh OpenCode model cache without listing
opencode-go --refresh-models

# Proxy only
opencode-go --proxy --port 8080

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
    "expiresAt": 1234567890
  },
  "zaiToken": "...",
  "lastModel": "minimax-m2.7",
  "proxyPort": 8080
}
```

Qwen accounts, rotator settings, and model cooldown locks are stored separately in `~/.opencode-go-cli/qwen.db`.

`proxyPort` is the preferred local proxy port. In interactive mode the CLI automatically falls forward to the next free port if the preferred one is already in use.

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
|   `-- opencode-models.ts
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
