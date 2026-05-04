// ============================================================
// CLI — entry point, argument parsing, interactive prompts, spawn
// ============================================================

import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import * as p from "@clack/prompts";
import {
  QWEN_MODELS,
  ZAI_MODELS,
  DEFAULT_PROXY_PORT,
  PROXY_PORT_FALLBACK_ATTEMPTS,
  PROVIDERS,
  buildQwenChatCompletionsUrl,
  buildQwenHeaders,
  type Model,
  type PermissionMode,
  type Provider,
} from "./constants.js";
import {
  clearOpenCodeModelsCache,
  getOpenCodeModels,
} from "./providers/opencode-models.js";
import {
  clearOpenAIModelsCache,
  getOpenAIModels,
} from "./providers/openai-models.js";
import { refreshStatuslineCodexUsage } from "./providers/openai-usage.js";
import { getConfig, saveConfig, resetAll } from "./config.js";
import { resolveClaudePath } from "./path.js";
import { buildClaudeEnv } from "./env.js";
import { startProxy } from "./proxy/server.js";
import { silenceLogger } from "./logger.js";
import { createAuthorizationFlow, exchangeAuthorizationCode } from "./auth/oauth.js";
import { startLocalOAuthServer } from "./auth/server.js";
import { qwenLogin } from "./auth/qwen/device-flow.js";
import { checkAndRefreshAccount } from "./auth/qwen/refresh.js";
import { getZaiTokenViaBrowser } from "./auth/zai/browser-login.js";
import { validateZaiToken } from "./proxy/zai-handler.js";
import { buildStatuslineSnippet, installStatusline } from "./statusline/install.js";
import {
  clearStatuslineDebugFiles,
  disableStatuslineDebug,
  enableStatuslineDebug,
  getStatuslineDebugLatestFile,
  getStatuslineDebugLogFile,
  isStatuslineDebugEnabled,
  readLatestStatuslineDebugCapture,
} from "./statusline/debug.js";
import { buildStatuslineState, writeStatuslineState } from "./statusline/state.js";
import {
  countAccounts,
  getAccountById,
  getAccountByEmail,
  listAccounts,
  removeAccount,
  updateAccount,
  type Account,
} from "./db/accounts.js";
import { getActiveModelLocks } from "./db/locks.js";

async function getPackageVersion(): Promise<string> {
  const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json() as {
    version?: string;
  };
  return packageJson.version ?? "0.0.0";
}

function printStatuslineDebugCapture(): void {
  const capture = readLatestStatuslineDebugCapture();

  if (!capture) {
    console.log("No statusline debug capture found yet.");
    console.log(`Latest file: ${getStatuslineDebugLatestFile()}`);
    return;
  }

  console.log(`Statusline debug: ${isStatuslineDebugEnabled() ? "enabled" : "disabled"}`);
  console.log(`Captured at: ${capture.capturedAt}`);
  console.log(`Parse OK: ${capture.parseOk}`);
  console.log(`Top-level keys: ${capture.topLevelKeys.join(", ") || "(none)"}`);
  console.log(`Has context_window: ${capture.contextWindow ? "yes" : "no"}`);
  console.log(`Has rate_limits: ${capture.rateLimits ? "yes" : "no"}`);
  if (capture.state?.lastUsage) {
    console.log(`Local usage fallback: ${capture.state.lastUsage.contextTokens} context tokens`);
  } else {
    console.log("Local usage fallback: none");
  }
  if (capture.state?.rateLimits) {
    const fiveHour = capture.state.rateLimits.five_hour?.used_percentage;
    const sevenDay = capture.state.rateLimits.seven_day?.used_percentage;
    console.log(
      `Local Codex usage: 5h ${fiveHour ?? "?"}% | 7d ${sevenDay ?? "?"}%`,
    );
  } else {
    console.log("Local Codex usage: none");
  }
  console.log(`Latest file: ${getStatuslineDebugLatestFile()}`);
  console.log("");
  console.log(JSON.stringify(capture.input, null, 2));
}

// ─── Auth helpers ─────────────────────────────────────────

async function setupApiKey(): Promise<string> {
  const apiKey = await p.text({
    message: "Enter your OpenCode Go API key:",
    placeholder: "sk-opencode-...",
    validate: (value) => {
      if (!value || value.length < 10) return "Please enter a valid API key";
    },
  });

  if (p.isCancel(apiKey)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  const config = getConfig();
  config.apiKey = apiKey as string;
  saveConfig(config);

  p.log.success("API key saved!");
  return apiKey as string;
}

async function setupOpenAIOAuth(): Promise<boolean> {
  const spinner = p.spinner();
  spinner.start("Starting authorization flow...");

  const flow = await createAuthorizationFlow();
  const server = await startLocalOAuthServer(flow.state);

  spinner.stop("Authorization server ready");

  try {
    await open(flow.url);
  } catch {
    // ignore if browser can't be opened
  }

  if (!server.ready) {
    server.close();
    p.log.error("OAuth server failed to start. Port 1455 may be in use.");
    p.log.info(`Visit this URL manually: ${flow.url}`);
    return false;
  }

  p.log.info("Waiting for authorization...");
  p.log.info(`Or visit: ${flow.url}`);

  const result = await server.waitForCode();
  server.close();

  if (!result) {
    p.log.error("Authorization timeout. Please try again.");
    return false;
  }

  const tokens = await exchangeAuthorizationCode(result.code, flow.pkce.verifier);

  if (tokens.type === "success") {
    const config = getConfig();
    config.openaiTokens = {
      access: tokens.access,
      refresh: tokens.refresh,
      expiresAt: tokens.expires,
      accountId: tokens.accountId,
      planType: tokens.planType,
    };
    saveConfig(config);
    p.log.success("OpenAI authenticated!");
    return true;
  }

  p.log.error("Authorization failed. Please try again.");
  return false;
}

// ─── Qwen helpers ─────────────────────────────────────────

async function setupQwenOAuth(): Promise<boolean> {
  const spinner = p.spinner();
  spinner.start("Requesting device code from Qwen...");

  try {
    const account = await qwenLogin({
      onDeviceCode: async (device) => {
        spinner.stop("Device code received");
        p.log.info(
          `Open in your browser: ${device.verification_uri_complete ?? device.verification_uri}`,
        );
        p.log.info(`User code: ${device.user_code}`);
        try {
          await open(device.verification_uri_complete ?? device.verification_uri);
        } catch {
          // ignore — user can open manually
        }
        spinner.start("Waiting for authorization…");
      },
      onPollTick: (secsLeft) => {
        const m = Math.floor(secsLeft / 60);
        const s = secsLeft % 60;
        spinner.message(
          `Waiting for authorization… ${m > 0 ? `${m}m ${s}s` : `${s}s`} remaining`,
        );
      },
    });
    spinner.stop(
      `Qwen account saved: ${account.email ?? account.id.slice(0, 8)} (priority ${account.priority})`,
    );
    return true;
  } catch (err) {
    spinner.stop("Qwen authorization failed");
    p.log.error(err instanceof Error ? err.message : String(err));
    return false;
  }
}

function formatExpiry(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return "expired";
  if (diff < 60_000) return `${Math.ceil(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.ceil(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.ceil(diff / 3_600_000)}h`;
  return `${Math.ceil(diff / 86_400_000)}d`;
}

// ─── Z.ai helpers ─────────────────────────────────────────

async function setupZaiToken(): Promise<boolean> {
  const spinner = p.spinner();
  spinner.start("Preparando login automatizado do Z.ai...");

  try {
    const result = await getZaiTokenViaBrowser(validateZaiToken, (message) => {
      spinner.message(message);
    });

    const config = getConfig();
    config.zaiToken = result.token;
    saveConfig(config);

    spinner.stop(
      result.reusedSession
        ? `Z.ai já estava logado! Token validado e salvo (${result.userId.slice(0, 8)}...)`
        : `Login do Z.ai concluído! Token capturado e salvo (${result.userId.slice(0, 8)}...)`,
    );

    p.log.info(`Navegador usado: ${result.browserPath}`);
    return true;
  } catch (err) {
    spinner.stop("Falha no login automatizado do Z.ai");
    p.log.error(err instanceof Error ? err.message : String(err));
    p.log.info("Se der ruim com o navegador automático, aí sim a gente parte pro plano B manual.");
    return false;
  }
}

function printQwenAccountTable(accounts: Account[]): void {
  if (accounts.length === 0) {
    console.log("\nNo Qwen accounts found. Run `opencode-go --qwen-login` to add one.\n");
    return;
  }
  console.log("");
  console.log(
    `  ${"#".padEnd(3)} ${"ID".padEnd(10)} ${"Email".padEnd(32)} ${"Status".padEnd(13)} ${"Pri".padEnd(4)} Expires`,
  );
  console.log("  " + "─".repeat(78));
  accounts.forEach((acc, i) => {
    const id = acc.id.slice(0, 8);
    const email = (acc.email ?? acc.display_name ?? "(no email)").slice(0, 30).padEnd(32);
    const status = !acc.is_active
      ? "disabled".padEnd(13)
      : acc.test_status.padEnd(13);
    console.log(
      `  ${String(i + 1).padEnd(3)} ${id.padEnd(10)} ${email} ${status} ${String(acc.priority).padEnd(4)} ${formatExpiry(acc.expires_at)}`,
    );
    for (const lock of getActiveModelLocks(acc.id)) {
      const m = lock.model === "__all" ? "ALL models" : lock.model;
      console.log(`         ⚠ locked: ${m} until ${formatExpiry(lock.locked_until)}`);
    }
    if (acc.last_error) {
      console.log(`         ✗ last error (${acc.error_code}): ${acc.last_error.slice(0, 60)}`);
    }
  });
  console.log("");
}

async function testQwenAccount(acc: Account): Promise<void> {
  const label = acc.email ?? acc.id.slice(0, 8);
  const spinner = p.spinner();
  spinner.start(`Testing ${label}…`);
  try {
    const refreshed = await checkAndRefreshAccount(acc);
    const start = Date.now();
    const resp = await fetch(buildQwenChatCompletionsUrl(refreshed.resource_url), {
      method: "POST",
      headers: buildQwenHeaders(refreshed.access_token, false),
      body: JSON.stringify({
        model: "qwen3-coder-flash",
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 5,
        stream: false,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const latency = Date.now() - start;
    if (resp.ok) {
      updateAccount(acc.id, {
        test_status: "active",
        last_error: null,
        error_code: null,
      });
      spinner.stop(`${label} OK (${latency}ms)`);
    } else {
      const errText = await resp.text();
      updateAccount(acc.id, {
        test_status: "unavailable",
        last_error: errText.slice(0, 300),
        error_code: resp.status,
        last_error_at: new Date().toISOString(),
      });
      spinner.stop(`${label} FAIL ${resp.status}: ${errText.slice(0, 60)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateAccount(acc.id, {
      test_status: "unavailable",
      last_error: msg.slice(0, 300),
      error_code: 0,
      last_error_at: new Date().toISOString(),
    });
    spinner.stop(`${label} ERROR: ${msg.slice(0, 60)}`);
  }
}

// ─── Interactive menus ────────────────────────────────────

function getProviderStatus(): {
  opencode: string;
  openai: string;
  qwen: string;
  zai: string;
} {
  const config = getConfig();
  const opencode = config.apiKey
    ? `✓ ${config.apiKey.slice(0, 12)}...`
    : "not configured";
  const openai = config.openaiTokens
    ? "✓ logged in"
    : "not logged in";
  const qwenCount = countAccounts();
  const qwen =
    qwenCount === 0
      ? "no accounts"
      : `${qwenCount} account${qwenCount === 1 ? "" : "s"}`;
  const zai = config.zaiToken
    ? "✓ token set"
    : "not configured";
  return { opencode, openai, qwen, zai };
}

async function interactiveMain(): Promise<void> {
  const status = getProviderStatus();

  p.intro("OpenCode Go CLI");

  const action = await p.select({
    message: "What do you want to do?",
    options: [
      { value: "start", label: "Start Claude Code", hint: "launch with a model" },
      { value: "settings", label: "Settings", hint: "providers, keys, login" },
    ],
  });

  if (p.isCancel(action)) {
    p.cancel("Bye!");
    process.exit(0);
  }

  if (action === "settings") {
    await settingsMenu();
    return;
  }

  // ─── Start flow ───
  await startFlow();
}

async function settingsMenu(): Promise<void> {
  const status = getProviderStatus();
  const config = getConfig();

  const setting = await p.select({
    message: "Settings:",
    options: [
      {
        value: "opencode-key",
        label: `OpenCode Go — API key`,
        hint: status.opencode,
      },
      {
        value: "openai-login",
        label: `OpenAI — Login with OAuth`,
        hint: status.openai,
      },
      ...(config.openaiTokens
        ? [{
            value: "openai-logout" as const,
            label: "OpenAI — Logout",
            hint: "remove saved tokens",
          }]
        : []),
      {
        value: "qwen-login",
        label: "Qwen — Add account (device flow)",
        hint: status.qwen,
      },
      {
        value: "zai-login",
        label: "Z.ai — Login no navegador",
        hint: status.zai,
      },
      ...(countAccounts() > 0
        ? [
            {
              value: "qwen-list" as const,
              label: "Qwen — List accounts",
              hint: "status, locks, last error",
            },
            {
              value: "qwen-test" as const,
              label: "Qwen — Test all accounts",
              hint: "validate tokens",
            },
          ]
        : []),
      {
        value: "reset",
        label: "Reset all",
        hint: "delete all configuration",
      },
      { value: "back", label: "← Back" },
    ],
  });

  if (p.isCancel(setting)) {
    p.cancel("Bye!");
    process.exit(0);
  }

  if (setting === "opencode-key") {
    await setupApiKey();
    p.log.info("Run opencode-go again to start Claude Code.");
    process.exit(0);
  }

  if (setting === "openai-login") {
    await setupOpenAIOAuth();
    p.log.info("Run opencode-go again to start Claude Code.");
    process.exit(0);
  }

  if (setting === "openai-logout") {
    const config = getConfig();
    delete config.openaiTokens;
    if (config.provider === "openai") config.provider = "opencode";
    saveConfig(config);
    p.log.success("OpenAI tokens removed.");
    process.exit(0);
  }

  if (setting === "qwen-login") {
    await setupQwenOAuth();
    p.log.info("Run opencode-go again to start Claude Code.");
    process.exit(0);
  }

  if (setting === "zai-login") {
    await setupZaiToken();
    p.log.info("Run opencode-go again to start Claude Code.");
    process.exit(0);
  }

  if (setting === "qwen-list") {
    printQwenAccountTable(listAccounts());
    process.exit(0);
  }

  if (setting === "qwen-test") {
    for (const acc of listAccounts()) {
      await testQwenAccount(acc);
    }
    process.exit(0);
  }

  if (setting === "reset") {
    const confirm = await p.confirm({
      message: "Delete all configuration? This cannot be undone.",
      initialValue: false,
    });
    if (p.isCancel(confirm) || !confirm) {
      p.log.info("Cancelled.");
      process.exit(0);
    }
    resetAll();
    p.log.success("All configuration deleted (config, Qwen DB, Z.ai profile).");
    process.exit(0);
  }

  // back
  await interactiveMain();
}

async function selectProvider(): Promise<Provider> {
  const status = getProviderStatus();

  const provider = await p.select({
    message: "Select provider:",
    options: [
      {
        value: "opencode" as Provider,
        label: "OpenCode Go",
        hint: status.opencode,
      },
      {
        value: "openai" as Provider,
        label: "OpenAI (ChatGPT Plus/Pro)",
        hint: status.openai,
      },
      {
        value: "qwen" as Provider,
        label: "Qwen (OAuth device flow)",
        hint: status.qwen,
      },
      {
        value: "zai" as Provider,
        label: "Z.ai (free GLM models)",
        hint: status.zai,
      },
    ],
  });

  if (p.isCancel(provider)) {
    p.cancel("Bye!");
    process.exit(0);
  }

  return provider as Provider;
}

async function resolveModelsForProvider(
  provider: Provider,
  options: { refresh?: boolean } = {},
): Promise<Model[]> {
  if (provider === "openai") {
    const config = getConfig();
    const spinner = p.spinner();
    spinner.start(options.refresh ? "Refreshing OpenAI models..." : "Loading OpenAI models...");
    const result = await getOpenAIModels({
      accessToken: config.openaiTokens?.access,
      accountId: config.openaiTokens?.accountId,
      refresh: options.refresh,
    });
    if (result.source === "network") {
      spinner.stop(`Loaded ${result.models.length} models from ChatGPT`);
    } else if (result.source === "cache") {
      spinner.stop(`Loaded ${result.models.length} cached OpenAI models`);
    } else {
      spinner.stop(`Using built-in OpenAI fallback (${result.models.length} models)`);
    }
    return result.models;
  }
  if (provider === "qwen") return QWEN_MODELS;
  if (provider === "zai") return ZAI_MODELS;

  const spinner = p.spinner();
  spinner.start(options.refresh ? "Refreshing OpenCode models..." : "Loading OpenCode models...");
  const result = await getOpenCodeModels({ refresh: options.refresh });
  if (result.source === "network") {
    spinner.stop(`Loaded ${result.models.length} models from opencode.ai`);
  } else if (result.source === "cache") {
    spinner.stop(`Loaded ${result.models.length} cached models`);
  } else {
    spinner.stop(`Using built-in fallback (${result.models.length} models)`);
  }
  return result.models;
}

async function selectModel(provider: Provider): Promise<string> {
  const config = getConfig();
  const models = await resolveModelsForProvider(provider);

  const model = await p.select({
    message: "Select model:",
    options: models.map((m) => ({
      value: m.id,
      label: m.name,
      hint: m.description,
    })),
    initialValue: config.lastModel,
  });

  if (p.isCancel(model)) {
    p.cancel("Bye!");
    process.exit(0);
  }

  return model as string;
}

async function selectPermissionMode(): Promise<PermissionMode> {
  const mode = await p.select({
    message: "Permission mode:",
    options: [
      {
        value: "default" as PermissionMode,
        label: "Default",
        hint: "asks permission for everything",
      },
      {
        value: "acceptEdits" as PermissionMode,
        label: "Accept edits",
        hint: "auto-approve file edits, ask for commands",
      },
      {
        value: "auto" as PermissionMode,
        label: "Auto mode",
        hint: "classifier reviews actions (experimental)",
      },
      {
        value: "bypassPermissions" as PermissionMode,
        label: "Bypass permissions",
        hint: "skip all checks — use with caution",
      },
    ],
  });

  if (p.isCancel(mode)) {
    p.cancel("Bye!");
    process.exit(0);
  }

  return mode as PermissionMode;
}

function buildPermissionArgs(mode: PermissionMode): string[] {
  switch (mode) {
    case "default":
      return [];
    case "acceptEdits":
      return ["--permission-mode", "acceptEdits"];
    case "auto":
      return ["--permission-mode", "auto", "--enable-auto-mode"];
    case "bypassPermissions":
      return ["--dangerously-skip-permissions"];
  }
}

async function ensureProviderAuth(provider: Provider): Promise<boolean> {
  const config = getConfig();

  if (provider === "openai") {
    if (config.openaiTokens) return true;
    p.log.warn("Not logged in to OpenAI.");
    const shouldAuth = await p.confirm({
      message: "Login with OpenAI now?",
      initialValue: true,
    });
    if (p.isCancel(shouldAuth) || !shouldAuth) return false;
    return await setupOpenAIOAuth();
  }

  if (provider === "qwen") {
    if (countAccounts() > 0) return true;
    p.log.warn("No Qwen accounts configured.");
    const shouldAuth = await p.confirm({
      message: "Login with Qwen now?",
      initialValue: true,
    });
    if (p.isCancel(shouldAuth) || !shouldAuth) return false;
    return await setupQwenOAuth();
  }

  if (provider === "zai") {
    if (config.zaiToken) return true;
    p.log.warn("No Z.ai token configured.");
    const shouldAuth = await p.confirm({
      message: "Fazer login no Z.ai agora?",
      initialValue: true,
    });
    if (p.isCancel(shouldAuth) || !shouldAuth) return false;
    return await setupZaiToken();
  }

  if (config.apiKey) return true;
  p.log.warn("No OpenCode Go API key configured.");
  const shouldSetup = await p.confirm({
    message: "Set up API key now?",
    initialValue: true,
  });
  if (p.isCancel(shouldSetup) || !shouldSetup) return false;
  await setupApiKey();
  return true;
}

async function startFlow(
  providerOverride?: Provider,
  modelOverride?: string,
  permissionOverride?: PermissionMode,
  portOverride?: number,
  claudePassthroughArgs: string[] = [],
): Promise<void> {
  // 1. Provider
  const provider = providerOverride ?? await selectProvider();

  // 2. Auth check
  if (!(await ensureProviderAuth(provider))) {
    p.cancel("Authentication required.");
    process.exit(1);
  }

  // 3. Model
  const model = modelOverride ?? await selectModel(provider);

  // 4. Permission mode (only interactive if not overridden)
  const permMode = permissionOverride ?? await selectPermissionMode();

  // 5. Save config
  const config = getConfig();
  config.provider = provider;
  config.lastModel = model;
  const preferredPort = portOverride ?? config.proxyPort ?? DEFAULT_PROXY_PORT;
  saveConfig(config);

  // 6. Resolve auth token
  //    Qwen picks per-request inside the rotator; we pass a placeholder so
  //    Claude Code has something to set ANTHROPIC_AUTH_TOKEN to. The proxy
  //    ignores whatever comes in this header for Qwen requests.
  const freshConfig = getConfig();
  const authToken =
    provider === "openai"
      ? freshConfig.openaiTokens!.access
      : provider === "qwen"
        ? "qwen-rotated"
        : provider === "zai"
          ? "zai-token"
          : freshConfig.apiKey!;

  // 7. Start proxy + Claude Code
  const proxyPort = await startProxy(preferredPort, provider, PROXY_PORT_FALLBACK_ATTEMPTS);
  const proxyUrl = `http://localhost:${proxyPort}`;

  try {
    writeStatuslineState(buildStatuslineState({
      provider,
      model,
      permissionMode: permMode,
      proxyUrl,
      cliVersion: await getPackageVersion(),
    }));
  } catch (err) {
    p.log.warn(
      `Statusline state was not written: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (provider === "openai") {
    const usageConfig = getConfig();
    void refreshStatuslineCodexUsage({
      accessToken: usageConfig.openaiTokens!.access,
      accountId: usageConfig.openaiTokens!.accountId,
    });
  }

  silenceLogger();

  const permArgs = buildPermissionArgs(permMode);
  await runClaudeCode(model, proxyUrl, authToken, permArgs, claudePassthroughArgs);
  process.exit(0);
}

// ─── Claude Code launcher ─────────────────────────────────

async function runClaudeCode(
  model: string,
  baseUrl: string,
  authToken: string,
  extraArgs: string[],
  claudePassthroughArgs: string[],
): Promise<number> {
  const config = getConfig();
  const provider = config.provider || "opencode";

  if (provider === "openai") {
    p.log.success(`Provider: OpenAI`);
    p.log.success(`Model: ${model}`);
  } else if (provider === "qwen") {
    p.log.success(`Provider: Qwen (rotating across ${countAccounts()} account(s))`);
    p.log.success(`Model: ${model}`);
  } else if (provider === "zai") {
    p.log.success(`Provider: Z.ai (free GLM models)`);
    p.log.success(`Model: ${model}`);
  } else {
    p.log.success(`Provider: OpenCode Go`);
    p.log.success(`Model: ${model}`);
  }

  if (extraArgs.length > 0) {
    p.log.info(`Flags: ${extraArgs.join(" ")}`);
  }

  if (claudePassthroughArgs.length > 0) {
    p.log.info(`Claude passthrough: ${claudePassthroughArgs.join(" ")}`);
  }

  const claudePath = resolveClaudePath();
  const env = buildClaudeEnv(authToken, model, baseUrl);
  const spawnArgs = ["--model", model, ...extraArgs, ...claudePassthroughArgs];

  const spinner = p.spinner();
  spinner.start(`Starting Claude Code with ${model}...`);
  spinner.stop(`Launching Claude Code with ${model}`);

  return new Promise<number>((resolve) => {
    const child = spawn(claudePath, spawnArgs, {
      stdio: "inherit",
      env,
    });

    child.on("error", (err) => {
      p.log.error(`Failed to start Claude Code: ${err.message}`);
      resolve(1);
    });

    child.on("close", (code) => {
      resolve(code ?? 0);
    });
  });
}

// ─── Help ─────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
OpenCode Go CLI — Use OpenCode Go or OpenAI models with Claude Code

Usage: opencode-go [options] [-- <claude-args...>]

Interactive (no args):
  opencode-go               Select provider, model, and permission mode

Options:
  --provider <name>         Provider: opencode (default), openai, qwen, or zai
  --model <id>              Model ID (skip model selection)
  --permission-mode <mode>  default | acceptEdits | auto | bypassPermissions
  --setup                   Configure OpenCode Go API key
  --oauth-login             Authenticate with OpenAI (ChatGPT Plus/Pro)
  --oauth-logout            Remove OpenAI tokens
  --qwen-login              Add a Qwen account via OAuth device flow
  --qwen-list               List saved Qwen accounts and their status
  --qwen-remove <id|email>  Remove a Qwen account
  --qwen-test               Test all Qwen accounts against the API
  --zai-login               Login no Z.ai via navegador automatizado
  --reset                   Delete all configuration
  --list                    List available models
  --proxy                   Start proxy server only (for testing)
  --install-statusline      Install opencode-go statusLine for Claude Code
  --statusline-snippet      Print manual statusLine settings JSON
  --statusline-debug-on     Capture raw Claude Code statusLine JSON locally
  --statusline-debug-off    Stop statusLine debug capture
  --statusline-debug-show   Print the latest captured statusLine JSON
  --statusline-debug-clear  Delete captured statusLine debug files
  --port <port>             Proxy port (interactive mode auto-falls back; --proxy defaults to ${DEFAULT_PROXY_PORT})
  --version, -v             Show version
  --help, -h                Show this help
  --                        Pass remaining args directly to Claude Code

Providers:
  opencode    OpenCode Go models (MiniMax, Kimi, GLM)
  openai      OpenAI models via OAuth (GPT-5.x family)
  qwen        Qwen models via OAuth (qwen3-coder-plus/flash) with
              multi-account rotation and automatic fallback
  zai         Z.ai free GLM models (glm-4.7, glm-5-turbo, glm-5.1, glm-5)

Permission modes:
  default             Ask permission for everything
  acceptEdits         Auto-approve file edits, ask for commands
  auto                Classifier reviews actions (experimental)
  bypassPermissions   Skip all permission checks

Examples:
  opencode-go
  opencode-go --provider openai --model gpt-5.4
  opencode-go --model minimax-m2.7 --permission-mode acceptEdits
  opencode-go --provider openai --model gpt-5.2-codex --permission-mode auto
  opencode-go --list --provider openai
  opencode-go --install-statusline
  opencode-go --statusline-debug-on
  `);
}

// ─── Main ─────────────────────────────────────────────────

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const passthroughIndex = rawArgs.indexOf("--");
  const claudePassthroughArgs = passthroughIndex === -1 ? [] : rawArgs.slice(passthroughIndex + 1);
  const args = passthroughIndex === -1 ? rawArgs : rawArgs.slice(0, passthroughIndex);

  // ─── Direct flags (exit immediately) ───

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`opencode-go v${await getPackageVersion()}`);
    process.exit(0);
  }

  if (args.includes("--statusline-snippet")) {
    console.log(buildStatuslineSnippet());
    process.exit(0);
  }

  if (args.includes("--statusline-debug-on")) {
    enableStatuslineDebug();
    p.log.success("Statusline debug enabled.");
    p.log.info(`Latest JSON: ${getStatuslineDebugLatestFile()}`);
    p.log.info(`History: ${getStatuslineDebugLogFile()}`);
    p.log.info("Run Claude Code and then inspect with `opencode-go --statusline-debug-show`.");
    process.exit(0);
  }

  if (args.includes("--statusline-debug-off")) {
    disableStatuslineDebug();
    p.log.success("Statusline debug disabled.");
    process.exit(0);
  }

  if (args.includes("--statusline-debug-clear")) {
    clearStatuslineDebugFiles();
    p.log.success("Statusline debug captures cleared.");
    process.exit(0);
  }

  if (args.includes("--statusline-debug-show")) {
    printStatuslineDebugCapture();
    process.exit(0);
  }

  if (args.includes("--install-statusline")) {
    p.intro("OpenCode Go CLI");
    try {
      const result = installStatusline();

      if (result.status === "conflict") {
        p.log.warn("Claude Code already has a custom statusLine. I did not overwrite it.");
        p.log.info(`Script installed at: ${result.scriptPath}`);
        p.log.info("Add this manually if you want to switch to opencode-go:");
        console.log(result.manualSnippet);
        process.exit(1);
      }

      p.log.success(
        result.status === "already-installed"
          ? "Statusline already installed."
          : "Statusline installed.",
      );
      p.log.info(`Settings: ${result.settingsPath}`);
      p.log.info(`Script: ${result.scriptPath}`);
    } catch (err) {
      p.log.error(err instanceof Error ? err.message : String(err));
      p.log.info("Manual Claude Code settings snippet:");
      console.log(buildStatuslineSnippet());
      process.exit(1);
    }
    process.exit(0);
  }

  if (args.includes("--setup")) {
    p.intro("OpenCode Go CLI");
    await setupApiKey();
    process.exit(0);
  }

  if (args.includes("--oauth-login")) {
    p.intro("OpenCode Go CLI");
    await setupOpenAIOAuth();
    process.exit(0);
  }

  if (args.includes("--oauth-logout")) {
    const config = getConfig();
    delete config.openaiTokens;
    if (config.provider === "openai") config.provider = "opencode";
    saveConfig(config);
    p.log.success("OpenAI tokens removed.");
    process.exit(0);
  }

  if (args.includes("--qwen-login")) {
    p.intro("OpenCode Go CLI");
    const ok = await setupQwenOAuth();
    process.exit(ok ? 0 : 1);
  }

  if (args.includes("--qwen-list")) {
    printQwenAccountTable(listAccounts());
    process.exit(0);
  }

  if (args.includes("--qwen-test")) {
    const targetIdx = args.indexOf("--qwen-test");
    const maybeId = args[targetIdx + 1];
    const accounts: Account[] =
      maybeId && !maybeId.startsWith("--")
        ? [getAccountById(maybeId) ?? getAccountByEmail(maybeId)].filter(
            (a): a is Account => a !== null,
          )
        : listAccounts();
    if (accounts.length === 0) {
      console.log("\nNo Qwen accounts to test.\n");
      process.exit(0);
    }
    for (const acc of accounts) {
      await testQwenAccount(acc);
    }
    process.exit(0);
  }

  if (args.includes("--qwen-remove")) {
    const idx = args.indexOf("--qwen-remove");
    const idOrEmail = args[idx + 1];
    if (!idOrEmail || idOrEmail.startsWith("--")) {
      p.log.error("Usage: opencode-go --qwen-remove <id-or-email>");
      process.exit(1);
    }
    const account =
      getAccountById(idOrEmail) ?? getAccountByEmail(idOrEmail);
    if (!account) {
      p.log.error(`Qwen account not found: ${idOrEmail}`);
      process.exit(1);
    }
    const label = account.email ?? account.id.slice(0, 8);
    const confirm = await p.confirm({
      message: `Remove Qwen account ${label}?`,
      initialValue: false,
    });
    if (p.isCancel(confirm) || !confirm) {
      p.log.info("Cancelled.");
      process.exit(0);
    }
    removeAccount(account.id);
    p.log.success(`Removed: ${label}`);
    process.exit(0);
  }

  if (args.includes("--zai-login")) {
    p.intro("OpenCode Go CLI");
    const ok = await setupZaiToken();
    process.exit(ok ? 0 : 1);
  }

  if (args.includes("--reset")) {
    resetAll();
    p.log.success("Configuration deleted (config, Qwen DB, Z.ai profile).");
    process.exit(0);
  }

  if (args.includes("--list")) {
    const providerIndex = args.indexOf("--provider");
    const providerName = (providerIndex !== -1 ? args[providerIndex + 1] : "opencode") as Provider;
    const refresh = args.includes("--refresh-models");
    const models = await resolveModelsForProvider(providerName, { refresh });
    const label =
      providerName === "openai"
        ? "OpenAI (ChatGPT/Codex)"
        : providerName === "qwen"
          ? "Qwen (OAuth)"
          : providerName === "zai"
            ? "Z.ai (free GLM)"
            : "OpenCode Go";
    console.log(`\nAvailable models (${label}):\n`);
    for (const model of models) {
      console.log(`  ${model.id.padEnd(28)} ${model.name}`);
      if (model.description) {
        console.log(`  ${"".padEnd(28)} ${model.description}`);
      }
      console.log();
    }
    process.exit(0);
  }

  if (args.includes("--refresh-models") && !args.includes("--list")) {
    const providerIndex = args.indexOf("--provider");
    const providerName = (providerIndex !== -1 ? args[providerIndex + 1] : "opencode") as Provider;

    if (providerName === "openai") {
      const config = getConfig();
      if (!config.openaiTokens) {
        p.log.error("Not authenticated with OpenAI. Run 'opencode-go --oauth-login' first.");
        process.exit(1);
      }
      const spinner = p.spinner();
      spinner.start("Refreshing OpenAI models from ChatGPT...");
      clearOpenAIModelsCache();
      const result = await getOpenAIModels({
        accessToken: config.openaiTokens.access,
        accountId: config.openaiTokens.accountId,
        refresh: true,
      });
      if (result.source === "network") {
        spinner.stop(`Cached ${result.models.length} OpenAI models.`);
        process.exit(0);
      }
      spinner.stop("Refresh failed — using fallback.");
      process.exit(1);
    }

    if (providerName === "qwen" || providerName === "zai") {
      p.log.info(`${providerName} models are static in this CLI.`);
      process.exit(0);
    }

    const spinner = p.spinner();
    spinner.start("Refreshing OpenCode models from opencode.ai...");
    clearOpenCodeModelsCache();
    const result = await getOpenCodeModels({ refresh: true });
    if (result.source === "network") {
      spinner.stop(`Cached ${result.models.length} models.`);
      process.exit(0);
    }
    spinner.stop("Refresh failed — using fallback.");
    process.exit(1);
  }

  // ─── Proxy-only mode ───

  const config = getConfig();

  if (args.includes("--proxy")) {
    const providerIndex = args.indexOf("--provider");
    const provider: Provider = (providerIndex !== -1 && args[providerIndex + 1] as Provider) || "opencode";
    const portIndex = args.indexOf("--port");
    const port = portIndex !== -1 ? parseInt(args[portIndex + 1]) : (config.proxyPort || DEFAULT_PROXY_PORT);

    if (provider === "openai" && !config.openaiTokens) {
      console.error("[cli] Not authenticated with OpenAI. Run 'opencode-go --oauth-login' first.");
      process.exit(1);
    }
    if (provider === "qwen" && countAccounts() === 0) {
      console.error("[cli] No Qwen accounts. Run 'opencode-go --qwen-login' first.");
      process.exit(1);
    }
    if (provider === "zai" && !config.zaiToken) {
      console.error("[cli] No Z.ai token. Run 'opencode-go --zai-login' first.");
      process.exit(1);
    }
    if (provider === "opencode" && !config.apiKey) {
      console.error("[cli] No API key configured. Run 'opencode-go --setup' first.");
      process.exit(1);
    }
    await startProxy(port, provider, PROXY_PORT_FALLBACK_ATTEMPTS);
    await new Promise(() => {}) as Promise<never>;
    return;
  }

  // ─── Parse optional CLI overrides ───

  const providerIndex = args.indexOf("--provider");
  const providerOverride: Provider | undefined =
    providerIndex !== -1 && args[providerIndex + 1]
      ? args[providerIndex + 1] as Provider
      : undefined;

  if (providerOverride && !PROVIDERS.includes(providerOverride)) {
    p.log.error(`Unknown provider: ${providerOverride}. Options: ${PROVIDERS.join(", ")}`);
    process.exit(1);
  }

  const modelArgIndex = args.indexOf("--model");
  const modelOverride: string | undefined =
    modelArgIndex !== -1 && args[modelArgIndex + 1]
      ? args[modelArgIndex + 1]
      : undefined;

  const permIndex = args.indexOf("--permission-mode");
  const permOverride: PermissionMode | undefined =
    permIndex !== -1 && args[permIndex + 1]
      ? args[permIndex + 1] as PermissionMode
      : args.includes("--dangerously-skip-permissions")
        ? "bypassPermissions"
        : undefined;

  const portIndex = args.indexOf("--port");
  const portOverride: number | undefined =
    portIndex !== -1 && args[portIndex + 1]
      ? parseInt(args[portIndex + 1])
      : undefined;

  // ─── If any overrides, skip interactive menu ───

  const hasOverrides = providerOverride || modelOverride || permOverride;

  if (hasOverrides) {
    // Validate model if both provider and model specified
    if (modelOverride && providerOverride) {
      const modelList = await resolveModelsForProvider(providerOverride);
      if (!modelList.find((m) => m.id === modelOverride)) {
        p.log.error(`Unknown model: ${modelOverride}`);
        p.log.info(`Run 'opencode-go --list --provider ${providerOverride}' to see available models.`);
        process.exit(1);
      }
    }

    p.intro("OpenCode Go CLI");
    await startFlow(
      providerOverride ?? "opencode",
      modelOverride,
      permOverride,
      portOverride,
      claudePassthroughArgs,
    );
    return;
  }

  // ─── Fully interactive ───
  await interactiveMain();
}
