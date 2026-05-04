# Statusline - memoria para futuro PRD

## Contexto

Issue aberta: https://github.com/Lordymine/opencode-go-cli/issues/3

Pedido original:

- Modelo
- Effort
- Contexto usado
- Contexto restante
- Porcentagem de uso do contexto
- Tempo restante para reset da sessao de 5h
- Porcentagem de uso da sessao de 5h
- Porcentagem de uso da cota semanal
- Variantes mais simples, parecidas com Mclaude

Decisao atual: manter a issue #3 aberta. Vamos planejar em outra sessao antes de implementar.

## Objetivo futuro

Criar um PRD para adicionar uma statusline inline ao Claude Code quando o usuario iniciar o Claude via `opencode-go`.

A statusline deve ajudar o usuario a entender rapidamente qual provider/modelo esta em uso, quanto contexto ainda resta e, quando possivel, quanto falta para reset de limites de uso.

## Ponto tecnico importante

Claude Code possui suporte proprio a statusline via configuracao `statusLine`, normalmente apontando para um comando/script que recebe dados por stdin e imprime uma linha curta.

Referencia pesquisada:

- https://code.claude.com/docs/en/statusline

O PRD deve investigar se a melhor integracao e:

- gerar/instalar um script de statusline em `~/.opencode-go-cli/`;
- configurar o Claude Code para usar esse script;
- passar dados via env vars ao processo do Claude Code;
- ou manter um arquivo de estado local atualizado pelo proxy/CLI para o script ler.

## Dados que parecem faceis

Estes dados ja existem ou podem ser passados pela CLI:

- provider selecionado (`opencode`, `openai`, `qwen`, `zai`);
- modelo selecionado;
- modo de permissao selecionado;
- porta/base URL do proxy;
- hora em que a sessao foi iniciada;
- possivel inicio de janela de 5h, se adotarmos uma regra local.

## Dados que precisam investigacao

Estes dados talvez nao estejam disponiveis diretamente e precisam de descoberta:

- contexto usado e contexto restante por turno;
- limite real de contexto por modelo;
- effort real usado pelo Claude Code ou pelo provider;
- tempo real restante para reset de sessao de 5h;
- porcentagem real de uso da cota semanal;
- diferenca entre limites do OpenCode Go, OpenAI/Codex, Qwen OAuth e Z.ai.

Nao assumir esses valores sem fonte. Se nao houver API confiavel, o PRD deve propor fallback honesto, por exemplo mostrar "unknown", estimativa local ou ocultar o campo.

## Possiveis fontes de dados

- Estado da CLI em memoria durante `startFlow`.
- Config salvo em `~/.opencode-go-cli/config.json`.
- Logs/metadata do proxy em `src/proxy/server.ts`.
- Campos `usage` nas respostas convertidas:
  - `src/proxy/response-conversion.ts`
  - `src/proxy/response-conversion-responses.ts`
  - `src/proxy/stream-conversion.ts`
  - `src/proxy/stream-conversion-responses.ts`
  - `src/proxy/qwen-handler.ts`
  - `src/proxy/zai-handler.ts`
- Banco local Qwen em `~/.opencode-go-cli/qwen.db`, se a statusline precisar mostrar estado de conta/lock.
- Documentacao oficial do Claude Code statusline.

## Riscos e cuidados

- Nao inventar numeros de cota semanal ou reset de 5h se o provider nao expuser esses dados.
- Nao gravar prompts, respostas completas, tokens ou credenciais em arquivo de estado da statusline.
- Nao quebrar usuarios que ja tenham uma statusline propria no Claude Code.
- Nao sobrescrever configuracao global do Claude Code sem confirmacao clara.
- Evitar chamadas de rede extras a cada render da statusline.
- Evitar dependencia nova se um script simples Node/Bun resolver.

## Ideia de MVP

MVP possivel para discutir no PRD:

- comando `opencode-go --install-statusline`;
- script pequeno em `~/.opencode-go-cli/statusline.js`;
- arquivo de estado em `~/.opencode-go-cli/statusline-state.json`;
- CLI escreve estado inicial quando inicia Claude Code;
- proxy atualiza ultimos contadores de uso quando receber respostas com `usage`;
- statusline mostra uma linha compacta:

```text
OpenCode Go | kimi-k2.6 | ctx 42% | session 01:23 left
```

Campos desconhecidos devem sumir ou aparecer como `unknown`, dependendo do design escolhido.

## Perguntas para o PRD

1. A statusline deve ser instalada automaticamente ou somente com flag explicita?
2. Deve modificar configuracao global do Claude Code ou apenas uma instalacao isolada?
3. Como preservar statusline existente do usuario?
4. Quais providers conseguem informar uso real de contexto/cota?
5. A sessao de 5h e regra do Claude/OpenAI/OpenCode Go ou deve ser configuravel?
6. Qual formato visual minimo e quais variantes valem a pena?
7. Como testar sem depender de Claude Code real em CI?

## Atualizacao 2026-05-03

Arquivos de planejamento criados:

- `.specs/features/statusline/spec.md`
- `.specs/features/statusline/design.md`
- `.specs/features/statusline/tasks.md`

Decisao tecnica principal:

- usar o JSON de stdin do Claude Code como fonte primaria para modelo, effort,
  contexto e `rate_limits`;
- usar `~/.opencode-go-cli/statusline-state.json` apenas para provider,
  permission mode, proxy URL e metadados de launch;
- nao consultar APIs externas nem inventar cota de 5h/semanal quando
  `rate_limits` estiver ausente;
- corrigir/testar propagacao de `usage` do proxy em streaming antes de confiar
  em contexto para todos os providers.

## Estado atual

Nada implementado ainda. O PRD/spec foi criado e a proxima etapa e executar as
tasks atomicas começando pelos testes de usage em streaming.
