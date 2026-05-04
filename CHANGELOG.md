# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

No unreleased changes yet.

## [1.0.8] - 2026-05-04

### Added
- Claude Code statusline installer via `opencode-go --install-statusline`,
  plus `--statusline-snippet` and debug helpers for inspecting raw statusline
  payloads.
- Safe local statusline state under `~/.opencode-go-cli/statusline-state.json`
  with provider, model, permission mode, proxy URL, CLI version, latest usage
  fallback, and Codex usage windows without storing prompts or credentials.
- Dynamic OpenAI/Codex model discovery from ChatGPT's Codex model registry,
  cached locally in `~/.opencode-go-cli/openai-models.json` with a static GPT
  fallback when the registry is unavailable.
- Codex usage refresh from ChatGPT's usage endpoint so the statusline can show
  current 5h and 7d usage windows when the OpenAI provider returns them.
- Statusline formatter, installer, state, debug, OpenAI model, OpenAI usage,
  and streaming usage test coverage.

### Changed
- The build now emits both `dist/index.js` and `dist/statusline.js`.
- OpenAI OAuth now preserves account and plan claims from the ID token when
  present, allowing account-scoped model and usage requests.
- `--refresh-models` can refresh either OpenCode Go or OpenAI/Codex model
  caches depending on `--provider`.

### Fixed
- Streaming OpenAI-compatible requests now ask for final usage chunks with
  `stream_options.include_usage`.
- Chat Completions and Responses API conversions now forward input, output,
  cache creation, and cache read usage to Anthropic format where available.
- The proxy records safe local usage fallback data for the statusline when
  Claude Code sends null context percentages for custom providers.

## [1.0.7] - 2026-05-03

### Added
- Dynamic OpenCode Go model catalog. The CLI now fetches the live model list
  from `https://opencode.ai/zen/v1/models` on demand instead of relying on a
  hand-maintained hardcoded array, so newly released models (e.g. `kimi-k2.6`,
  `qwen3.6-plus`, `big-pickle`, new free-tier entries) show up automatically.
  Results are cached on disk in `~/.opencode-go-cli/opencode-models.json`
  with a 1-hour TTL and fall back to a built-in snapshot when the endpoint
  is unreachable. New `--refresh-models` flag forces a cache bypass.
- `src/providers/opencode-models.ts` with `getOpenCodeModels()` and
  `humanizeModelId()`. Covered by 14 unit tests that exercise network,
  cache, refresh, offline, fallback, and normalization paths.

### Changed
- `--list` (without `--provider`, or with `--provider opencode`) now shows
  the live list. Other providers (`openai`, `qwen`, `zai`) continue to use
  their existing static model lists.
- The built-in OpenCode Go fallback in `src/constants.ts` was expanded from
  5 entries to 13 so it remains useful offline.

### Fixed
- Assistant `thinking` and `redacted_thinking` blocks are now preserved as
  OpenAI-compatible `reasoning_content` when converting Anthropic history for
  Chat Completions providers. Assistant tool-call messages also receive a
  non-empty placeholder when no reasoning block is present, preventing
  Moonshot/Kimi-style extended-thinking backends from rejecting replayed
  tool-use turns.
- The local Bun proxy now sets `idleTimeout: 255` so long upstream LLM streams
  are not cut off by Bun's 10-second default while a remote provider is still
  thinking.

## [1.0.6] - 2026-04-15

### Fixed
- Z.ai browser login now works on native Windows, macOS, and Linux. The previous browser discovery assumed WSL-style `/mnt/c/...` paths and shelled out to `bash -lc` for PATH lookups, so it only worked inside WSL. The new `resolveBrowserPath()` in `src/auth/zai/browser-login.ts` detects `process.platform`, uses real Windows paths resolved from `%ProgramFiles%`, `%ProgramFiles(x86)%`, and `%LOCALAPPDATA%`, macOS `.app` bundle paths, and Linux PATH-based discovery. `BROWSER` env var is now honored with absolute priority and validated with `fs.stat` instead of executing `--version`.
- `--reset` and the interactive Settings → reset option now wipe the entire CLI state directory. Previously `deleteConfig()` only removed `config.json`, leaving Qwen accounts in `qwen.db`, the Z.ai browser profile, installations, and other persisted state behind. The new `resetAll()` in `src/config.ts` closes the SQLite handle first (required on Windows to release the file lock) and then removes `~/.opencode-go-cli/` recursively.

### Changed
- `whichUnix()` now uses `/bin/sh -c` instead of `bash -lc`, so PATH lookups for the Z.ai browser work on minimal Linux environments without bash.
- WSL environments are now detected via `WSL_DISTRO_NAME` / `WSL_INTEROP` and still fall back to Windows-side Chrome / Edge via `/mnt/c` when no Linux browser is installed.

## [1.0.5] - 2026-04-15

### Added
- Qwen provider with OAuth device flow login, saved account management, health checks, and request-time account rotation.
- Z.ai provider with browser-assisted login and support for free GLM models.
- Local SQLite storage for Qwen accounts, rotation settings, and model cooldown locks under `~/.opencode-go-cli/`.
- New CLI commands: `--qwen-login`, `--qwen-list`, `--qwen-test`, `--qwen-remove`, and `--zai-login`.
- Rotator test coverage for fallback rules, model locks, fill-first selection, and round-robin sticky rotation.

### Changed
- Expanded the interactive settings flow and `--list` output to cover OpenCode Go, OpenAI, Qwen, and Z.ai providers.
- Updated the release documentation to describe the new providers, auth flows, and local account storage model.
- The default `bun test` script now runs the full test suite, including the new Qwen rotation tests.

### Fixed
- Restored the full OpenAI OAuth and Qwen token endpoint URLs in the shared constants used by the build output.

## [1.0.4] - 2026-04-07

### Added
- Passthrough args: arguments after `--` are forwarded directly to Claude Code (e.g. `opencode-go -- --dangerously-load-development-channels server:bridge`).
- Model: GLM-5.1 (`glm-5.1`) from Zhipu AI.
- Environment variable `CLAUDE_CODE_NO_FLICKER=1` injected into Claude Code to suppress terminal flicker.

## [1.0.3] - 2026-03-28

### Fixed
- Corrected the published CLI so `opencode-go --version` reports the package version instead of a hardcoded `1.0.0` string.
- Enabled sequential proxy port fallback in `--proxy` mode so new CLI sessions continue on the next free local port instead of stopping at `EADDRINUSE`.
- Rebuilt the distributable package so the published `dist/index.js` matches the repository source for release `1.0.3`.

## [1.0.2] - 2026-03-28

### Fixed
- Added automatic proxy port fallback in interactive mode so a second CLI instance can start on the next free local port instead of failing on `EADDRINUSE`.
- Preserved explicit proxy-only behavior while improving the startup flow to inject the final bound proxy URL into Claude Code.
- Added test coverage for preferred-port selection and sequential fallback candidates.

### Changed
- Clarified project and package documentation to explain the new interactive port fallback behavior and the meaning of `proxyPort` as the preferred local proxy port.

## [1.0.1] - 2026-03-28

### Changed
- Published the first tagged release of the CLI.
- Synced the repository documentation with the current modular codebase, interactive CLI flow, permission modes, dual provider routing, and WebSearch interception architecture.
- Clarified Bun as the official runtime for the published CLI package.
- Refined npm package metadata and limited the published package to the required distributable files.

## [1.0.0] - 2026-03-27

### Added
- Initial release of the OpenCode Go CLI as a Bun-based modular TypeScript project.
- Anthropic-compatible local proxy that translates requests to OpenCode Go Chat Completions.
- Interactive CLI foundation with setup, model selection, and Claude Code launch orchestration.
- Test suite covering helpers, request conversion, response conversion, logger behavior, and environment setup.
- Repository documentation set including `README.md`, `CLAUDE.md`, and `.specs/` architecture and feature docs.
