# Claude Code Statusline - Design

**Spec**: `.specs/features/statusline/spec.md`
**Status**: Draft

## Architecture Overview

A solucao mais simples e deixar o Claude Code continuar sendo a fonte da linha
de status. Ele chama um comando configurado em `statusLine`, envia JSON por
stdin, e o comando imprime uma linha.

O `opencode-go` entra apenas em dois pontos:

1. instala um script pequeno de statusline;
2. escreve um estado local minimo quando inicia o Claude Code.

O proxy nao vira fonte da statusline. Ele so precisa devolver `usage` correto
nas respostas Anthropic-compatible para que o Claude Code consiga preencher
`context_window`.

```text
opencode-go start
  -> resolve provider/model/permission/proxy
  -> write statusline-state.json
  -> start proxy
  -> spawn Claude Code

Claude Code render tick
  -> runs ~/.opencode-go-cli/statusline.js
  -> sends status JSON through stdin
  -> script reads optional opencode-go state
  -> script prints one short line
```

## Data Flow

### Claude Code stdin

Primary fields:

- `model.id`
- `model.display_name`
- `context_window.used_percentage`
- `context_window.remaining_percentage`
- `context_window.context_window_size`
- `context_window.current_usage`
- `effort.level`
- `thinking.enabled`
- `rate_limits.five_hour`
- `rate_limits.seven_day`

### Local state file

Path: `~/.opencode-go-cli/statusline-state.json`

Shape:

```typescript
interface StatuslineState {
  version: 1;
  provider: "opencode" | "openai" | "qwen" | "zai";
  model: string;
  permissionMode: "default" | "acceptEdits" | "auto" | "bypassPermissions";
  proxyUrl: string;
  startedAt: string;
  cliVersion: string;
  updatedAt: string;
}
```

Rules:

- No tokens, API keys, account ids, prompts or responses.
- State is best-effort; render must work without it.
- Claude Code stdin wins over state when both provide model data.

## Components

### `src/statusline/format.ts`

Pure formatter.

Exports:

```typescript
export interface ClaudeStatusInput { ... }
export interface FormatStatuslineOptions {
  style?: "compact" | "minimal";
  now?: Date;
  maxWidth?: number;
}

export function formatStatusline(
  input: unknown,
  state?: StatuslineState | null,
  options?: FormatStatuslineOptions,
): string;
```

Responsibilities:

- safely read nested fields
- build ordered segments
- format percentages and reset durations
- drop optional segments when output is too wide
- avoid throwing on malformed input

Segment order for compact style:

1. provider
2. model
3. effort
4. context
5. 5h rate limit
6. weekly rate limit

Segment order for minimal style:

1. model
2. context

### `src/statusline/state.ts`

Safe state read/write.

Exports:

```typescript
export function getStatuslineStateFile(): string;
export function readStatuslineState(): StatuslineState | null;
export function writeStatuslineState(state: StatuslineState): void;
export function buildStatuslineState(args: {
  provider: Provider;
  model: string;
  permissionMode: PermissionMode;
  proxyUrl: string;
  cliVersion: string;
  now?: Date;
}): StatuslineState;
```

Test hook:

- use env var `OPENCODE_STATUSLINE_STATE_FILE_OVERRIDE` for temp paths.

### `src/statusline/script.ts`

Runtime entry used by the generated script.

Responsibilities:

- read stdin fully
- parse JSON
- read local state
- call `formatStatusline`
- write a single line to stdout
- swallow errors and produce a safe fallback

This module keeps logic testable. The installed `statusline.js` can be a small
bundled file generated from this entry.

Build rule:

- build `src/index.ts` to `dist/index.js`
- build `src/statusline/script.ts` to `dist/statusline.js`
- installer copies `dist/statusline.js` to
  `~/.opencode-go-cli/statusline.js`

That keeps one formatter implementation and avoids a generated script template
that drifts from the tested source.

### `src/statusline/install.ts`

Install and settings merge.

Exports:

```typescript
export interface InstallStatuslineResult {
  status: "installed" | "already-installed" | "conflict";
  scriptPath: string;
  settingsPath: string;
  manualSnippet?: string;
}

export function installStatusline(options?: {
  force?: boolean;
  configDir?: string;
  claudeSettingsFile?: string;
  runtimeCommand?: string;
}): InstallStatuslineResult;
```

MVP behavior:

- write or update `~/.opencode-go-cli/statusline.js`
- ensure `~/.claude/settings.json` exists
- add `statusLine` only if absent or already owned by opencode-go
- refuse existing third-party `statusLine`
- return a manual snippet on conflict

Ownership marker:

- command contains `statusline.js` under `~/.opencode-go-cli`
- optional generated script header contains `opencode-go statusline`

### `src/statusline/paths.ts`

Small path helpers if needed.

Purpose:

- avoid growing `constants.ts`
- isolate Windows path quoting for shell command
- keep files below the 250-line target

## CLI Changes

Add flags:

- `--install-statusline`
- `--statusline-snippet`

`--install-statusline` writes script and tries to merge Claude settings.

`--statusline-snippet` prints the JSON config and exits. This is useful when
settings are managed/read-only or when the user has an existing statusline.

Start flow change:

```text
startFlow()
  -> select provider/model/permission
  -> start proxy
  -> writeStatuslineState(...)
  -> runClaudeCode(...)
```

Writing state before spawn is enough. The state does not need live mutation for
MVP because usage/rate/context are read from Claude Code stdin.

`PermissionMode` is currently local to `src/cli.ts`. Move it to a small shared
type location, or export it from a module that does not import CLI code, before
state helpers use it.

## Proxy Usage Changes

The statusline depends on Claude Code having good `context_window` data. That
means the proxy should preserve usage when upstreams provide it.

### Chat Completions

- non-streaming already maps `prompt_tokens` and `completion_tokens`
- streaming should capture final usage chunks when present
- request conversion should request usage for streaming with:

```json
{
  "stream_options": {
    "include_usage": true
  }
}
```

If an upstream rejects `stream_options`, the follow-up implementation can gate
this per provider. The initial task should include tests and a quick manual
smoke with OpenCode/Qwen if credentials are available.

### Responses API

`response.completed` includes response usage. The stream converter should
forward available input/cache/output fields in `message_delta.usage`.

### Z.ai

Z.ai currently does not expose reliable input usage in the existing handler.
Keep output estimate only and do not fabricate context. The statusline should
handle missing context data cleanly.

## Settings Strategy

Claude settings path:

- user: `~/.claude/settings.json`

MVP only changes user settings through explicit `--install-statusline`.

When a conflict is found:

```json
{
  "statusLine": {
    "type": "command",
    "command": "<runtime> <script>",
    "padding": 1,
    "refreshInterval": 5
  }
}
```

`refreshInterval: 5` keeps time-based reset labels fresh without running too
often. The script itself must remain fast and local.

## Error Handling

| Scenario | Behavior |
| --- | --- |
| Invalid stdin JSON | print fallback model/state if possible |
| Missing state file | render from stdin only |
| Invalid state file | ignore state |
| Existing foreign statusLine | do not overwrite; print manual snippet |
| Read-only settings file | show clear error and manual snippet |
| Formatter error | return empty string or minimal safe line |

## Testing Strategy

Unit tests:

- `tests/statusline-format.test.ts`
- `tests/statusline-state.test.ts`
- `tests/statusline-install.test.ts`
- `tests/stream-conversion.test.ts`
- `tests/stream-conversion-responses.test.ts`

Smoke checks:

```bash
bun test
bun run typecheck
bun run src/index.ts --statusline-snippet
echo '{"model":{"display_name":"Opus"},"context_window":{"used_percentage":25}}' | bun ~/.opencode-go-cli/statusline.js
```

Manual Claude Code check: install, start one real `opencode-go` session, send
one prompt, then verify provider/model/context and honest rate limit segments.

## Simplicity Guardrails

No daemon, provider polling, DB schema change, statusline endpoint, or custom
protocol. Keep the formatter pure and the local state limited to metadata that
Claude Code does not provide.
