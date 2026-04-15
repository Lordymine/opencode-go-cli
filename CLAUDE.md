# CLAUDE.md

This repository is a Bun + TypeScript CLI that launches Claude Code against a local Anthropic-compatible proxy.

## Commands

```bash
bun run src/index.ts
bun run build
bun run typecheck
bun test

opencode-go
opencode-go --setup
opencode-go --oauth-login
opencode-go --oauth-logout
opencode-go --qwen-login
opencode-go --qwen-list
opencode-go --qwen-test
opencode-go --qwen-remove <id-or-email>
opencode-go --zai-login
opencode-go --proxy --port 8080
```

## Operating Model

The project has two runtime modes:

- Interactive mode: Start or Settings, then provider -> model -> permission mode -> proxy launch -> Claude Code launch.
- Proxy mode: `--proxy` starts the local HTTP bridge directly on a chosen port.

Supported providers:

- `opencode`: OpenCode Go API key
- `openai`: OpenAI/Codex OAuth
- `qwen`: Qwen device flow with saved-account rotation
- `zai`: Z.ai free GLM models via browser-assisted login

## Key Flows

### OpenCode Go

- Anthropic request -> `convertAnthropicRequestToOpenAI()` -> Chat Completions API
- Response -> `streamOpenAIToAnthropic()` or `convertOpenAIResponseToAnthropic()`

### OpenAI

- Anthropic request -> `convertAnthropicRequestToResponses()` -> Codex Responses API
- Response -> `streamResponsesToAnthropic()` or `convertResponsesApiToAnthropic()`

### Qwen

- Request enters `handleQwenRequest()`
- Rotator selects an account from SQLite
- Token refresh runs when needed
- Upstream failures can place model locks and fall back to another account before streaming starts

### Z.ai

- Request enters `handleZaiRequest()`
- Handler validates the saved token
- A chat is created, the request is signed, and the Z.ai stream is translated back into Anthropic SSE

## Important Files

| File | Responsibility |
|------|----------------|
| `src/cli.ts` | Main CLI flow, menus, auth entry points, Claude Code launch |
| `src/constants.ts` | Providers, models, endpoints, config paths |
| `src/config.ts` | JSON config load/save/delete |
| `src/env.ts` | Claude Code environment construction |
| `src/auth/oauth.ts` | OpenAI OAuth exchange and refresh |
| `src/auth/qwen/*` | Qwen device flow, PKCE, refresh |
| `src/auth/zai/*` | Z.ai browser-assisted token capture |
| `src/db/*` | SQLite bootstrap, accounts, locks, settings |
| `src/rotator/*` | Qwen account selection and fallback policy |
| `src/proxy/server.ts` | Bun server and provider routing |
| `src/proxy/qwen-handler.ts` | Qwen request orchestration |
| `src/proxy/zai-handler.ts` | Z.ai request orchestration |
| `src/proxy/zai-stream.ts` | Z.ai SSE -> Anthropic SSE conversion |
| `src/search/searxng.ts` | Local SearXNG lifecycle and queries |

## Local State

- `~/.opencode-go-cli/config.json`: OpenCode Go key, OpenAI tokens, Z.ai token, last provider/model, preferred proxy port
- `~/.opencode-go-cli/qwen.db`: Qwen accounts, per-model locks, rotator settings
- `~/.opencode-go-cli/searxng/settings.yml`: generated SearXNG config

## Constraints

- Runtime is Bun, not plain Node.
- Streaming translation is the core behavior. Preserve Anthropic SSE semantics.
- Qwen fallback only happens before the first upstream bytes are streamed back to Claude Code.
- Z.ai login depends on a Chromium-based browser being available to the local machine.
- `bun test` should cover the full suite before release work.
