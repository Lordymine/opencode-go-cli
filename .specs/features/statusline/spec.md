# Claude Code Statusline - Specification

## Problem Statement

Hoje o `opencode-go` inicia o Claude Code com provider, modelo, proxy e modo
de permissao selecionados, mas o usuario nao tem uma linha curta e confiavel
mostrando esse estado durante a sessao. A issue pede modelo, effort, contexto
usado/restante, porcentagem de contexto e limites de 5h/semanal.

A pesquisa de 2026-05-03 mostrou que o Claude Code ja possui `statusLine`
nativo. O comando configurado recebe JSON via stdin com `model`,
`context_window`, `effort`, `thinking` e, em alguns casos, `rate_limits`. A
feature deve usar esses dados oficiais primeiro e evitar recriar calculos que
o Claude Code ja faz.

## Goals

- Adicionar uma statusline curta para sessoes iniciadas pelo `opencode-go`
- Mostrar provider, modelo, effort, contexto usado/restante e limites quando
  esses dados existirem
- Instalar a statusline sem sobrescrever configuracao existente do usuario
- Manter o render rapido, local e sem chamadas de rede
- Corrigir ou validar o caminho de `usage` do proxy para alimentar o
  `context_window` do Claude Code em streaming
- Ter testes unitarios para formatter, estado local, instalacao e conversores

## Out of Scope

- Scraping de cotas de OpenCode Go, OpenAI, Qwen ou Z.ai
- Inventar janela de 5h/semanal quando `rate_limits` nao vier do Claude Code
- Mostrar prompts, respostas, tokens brutos de conversa ou credenciais
- Chamar APIs externas a cada render da statusline
- Substituir statusline customizada do usuario sem opt-in explicito
- Criar UI interativa para personalizar tema/cores no MVP

## Research Summary

Fontes principais:

- `https://code.claude.com/docs/en/statusline`
- `https://code.claude.com/docs/en/settings`
- `https://platform.claude.com/docs/en/build-with-claude/streaming`
- `https://platform.openai.com/docs/api-reference/chat/create-chat-completion`
- `https://opencode.ai/zen/v1/models`

Descobertas relevantes:

- Claude Code configura statusline em `~/.claude/settings.json` ou em settings
  de projeto com `statusLine: { type: "command", command: "..." }`.
- O comando da statusline recebe JSON por stdin e imprime uma unica linha.
- Campos disponiveis incluem `model.id`, `model.display_name`,
  `context_window.used_percentage`, `context_window.remaining_percentage`,
  `context_window.context_window_size`, `context_window.current_usage`,
  `effort.level`, `thinking.enabled` e `rate_limits`.
- `effort`, `rate_limits` e alguns campos de contexto podem estar ausentes ou
  nulos; o formatter precisa tratar ausencia como normal.
- `rate_limits` aparece apenas para assinantes Claude.ai Pro/Max depois da
  primeira resposta da sessao; cada janela pode estar ausente.
- O endpoint de modelos do OpenCode Go retorna catalogo de IDs, mas nao traz
  limite de contexto ou cota por modelo. Portanto ele nao deve ser usado como
  fonte de contexto/cota no MVP.
- Em streaming Anthropic, `usage` pode aparecer em `message_start` e/ou
  `message_delta`. Para Chat Completions OpenAI-compativel, `stream_options:
  { include_usage: true }` pode adicionar um chunk final com usage total.

## Data Source Policy

Prioridade de dados:

1. JSON de stdin do Claude Code: fonte principal para modelo, effort, thinking,
   contexto e rate limits.
2. Estado local do `opencode-go`: fonte para provider, proxy, permission mode,
   hora de inicio e fallback de modelo.
3. Proxy: nao deve ser lido diretamente pela statusline; ele deve apenas
   devolver `usage` correto ao Claude Code.

Campos desconhecidos devem ser omitidos ou renderizados como `unknown` somente
quando isso for util. O padrao do MVP e omitir para manter a linha curta.

## User Stories

### P1: Formatter resiliente

As a developer, I want a pure formatter that receives Claude Code status JSON
and optional `opencode-go` state so the statusline can be tested without
running Claude Code.

Acceptance Criteria:

1. WHEN `model.display_name` exists THEN the output SHALL use it as the model
   label
2. WHEN only `model.id` exists THEN the output SHALL use `model.id`
3. WHEN local state has provider THEN the output SHALL include the provider
4. WHEN `effort.level` exists THEN the output SHALL include effort
5. WHEN context percentage exists THEN the output SHALL include `ctx N%`
6. WHEN remaining percentage exists THEN the output MAY include remaining
   percentage or remaining tokens
7. WHEN fields are missing or null THEN the formatter SHALL not throw
8. WHEN output exceeds the configured max width THEN it SHALL degrade by
   dropping optional segments before truncating

Independent Test: `bun test tests/statusline-format.test.ts`

### P1: Estado local minimo do opencode-go

As a developer, I want the launcher to write a small statusline state file so
the statusline can show provider and launch metadata that Claude Code does not
know.

Acceptance Criteria:

1. WHEN Claude Code is launched through `opencode-go` THEN a state file SHALL
   be written under `~/.opencode-go-cli/`
2. WHEN state is written THEN it SHALL include provider, model, proxy URL,
   permission mode, `startedAt` and CLI version
3. WHEN state is written THEN it SHALL NOT include auth tokens, API keys,
   prompts, responses or account identifiers
4. WHEN the statusline script cannot read state THEN it SHALL still render
   using stdin only

Independent Test: `bun test tests/statusline-state.test.ts`

### P1: Instalacao explicita e segura

As a user, I want to install the opencode-go statusline with an explicit command
so my existing Claude Code setup is not changed accidentally.

Acceptance Criteria:

1. WHEN the user runs `opencode-go --install-statusline` THEN the CLI SHALL
   write the statusline script to `~/.opencode-go-cli/statusline.js`
2. WHEN Claude user settings have no `statusLine` THEN the CLI SHALL add one
   pointing to that script
3. WHEN Claude user settings already point to the opencode-go script THEN the
   command SHALL update the script idempotently
4. WHEN Claude user settings contain another `statusLine` THEN the CLI SHALL
   refuse to overwrite it and print the manual config snippet
5. WHEN settings JSON is invalid THEN the CLI SHALL fail with a clear message
   and leave the file unchanged

Independent Test: `bun test tests/statusline-install.test.ts`

### P1: Context usage alimentado pelo proxy

As a user, I want the context percentage to be based on real usage whenever the
upstream provides usage data.

Acceptance Criteria:

1. WHEN a non-streaming Chat Completions response has usage THEN the proxy
   SHALL forward input and output tokens to Anthropic format
2. WHEN a streaming Chat Completions response has a final usage chunk THEN the
   stream converter SHALL forward input, cache and output usage when possible
3. WHEN a streaming Responses API response completes with usage THEN the stream
   converter SHALL forward input, cache and output usage when possible
4. WHEN usage is unavailable THEN the proxy SHALL keep zeros and the statusline
   SHALL avoid claiming exact context tokens
5. WHEN `stream: true` is sent to OpenAI-compatible providers THEN the request
   conversion SHOULD request final usage with `stream_options.include_usage`
   where accepted

Independent Tests:

- `bun test tests/request-conversion.test.ts`
- `bun test tests/stream-conversion.test.ts`
- `bun test tests/stream-conversion-responses.test.ts`

### P1: Rate limits honestos

As a user, I want 5h and weekly limit data only when the source is reliable so
the statusline does not mislead me.

Acceptance Criteria:

1. WHEN `rate_limits.five_hour.used_percentage` exists THEN the output SHALL
   include 5h usage
2. WHEN `rate_limits.five_hour.resets_at` exists THEN the output SHALL include
   reset time as a relative duration
3. WHEN `rate_limits.seven_day.used_percentage` exists THEN the output SHALL
   include weekly usage
4. WHEN `rate_limits` is absent THEN the output SHALL omit 5h and weekly quota
   segments
5. WHEN only local `startedAt` exists THEN the output SHALL NOT label it as
   quota reset

Independent Test: `bun test tests/statusline-format.test.ts`

### P2: Variantes simples

As a user, I want compact variants similar to minimal statuslines so I can keep
the terminal clean.

Acceptance Criteria:

1. WHEN style is `compact` THEN output SHOULD include provider, model, effort,
   context and available limits
2. WHEN style is `minimal` THEN output SHOULD include model and context only
3. WHEN style is not configured THEN `compact` SHALL be used
4. WHEN terminal width is small THEN optional segments SHALL be dropped first

Independent Test: `bun test tests/statusline-format.test.ts`

## Output Examples

With provider state and full Claude Code fields:

```text
OpenCode Go | Kimi K2.6 | high | ctx 42% | 5h 23% reset 1h12m | 7d 41%
```

Without rate limits:

```text
Qwen | qwen3-coder-plus | ctx 38%
```

Minimal style:

```text
gpt-5.4 | ctx 12%
```

## Edge Cases

- WHEN stdin is invalid JSON THEN script SHALL print a short fallback line or
  nothing, never stack traces
- WHEN state file is stale THEN formatter SHALL still trust Claude Code stdin
  for model/context
- WHEN provider state model differs from `stdin.model.id` THEN stdin wins for
  display and state remains fallback only
- WHEN `context_window.current_usage` is null before first API call THEN output
  SHALL omit token counts and MAY show `ctx 0%` only if percentage exists
- WHEN Claude Code settings are managed or read-only THEN install command SHALL
  print manual instructions instead of forcing writes
- WHEN user runs Claude Code directly without `opencode-go` THEN the script
  SHALL still render from stdin only

## Success Criteria

- [ ] `opencode-go --install-statusline` installs the script idempotently
- [ ] Existing user statusline is not overwritten
- [ ] Starting Claude Code through `opencode-go` writes safe local state
- [ ] Statusline renders with missing fields without throwing
- [ ] Context percentage uses Claude Code `context_window` data
- [ ] Rate limit fields are displayed only when `rate_limits` exists
- [ ] `bun test` and `bun run typecheck` pass
