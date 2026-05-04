# Claude Code Statusline - Tasks

**Design**: `.specs/features/statusline/design.md`
**Status**: Draft

## Execution Plan

Phase 1 makes data reliable. Phase 2 builds the statusline itself. Phase 3
connects CLI/install. Phase 4 does smoke validation.

```text
T1 -> T2 -> T3
      |
      +-> T4 -> T5 -> T6
                 |
                 +-> T7 -> T8 -> T9
                              |
                              +-> T10
```

## Task Breakdown

### T1: Add streaming usage tests for Chat Completions

**What**: Create tests for final usage propagation in OpenAI-compatible SSE.
**Where**: `tests/stream-conversion.test.ts`
**Depends on**: None
**Reuses**: `src/proxy/stream-conversion.ts`

**Done when**:

- [ ] test builds a mock SSE `Response`
- [ ] test includes a final usage chunk with empty `choices`
- [ ] test asserts final `message_delta.usage.input_tokens`
- [ ] test asserts final `message_delta.usage.output_tokens`
- [ ] test asserts cache token fields are preserved when present

**Verify**:

```bash
bun test tests/stream-conversion.test.ts
```

### T2: Forward streaming usage in Chat Completions converter

**What**: Update stream converter to forward input/cache/output usage when a
usage chunk exists.
**Where**: `src/proxy/stream-conversion.ts`
**Depends on**: T1
**Reuses**: existing `usage` variable and `makeSSE`

**Done when**:

- [ ] usage chunks with empty `choices` are parsed
- [ ] final `message_delta.usage` includes available input/cache/output tokens
- [ ] existing text/tool streaming behavior is unchanged
- [ ] tests from T1 pass

**Verify**:

```bash
bun test tests/stream-conversion.test.ts
bun test tests/response-conversion.test.ts
```

### T3: Request usage from OpenAI-compatible streaming providers

**What**: Add `stream_options.include_usage` when converting streaming requests.
**Where**: `src/proxy/request-conversion.ts`, `tests/request-conversion.test.ts`
**Depends on**: T2
**Reuses**: `convertAnthropicRequestToOpenAI`

**Done when**:

- [ ] `stream_options: { include_usage: true }` is set when `body.stream` is true
- [ ] non-streaming requests do not include `stream_options`
- [ ] existing request-conversion tests pass
- [ ] any provider-specific rejection discovered in smoke is documented before
      adding provider gates

**Verify**:

```bash
bun test tests/request-conversion.test.ts
```

### T4: Add streaming usage tests for Responses API

**What**: Create tests for usage propagation from `response.completed`.
**Where**: `tests/stream-conversion-responses.test.ts`
**Depends on**: None
**Reuses**: `src/proxy/stream-conversion-responses.ts`

**Done when**:

- [ ] test builds a Responses API SSE mock
- [ ] `response.completed` contains input/cache/output usage
- [ ] final Anthropic `message_delta.usage` preserves those fields

**Verify**:

```bash
bun test tests/stream-conversion-responses.test.ts
```

### T5: Forward Responses API streaming usage

**What**: Update Responses stream converter usage mapping.
**Where**: `src/proxy/stream-conversion-responses.ts`
**Depends on**: T4
**Reuses**: existing `usage` extraction from `response.completed`

**Done when**:

- [ ] final `message_delta.usage` includes input/cache/output tokens when present
- [ ] fallback still uses zeros when usage is absent
- [ ] tests from T4 pass

**Verify**:

```bash
bun test tests/stream-conversion-responses.test.ts
```

### T6: Implement statusline formatter

**What**: Add pure formatter and unit tests.
**Where**: `src/statusline/format.ts`, `tests/statusline-format.test.ts`
**Depends on**: T2, T5
**Reuses**: no external deps

**Done when**:

- [ ] compact style renders provider, model, effort, context and limits
- [ ] minimal style renders model and context
- [ ] missing/null fields do not throw
- [ ] reset timestamps render as relative durations using injected `now`
- [ ] optional segments are dropped before truncation
- [ ] no secrets or raw state fields are rendered

**Verify**:

```bash
bun test tests/statusline-format.test.ts
```

### T7: Implement statusline state helpers

**What**: Add safe read/write/build helpers for local statusline state.
**Where**: `src/statusline/state.ts`, `tests/statusline-state.test.ts`
**Depends on**: T6
**Reuses**: `CONFIG_DIR`, `Provider`

**Done when**:

- [ ] state file path defaults to `~/.opencode-go-cli/statusline-state.json`
- [ ] env override supports temp test paths
- [ ] malformed/missing state returns null
- [ ] build helper includes provider, model, permission, proxy URL and timestamps
- [ ] tests assert tokens/API keys are not present in serialized state

**Verify**:

```bash
bun test tests/statusline-state.test.ts
```

### T8: Add statusline script entry

**What**: Add a script entry that reads stdin and prints formatted output.
**Where**: `src/statusline/script.ts`, `package.json`
**Depends on**: T6, T7
**Reuses**: formatter and state helpers

**Done when**:

- [ ] script reads all stdin
- [ ] script renders via `formatStatusline`
- [ ] invalid stdin does not print stack traces
- [ ] script prints exactly one line
- [ ] build emits a bundled `dist/statusline.js`
- [ ] package `files` already includes the bundled script through `dist`
- [ ] manual mock input works with `bun src/statusline/script.ts`

**Verify**:

```bash
echo '{"model":{"display_name":"Opus"},"context_window":{"used_percentage":25}}' | bun src/statusline/script.ts
bun run build
Test-Path .\dist\statusline.js
```

### T9: Implement installer and safe settings merge

**What**: Write statusline script and merge Claude user settings safely.
**Where**: `src/statusline/install.ts`, `tests/statusline-install.test.ts`
**Depends on**: T8
**Reuses**: path helpers, Node fs

**Done when**:

- [ ] installer copies bundled `dist/statusline.js` to
      `~/.opencode-go-cli/statusline.js`
- [ ] installer creates `~/.claude/settings.json` when missing
- [ ] installer adds `statusLine` when absent
- [ ] installer updates existing opencode-go statusline idempotently
- [ ] installer refuses foreign `statusLine` and returns manual snippet
- [ ] invalid settings JSON leaves file unchanged

**Verify**:

```bash
bun test tests/statusline-install.test.ts
```

### T10: Wire CLI flags and launch state write

**What**: Add user-facing flags and write state during `startFlow`.
**Where**: `src/cli.ts`, `src/constants.ts` only if needed
**Depends on**: T7, T9
**Reuses**: existing `startFlow`, `printHelp`, package version lookup

**Done when**:

- [ ] `--install-statusline` runs installer and exits
- [ ] `--statusline-snippet` prints manual JSON snippet and exits
- [ ] `printHelp` documents both flags
- [ ] `startFlow` writes statusline state after proxy URL is known
- [ ] state write failure is non-fatal and does not block Claude Code launch
- [ ] no auth token or API key is passed to state helpers

**Verify**:

```bash
bun run src/index.ts --statusline-snippet
bun run typecheck
```

### T11: Smoke test full feature

**What**: Run full automated and manual smoke checks.
**Where**: N/A
**Depends on**: T10
**Reuses**: all feature pieces

**Done when**:

- [ ] `bun test` passes
- [ ] `bun run typecheck` passes
- [ ] `bun run build` passes
- [ ] `dist/statusline.js` exists after build
- [ ] statusline script renders mock Claude Code JSON
- [ ] install command is idempotent in a temp settings file or manual sandbox
- [ ] real Claude Code session shows provider/model/context after one prompt

**Verify**:

```bash
bun test
bun run typecheck
bun run build
```

## Dependency Matrix

| Task | Depends on |
| --- | --- |
| T1 | None |
| T2 | T1 |
| T3 | T2 |
| T4 | None |
| T5 | T4 |
| T6 | T2, T5 |
| T7 | T6 |
| T8 | T6, T7 |
| T9 | T8 |
| T10 | T7, T9 |
| T11 | T10 |

## Granularity Check

| Task | Scope | Atomic enough |
| --- | --- | --- |
| T1 | one test file for Chat SSE usage | yes |
| T2 | one converter behavior | yes |
| T3 | one request conversion behavior | yes |
| T4 | one test file for Responses SSE usage | yes |
| T5 | one converter behavior | yes |
| T6 | one pure formatter module | yes |
| T7 | one state helper module | yes |
| T8 | one script entry | yes |
| T9 | one installer module | yes |
| T10 | CLI wiring only | yes |
| T11 | verification gate | yes |

## Implementation Notes

- Keep `src/statusline/*` modules small. If a file approaches 250 lines, split
  path/settings helpers out.
- Do not add dependencies for JSON parsing, colors or terminal width in MVP.
- Prefer plain text separators (` | `) over complex ANSI output.
- Do not read Claude transcript files in MVP.
- Do not write provider quotas into state unless a future reliable API exists.
- Treat `rate_limits` absence as normal, not an error.
