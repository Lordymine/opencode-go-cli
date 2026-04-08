# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Projeto

CLI em TypeScript (Bun) que gerencia assinatura OpenCode Go e lança Claude Code com variáveis de ambiente corretas. O projeto tem dois modos de operação distintos — é importante entender qual está rodando.

## Comandos

```bash
bun run src/index.ts          # Desenvolvimento (executa direto)
bun run build                 # Build para produção (dist/)
bun run typecheck             # Type check
bun test                      # Suite de testes (49 testes)
opencode-go --setup           # Setup inicial
opencode-go --oauth-login     # Login OpenAI via OAuth
opencode-go --oauth-logout    # Remove tokens OpenAI
opencode-go --proxy --port 8080  # Modo proxy isolado (porta explícita)
opencode-go                       # Modo interativo com fallback automático de porta
opencode-go --permission-mode acceptEdits  # Com modo de permissão
opencode-go --dangerously-skip-permissions  # Bypass de permissões
```

## Arquitetura

### O CLI é modular — dois modos de operação

**Modo interativo (padrão):** menu Start/Settings → Provider (OpenCode Go / OpenAI) → Model → Permission Mode → tenta subir o proxy na porta preferida/default e, se ela estiver ocupada, faz fallback automático para a próxima porta livre antes de lançar o Claude Code.

**Modo proxy (`--proxy`):** sobe um servidor HTTP em uma porta explícita/configurada (ex.: `--port 8080`) que traduz requisições Anthropic ↔ OpenAI. O Claude Code aponta pra esse proxy via `ANTHROPIC_BASE_URL`.

### Fluxo interativo

```
opencode-go (sem args)
  → "What do you want to do?" → Start / Settings
    → Start:
        → Select provider (OpenCode Go / OpenAI)
        → Auth check (API key ou OAuth)
        → Select model
        → Select permission mode (default / acceptEdits / auto / bypassPermissions)
        → Start proxy (porta preferida com fallback automático) + launch Claude Code
    → Settings:
        → Set API key / Login OpenAI / Logout OpenAI / Reset all
```

### Permission modes

| Modo | Flag Claude Code | Comportamento |
|------|-----------------|---------------|
| `default` | (nenhuma) | Pede permissão pra tudo |
| `acceptEdits` | `--permission-mode acceptEdits` | Auto-aprova edits, pede pra comandos |
| `auto` | `--permission-mode auto --enable-auto-mode` | Classificador avalia ações (experimental) |
| `bypassPermissions` | `--dangerously-skip-permissions` | Pula todas as verificações |

### Fluxo do proxy — dois caminhos de conversão

O proxy roteia automaticamente baseado no provider:

**OpenCode Go (Chat Completions):**
```
Claude Code → POST /v1/messages (Anthropic)
  → convertAnthropicRequestToOpenAI() → POST /v1/chat/completions
  → streamOpenAIToAnthropic() ou convertOpenAIResponseToAnthropic()
  → Claude Code
```

**OpenAI/Codex (Responses API):**
```
Claude Code → POST /v1/messages (Anthropic)
  → convertAnthropicRequestToResponses() → POST /backend-api/codex/responses
  → streamResponsesToAnthropic() ou convertResponsesApiToAnthropic()
  → Claude Code
```

### Módulos

| Arquivo | Responsabilidade |
|---------|----------------|
| `src/cli.ts` | Entry point, menus interativos (Start/Settings), permission modes, spawn do Claude Code |
| `src/proxy/server.ts` | Bun.serve + roteamento dual (Chat Completions / Responses API) + WebSearch interception |
| `src/proxy/request-conversion.ts` | Anthropic → OpenAI Chat Completions (OpenCode Go) |
| `src/proxy/response-conversion.ts` | Chat Completions → Anthropic non-stream (OpenCode Go) |
| `src/proxy/stream-conversion.ts` | Chat Completions SSE → Anthropic SSE (OpenCode Go) |
| `src/proxy/request-conversion-responses.ts` | Anthropic → OpenAI Responses API (OpenAI/Codex) |
| `src/proxy/response-conversion-responses.ts` | Responses API → Anthropic non-stream (OpenAI/Codex) |
| `src/proxy/stream-conversion-responses.ts` | Responses API SSE → Anthropic SSE (OpenAI/Codex) |
| `src/proxy/websearch-interceptor.ts` | Intercepta requests de `web_search` server tool, executa via SearXNG, retorna response Anthropic |
| `src/search/searxng.ts` | Gerenciamento do container Docker SearXNG (start, health check) + execução de buscas |
| `src/logger.ts` | Logging com níveis DEBUG/INFO/WARN/ERROR. Quando silenciado + DEBUG=1, escreve em `~/.opencode-go-cli/proxy.log` |
| `src/env.ts` | buildClaudeEnv, cleanupClaudeCodeVars |
| `src/auth/oauth.ts` | PKCE, exchange, refresh, JWT decode |
| `src/auth/server.ts` | Servidor local OAuth callback (porta 1455) |

### Conversões importantes

**Chat Completions (provider: opencode):**

- `convertAnthropicRequestToOpenAI()` — traduz Anthropic (`/v1/messages`) → Chat Completions (`/v1/chat/completions`). System como `role: "system"`, tools com wrapper `function:{}`.

- `streamOpenAIToAnthropic()` — lê SSE sem eventos nomeados (`data: {"choices":[...]}`) e emite SSE Anthropic.

**Responses API (provider: openai):**

- `convertAnthropicRequestToResponses()` — traduz Anthropic → Responses API. System como `instructions` (top-level), mensagens como `input[]` tipado, tools flat sem wrapper, tool_results como `function_call_output`.

- `streamResponsesToAnthropic()` — lê SSE com eventos nomeados (`event: response.output_text.delta`) e emite SSE Anthropic. Eventos: `response.created`, `response.output_text.delta`, `response.function_call_arguments.delta`, `response.completed`.

- `convertResponsesApiToAnthropic()` / `convertOpenAIResponseToAnthropic()` — versões não-streaming das conversões.

**Codex stream=true:** O backend Codex sempre requer `stream: true`. Quando o Claude Code pede non-streaming, o proxy consome a stream internamente e monta a response JSON completa antes de devolver.

### WebSearch interception

O proxy intercepta requests que contêm server tools `web_search_*` antes de enviar ao upstream. O fluxo:

```
Claude Code → POST /v1/messages (com tool web_search_20250305)
  → hasWebSearchTool() detecta a tool
  → extractQuery() extrai a query da mensagem
  → search() consulta SearXNG local (localhost:8888)
  → handleWebSearch() monta response Anthropic (server_tool_use + web_search_tool_result + text)
  → Claude Code recebe os resultados como se viesse da API Anthropic
```

O SearXNG roda como container Docker (`opencode-searxng`, porta 8888). É iniciado automaticamente em background quando o proxy sobe. Settings gerados em `~/.opencode-go-cli/searxng/settings.yml`.

### Variáveis de ambiente injetadas no Claude Code

| Variável | Valor |
|----------|-------|
| `ANTHROPIC_BASE_URL` | `http://localhost:PORT` (o proxy local) |
| `ANTHROPIC_AUTH_TOKEN` | API key do OpenCode Go |
| `ANTHROPIC_MODEL` | Modelo selecionado |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` |
| `CLAUDE_CODE_NO_FLICKER` | `1` |
| `CLAUDE_CODE_SUBAGENT_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL` | Mesmo modelo (garante que todo sub-agente usa o mesmo) |

### Config

`~/.opencode-go-cli/config.json` — guarda apiKey, provider, openaiTokens, lastModel e proxyPort. `proxyPort` é a porta preferida do proxy local; no modo interativo, a porta efetiva pode mudar se houver conflito.

Diretório `~/.opencode-go-cli/searxng/settings.yml` — settings do SearXNG (gerado automaticamente).

### Servidor HTTP

Usa `Bun.serve` (não Node.js `http`). Isso é importante: o runtime é Bun, não Node. Verifique que qualquer build/config usa `--target bun`.

## Pontos de atenção

- **Bun como runtime** — o shebang é `#!/usr/bin/env bun`, o tsconfig usa `bun-types`. Não use APIs Node que não existam no Bun.
- **SSE streaming** — a implementação de streaming é o coração do projeto. Qualquer alteração na conversão de blocos precisa respeitar o protocolo SSE do Anthropic (eventos nomeados, `data:` prefixado).
- **Dois formatos de SSE** — Chat Completions usa `data:` sem evento nomeado; Responses API usa `event: response.xxx` + `data:`. O proxy tem um stream converter pra cada formato.
- **Conversão de tool_calls** — o índice do bloco no Anthropic é sequencial (0, 1, 2...) mas no OpenAI pode começar em qualquer número. O código mantém `openaiToolIndexToBlockIndex` (Chat Completions) ou `toolCallBlocks` (Responses API) pra mapear.
- **Text block vs tool block** — se um tool_call aparecer, o text block que estava aberto precisa ser fechado antes do tool block começar. O código trata isso na ordem de chegada dos chunks.
- **Logger silenciado em modo embutido** — quando o proxy roda junto com Claude Code, `silenceLogger()` é chamado após `startProxy()` pra não poluir o terminal interativo. No modo `--proxy` isolado, os logs aparecem normalmente. Quando silenciado + `DEBUG=1`, logs vão para arquivo `~/.opencode-go-cli/proxy.log`.
- **WebSearch interception** — o proxy intercepta requests com server tools `web_search_*` e executa localmente via SearXNG. Se Docker não estiver disponível, o interception é desabilitado silenciosamente.
