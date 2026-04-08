<div align="center">

# OpenCode Go CLI

**Use OpenCode Go or OpenAI models with Claude Code.**

Translates Claude Code's Anthropic requests into OpenAI API calls — in real time, chunk by chunk. Supports both OpenCode Go (API key) and OpenAI via OAuth (ChatGPT Plus/Pro).

[![Bun](https://img.shields.io/badge/Runtime-Bun-1E2028?logo=bun&logoColor=f9f1e3)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Compatible-FF6B35?logo=claude&logoColor=white)](https://docs.anthropic.com/en/docs/claude-code)
[![Proxy](https://img.shields.io/badge/Proxy-Local_Anthropic→OpenAI-6E56CF)](#runtime-model)
[![License](https://img.shields.io/badge/License-MIT-green)](#license)

</div>

## Why OpenCode Go CLI

Claude Code uses the Anthropic API natively, but OpenCode Go offers coding models through an OpenAI-compatible API. This CLI bridges the two:

- Spawns a local HTTP proxy that translates Anthropic requests to OpenAI format
- Streams responses back in real time (no buffering)
- Spawns Claude Code with the correct environment variables pointing to the local proxy
- Persists your API key and last model between sessions

The goal is not to change how Claude Code works.
The goal is to make it work with OpenCode Go — transparently.

## Core Capabilities

- **Streaming translation** — SSE chunk-by-chunk, in real time
- **Tool call support** — `tool_use` and `tool_result` blocks are mapped correctly
- **Image support** — `image` content blocks converted to `data:` URIs
- **Two providers** — OpenCode Go (API key) or OpenAI via OAuth (ChatGPT Plus/Pro)
- **Interactive menu** — Provider → Model → Permission Mode flow with settings menu
- **4 permission modes** — default, acceptEdits, auto, bypassPermissions
- **WebSearch interception** — `web_search` server tool requests executed locally via SearXNG Docker container
- **Model selection** — interactive or `--model` flag, 10 models available
- **Persistent config** — API key / OAuth tokens and last model stored in `~/.opencode-go-cli/`
- **Sub-agent compatibility** — all sub-agents use the same model via environment variables
- **Fail-fast validation** — invalid models caught before proxy starts
- **Automatic token refresh** — OAuth tokens renewed automatically

## Interactive Menu

When launched without arguments, the CLI shows an interactive menu:

```
opencode-go
  → "What do you want to do?" → Start / Settings
    → Start:
        → Select provider (OpenCode Go / OpenAI)
        → Auth check (API key or OAuth)
        → Select model
        → Select permission mode
        → Start proxy + launch Claude Code
    → Settings:
        → Set API key / Login OpenAI / Logout OpenAI / Reset all
```

## Permission Modes

| Mode | Behavior |
|------|----------|
| `default` | Asks permission for everything |
| `acceptEdits` | Auto-approves file edits, asks for commands |
| `auto` | Classifier reviews actions (experimental) |
| `bypassPermissions` | Skips all permission checks |

## Runtime Model

The CLI runs in two stages:

```
Stage 1: CLI (opencode-go)
  └─ Interactive menu (provider → model → permission mode)
  └─ Starts proxy on localhost:PORT
  └─ Starts SearXNG Docker container (background, for WebSearch)
  └─ Spawns Claude Code with ANTHROPIC_BASE_URL=http://localhost:PORT

Stage 2: Proxy (localhost:PORT)
  └─ Receives POST /v1/messages (Anthropic format)
  └─ Intercepts web_search server tool requests → SearXNG
  └─ Routes based on provider:
       ├─ OpenCode Go: Chat Completions API (/v1/chat/completions)
       └─ OpenAI:      Responses API (/backend-api/codex/responses)
  └─ Translates response back (streaming or non-streaming)
  └─ Returns to Claude Code
```

### Request Flow

**OpenCode Go (Chat Completions):**
```
Claude Code → POST /v1/messages (Anthropic)
  → convertAnthropicRequestToOpenAI()
    → OpenCode Go API: POST /v1/chat/completions
      → streamOpenAIToAnthropic() or convertOpenAIResponseToAnthropic()
        → Claude Code
```

**OpenAI/Codex (Responses API):**
```
Claude Code → POST /v1/messages (Anthropic)
  → convertAnthropicRequestToResponses()
    → Codex backend: POST /backend-api/codex/responses
      → streamResponsesToAnthropic() or convertResponsesApiToAnthropic()
        → Claude Code
```

### Environment Variables Injected

| Variable | Value |
|----------|-------|
| `ANTHROPIC_BASE_URL` | `http://localhost:PORT` (local proxy) |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenCode Go API key |
| `ANTHROPIC_MODEL` | Selected model |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` |
| `CLAUDE_CODE_NO_FLICKER` | `1` |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Same as selected model |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Same as selected model |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Same as selected model |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Same as selected model |

## Architecture

```text
src/
├── index.ts                 Thin entry point (shebang + main export)
├── cli.ts                  Interactive menus, permission modes, Claude Code spawn
├── constants.ts            MODELS, OPENAI_MODELS, PROVIDERS, OAuth constants
├── config.ts               getConfig, saveConfig, deleteConfig
├── path.ts                 resolveClaudePath (claude binary in PATH)
├── env.ts                  buildClaudeEnv, cleanupClaudeCodeVars
├── logger.ts               createLogger (DEBUG/INFO/WARN/ERROR) + silenceLogger() + file logging
├── auth/
│   ├── oauth.ts           PKCE, exchange, refresh, JWT decode
│   └── server.ts          Local HTTP server for OAuth callback
├── search/
│   └── searxng.ts         SearXNG Docker container management + search queries
└── proxy/
    ├── types.ts                          Config, Model interfaces
    ├── helpers.ts                        mapStopReason, generateMsgId, convertImageSource, makeSSE
    ├── websearch-interceptor.ts          WebSearch server tool interception via SearXNG
    ├── request-conversion.ts             Anthropic → Chat Completions (OpenCode Go)
    ├── response-conversion.ts            Chat Completions → Anthropic (OpenCode Go)
    ├── stream-conversion.ts              Chat Completions SSE → Anthropic SSE (OpenCode Go)
    ├── request-conversion-responses.ts   Anthropic → Responses API (OpenAI/Codex)
    ├── response-conversion-responses.ts  Responses API → Anthropic (OpenAI/Codex)
    ├── stream-conversion-responses.ts    Responses API SSE → Anthropic SSE (OpenAI/Codex)
    └── server.ts                         Bun.serve + dual routing + WebSearch interception

tests/
├── helpers.test.ts
├── request-conversion.test.ts
├── response-conversion.test.ts
├── env.test.ts
└── logger.test.ts
```

## Models Available

### OpenCode Go (API key — `--provider opencode`)

| ID | Name | Description |
|----|------|-------------|
| `minimax-m2.7` | MiniMax M2.7 | High performance coding model |
| `minimax-m2.5` | MiniMax M2.5 | Balanced speed and quality |
| `kimi-k2.5` | Kimi K2.5 | Strong reasoning for complex tasks |
| `glm-5` | GLM-5 | Latest generation from Zhipu AI |
| `glm-5.1` | GLM-5.1 | Enhanced reasoning from Zhipu AI |

### OpenAI (OAuth — `--provider openai`)

| ID | Name | Description |
|----|------|-------------|
| `gpt-5.2` | GPT-5.2 | Latest GPT-5 model |
| `gpt-5.3` | GPT-5.3 | High performance GPT-5 |
| `gpt-5.4` | GPT-5.4 | Balanced GPT-5 |
| `gpt-5.1-codex` | GPT-5.1 Codex | Code-optimized GPT-5.1 |
| `gpt-5.2-codex` | GPT-5.2 Codex | Code-optimized GPT-5.2 |
| `gpt-5.3-codex` | GPT-5.3 Codex | Code-optimized GPT-5.3 |

## CLI

```bash
# Interactive mode (full menu: provider → model → permission mode)
opencode-go

# Direct launch with flags
opencode-go --model minimax-m2.7
opencode-go --provider openai --model gpt-5.2-codex
opencode-go --model minimax-m2.7 --permission-mode acceptEdits
opencode-go --provider openai --model gpt-5.2-codex --permission-mode auto
opencode-go --dangerously-skip-permissions --model minimax-m2.7

# Setup / Auth
opencode-go --setup           Configure OpenCode Go API key
opencode-go --oauth-login     Authenticate with OpenAI (ChatGPT Plus/Pro)
opencode-go --oauth-logout    Remove OpenAI tokens
opencode-go --reset           Delete all config

# List models
opencode-go --list                        Show default provider models
opencode-go --list --provider openai      Show OpenAI models
opencode-go --list --provider opencode    Show OpenCode Go models

# Proxy-only mode (for testing)
opencode-go --proxy --port 8080

# Interactive mode auto-selects the next free local proxy port if the preferred port is busy
opencode-go --model minimax-m2.7

# Help
opencode-go --help

# Pass flags directly to Claude Code
opencode-go --provider openai --model gpt-5.4 -- --dangerously-load-development-channels server:telegram-claude-bridge
```

## Setup

**Requirements:**

- [Bun](https://bun.sh) runtime (required to run `opencode-go`)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and in PATH
- **OpenCode Go:** API key from your OpenCode Go subscription
- **OpenAI:** ChatGPT Plus/Pro subscription (for OAuth)

**Install globally (recommended):**

```bash
bun install -g @opencode-go/cli
```

O pacote é publicado no npm, mas o runtime oficial do CLI é Bun. O comando recomendado de instalação global é `bun install -g @opencode-go/cli`.

**For local development only:**

```bash
bun run build
bun link
```

**Quick Start — OpenCode Go:**

```bash
opencode-go --setup
opencode-go
```

**Quick Start — OpenAI:**

```bash
opencode-go --oauth-login
opencode-go --provider openai --model gpt-5.2-codex
```

## Configuration

Config is stored at `~/.opencode-go-cli/config.json`:

`proxyPort` is the preferred local proxy port. In normal interactive mode, if that port is already in use, the CLI automatically tries the next free port and injects the final URL into Claude Code.

```json
{
  "provider": "opencode",
  "apiKey": "sk-opencode-...",
  "openaiTokens": {
    "access": "...",
    "refresh": "...",
    "expiresAt": 1234567890
  },
  "lastModel": "minimax-m2.7",
  "proxyPort": 8080
}
```

## Development

```bash
opencode-go                   # After global install with Bun
bun run src/index.ts          # Without global install
bun run build                 # Build to dist/
bun run typecheck             # TypeScript check
bun test                      # Test suite (49 tests)
```

**Proxy-only testing (with API key in config):**

Interactive mode auto-falls back to the next free port. `--proxy` remains explicit/predictable: use `--port` to force a specific port, or omit it to use the configured/default preferred port.

```bash
# Without DEBUG (quiet)
opencode-go --proxy --port 8082

# With DEBUG (verbose)
DEBUG=1 opencode-go --proxy --port 8082
```

**Test an invalid model (should fail fast):**

```bash
opencode-go --model invalid-model
# → Unknown model: invalid-model
# → Run 'opencode-go --list' to see available models.
```

## Documentation

| Document | Purpose |
|----------|---------|
| [CLAUDE.md](CLAUDE.md) | Claude Code guidance for this repository |
| [.specs/project/ROADMAP.md](.specs/project/ROADMAP.md) | Milestones and feature status |
| [.specs/codebase/ARCHITECTURE.md](.specs/codebase/ARCHITECTURE.md) | Code architecture and data flows |
| [.specs/codebase/STRUCTURE.md](.specs/codebase/STRUCTURE.md) | File structure and module organization |
| [.specs/codebase/INTEGRATIONS.md](.specs/codebase/INTEGRATIONS.md) | External integrations and APIs |

## WebSearch (SearXNG)

The proxy intercepts `web_search` server tool requests from Claude Code and executes them locally via a SearXNG Docker container.

- Container: `opencode-searxng` (port 8888)
- Auto-started in background when proxy launches
- Settings generated at `~/.opencode-go-cli/searxng/settings.yml`
- Requires Docker to be available; gracefully degrades if not

## Current State

- 49 tests passing (Bun test runner)
- Build clean (`bun build` → `dist/index.js`)
- All 7 milestones complete:
  - ✅ Modular refactoring (12 modules, ~40-220 lines each)
  - ✅ Test suite (conversion, helpers, env, logger)
  - ✅ Debug logging gated (DEBUG=1 for verbose output)
  - ✅ UX improvements (spinner, fail-fast, clear errors)
  - ✅ Codex OAuth provider (OpenAI via OAuth, GPT-5.x family)
  - ✅ WebSearch interception via SearXNG
  - ✅ Interactive CLI and permission modes

## License

MIT
