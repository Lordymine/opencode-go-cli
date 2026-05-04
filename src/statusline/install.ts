import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR } from "../constants.js";

export interface InstallStatuslineOptions {
  force?: boolean;
  configDir?: string;
  claudeSettingsFile?: string;
  runtimeCommand?: string;
  sourceScriptFile?: string;
}

export interface InstallStatuslineResult {
  status: "installed" | "already-installed" | "conflict";
  scriptPath: string;
  settingsPath: string;
  manualSnippet?: string;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function quotePath(path: string): string {
  return `"${normalizePath(path).replace(/"/g, '\\"')}"`;
}

export function getClaudeSettingsFile(): string {
  return process.env["OPENCODE_CLAUDE_SETTINGS_FILE_OVERRIDE"]
    ?? join(homedir(), ".claude", "settings.json");
}

export function getInstalledStatuslineScriptFile(configDir = CONFIG_DIR): string {
  return join(configDir, "statusline.js");
}

export function buildStatuslineCommand(scriptPath: string, runtimeCommand = "bun"): string {
  return `${runtimeCommand} ${quotePath(scriptPath)}`;
}

export function buildStatuslineConfig(command: string): Record<string, unknown> {
  return {
    type: "command",
    command,
    padding: 1,
    refreshInterval: 5,
  };
}

export function buildStatuslineSnippet(
  scriptPath = getInstalledStatuslineScriptFile(),
  runtimeCommand = "bun",
): string {
  return JSON.stringify(
    { statusLine: buildStatuslineConfig(buildStatuslineCommand(scriptPath, runtimeCommand)) },
    null,
    2,
  );
}

function findBundledStatuslineScript(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "statusline.js"),
    join(process.cwd(), "dist", "statusline.js"),
    join(here, "..", "..", "dist", "statusline.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function readSettings(settingsPath: string): Record<string, any> {
  if (!existsSync(settingsPath)) return {};

  try {
    return JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    throw new Error(`Invalid Claude Code settings JSON: ${settingsPath}`);
  }
}

function writeSettings(settingsPath: string, settings: Record<string, any>): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function copyScript(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  try {
    chmodSync(target, 0o755);
  } catch {}
}

function isOwnedStatusline(statusLine: unknown, scriptPath: string): boolean {
  const command = typeof (statusLine as any)?.command === "string"
    ? (statusLine as any).command
    : "";
  const normalizedCommand = normalizePath(command);
  const normalizedScript = normalizePath(scriptPath);

  return normalizedCommand.includes(normalizedScript)
    || normalizedCommand.includes(".opencode-go-cli/statusline.js");
}

export function installStatusline(
  options: InstallStatuslineOptions = {},
): InstallStatuslineResult {
  const configDir = options.configDir ?? CONFIG_DIR;
  const scriptPath = getInstalledStatuslineScriptFile(configDir);
  const settingsPath = options.claudeSettingsFile ?? getClaudeSettingsFile();
  const command = buildStatuslineCommand(scriptPath, options.runtimeCommand);
  const manualSnippet = buildStatuslineSnippet(scriptPath, options.runtimeCommand);
  const settings = readSettings(settingsPath);
  const existing = settings.statusLine;
  const source = options.sourceScriptFile ?? findBundledStatuslineScript();

  if (!source) {
    throw new Error("Bundled statusline script not found. Run `bun run build` first.");
  }

  if (existing && !options.force && !isOwnedStatusline(existing, scriptPath)) {
    copyScript(source, scriptPath);
    return { status: "conflict", scriptPath, settingsPath, manualSnippet };
  }

  copyScript(source, scriptPath);

  const nextStatusLine = buildStatuslineConfig(command);
  const alreadyInstalled = JSON.stringify(existing) === JSON.stringify(nextStatusLine);
  settings.statusLine = nextStatusLine;
  writeSettings(settingsPath, settings);

  return {
    status: alreadyInstalled ? "already-installed" : "installed",
    scriptPath,
    settingsPath,
    manualSnippet,
  };
}
