# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

## [Unreleased]

### Added
- Passthrough args: arguments after `--` are forwarded directly to Claude Code (e.g. `opencode-go -- --dangerously-load-development-channels server:bridge`).
- Model: GLM-5.1 (`glm-5.1`) from Zhipu AI.
- Environment variable `CLAUDE_CODE_NO_FLICKER=1` injected into Claude Code to suppress terminal flicker.
