// ============================================================
// Z.ai Browser Login — captura token via DevTools Protocol
// ============================================================

import { mkdir, stat } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { CONFIG_DIR } from "../../constants.js";

const DEBUG_HOST = "127.0.0.1";
const DEBUG_PORT = 9222;
const STARTUP_TIMEOUT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 1_500;

const IS_WSL =
  process.platform === "linux" &&
  (process.env.WSL_DISTRO_NAME !== undefined || process.env.WSL_INTEROP !== undefined);

function getWindowsBrowserCandidates(): string[] {
  const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env["LOCALAPPDATA"] ?? join(process.env["USERPROFILE"] ?? "C:\\Users\\Default", "AppData", "Local");
  return [
    join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    join(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    join(localAppData, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
  ];
}

// When running inside WSL and no Linux browser is available, fall back to Windows hosts via /mnt/c.
const WSL_WINDOWS_BROWSER_CANDIDATES = [
  "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
  "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/mnt/c/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
  "/mnt/c/Program Files (x86)/BraveSoftware/Brave-Browser/Application/brave.exe",
] as const;

const MACOS_BROWSER_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Arc.app/Contents/MacOS/Arc",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
] as const;

const LINUX_BROWSER_COMMANDS = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "microsoft-edge",
  "microsoft-edge-stable",
  "brave-browser",
] as const;

interface DevtoolsTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

interface ZaiLoginResult {
  token: string;
  userId: string;
  browserPath: string;
  reusedSession: boolean;
}

export async function getZaiTokenViaBrowser(
  validateToken: (token: string) => Promise<string | null>,
  onStatus?: (message: string) => void,
): Promise<ZaiLoginResult> {
  const browserPath = await resolveBrowserPath();
  if (!browserPath) {
    throw new Error(
      "Nenhum navegador compatível encontrado. Instale Chrome/Edge/Chromium ou defina a variável BROWSER.",
    );
  }

  const profileDir = getBrowserProfileDir(browserPath);
  await mkdir(profileDir, { recursive: true });

  const existingToken = await tryGetExistingToken(validateToken);
  if (existingToken) {
    return {
      ...existingToken,
      browserPath,
      reusedSession: true,
    };
  }

  onStatus?.("Abrindo navegador para login no Z.ai...");
  const child = launchBrowser(browserPath, profileDir);

  try {
    await waitForDevtools(onStatus);
    const token = await waitForToken(onStatus);
    const userId = await validateToken(token);
    if (!userId) {
      throw new Error("Token capturado, mas inválido na validação do Z.ai.");
    }

    return {
      token,
      userId,
      browserPath,
      reusedSession: false,
    };
  } finally {
    try {
      child.kill();
    } catch {
      // ignora
    }
  }
}

async function tryGetExistingToken(
  validateToken: (token: string) => Promise<string | null>,
): Promise<Pick<ZaiLoginResult, "token" | "userId"> | null> {
  try {
    const resp = await fetch(`http://${DEBUG_HOST}:${DEBUG_PORT}/json/version`);
    if (!resp.ok) return null;
    const token = await fetchTokenFromTargets();
    if (!token) return null;
    const userId = await validateToken(token);
    if (!userId) return null;
    return { token, userId };
  } catch {
    return null;
  }
}

function launchBrowser(browserPath: string, profileDir: string): ChildProcess {
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    "--new-window",
    "https://chat.z.ai",
  ];

  return spawn(browserPath, args, {
    detached: true,
    stdio: "ignore",
  });
}

function getBrowserProfileDir(browserPath: string): string {
  if (IS_WSL && browserPath.toLowerCase().endsWith(".exe")) {
    return "/mnt/c/Users/Public/opencode-go-cli/zai-browser-profile";
  }
  return join(CONFIG_DIR, "zai-browser-profile");
}

async function resolveBrowserPath(): Promise<string | null> {
  // 1. BROWSER env var wins absolutely when set. The user knows what they want.
  const envBrowser = process.env.BROWSER?.trim();
  if (envBrowser) {
    const resolved = await resolveExecutable(envBrowser);
    if (resolved) return resolved;
    // Fall through if BROWSER points to something missing, so we still try sane defaults.
  }

  // 2. Platform-specific known install locations.
  if (process.platform === "win32") {
    for (const candidate of getWindowsBrowserCandidates()) {
      if (await fileExists(candidate)) return candidate;
    }
    return null;
  }

  if (process.platform === "darwin") {
    for (const candidate of MACOS_BROWSER_CANDIDATES) {
      if (await fileExists(candidate)) return candidate;
    }
    return null;
  }

  // 3. Linux / WSL: try PATH first.
  for (const cmd of LINUX_BROWSER_COMMANDS) {
    const resolved = await which(cmd);
    if (resolved) return resolved;
  }

  // 4. WSL fallback to Windows-side Chrome/Edge if no Linux browser is present.
  if (IS_WSL) {
    for (const candidate of WSL_WINDOWS_BROWSER_CANDIDATES) {
      if (await fileExists(candidate)) return candidate;
    }
  }

  return null;
}

async function resolveExecutable(input: string): Promise<string | null> {
  // Absolute / relative path — check it directly.
  if (input.includes("/") || input.includes("\\")) {
    return (await fileExists(input)) ? input : null;
  }
  // Bare command name — look it up in PATH.
  return which(input);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

async function which(command: string): Promise<string | null> {
  if (process.platform === "win32") {
    return whichWindows(command);
  }
  return whichUnix(command);
}

async function whichWindows(command: string): Promise<string | null> {
  const proc = spawn("where.exe", [command], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });

  let output = "";
  for await (const chunk of proc.stdout!) {
    output += chunk.toString();
  }

  const code = await new Promise<number>((resolve) => {
    proc.on("error", () => resolve(1));
    proc.on("close", (value) => resolve(value ?? 1));
  });

  if (code !== 0) return null;
  const first = output.split(/\r?\n/).find((line) => line.trim().length > 0);
  return first ? first.trim() : null;
}

async function whichUnix(command: string): Promise<string | null> {
  const proc = spawn("/bin/sh", ["-c", `command -v ${shellQuote(command)} 2>/dev/null || true`], {
    stdio: ["ignore", "pipe", "ignore"],
  });

  let output = "";
  for await (const chunk of proc.stdout!) {
    output += chunk.toString();
  }

  const code = await new Promise<number>((resolve) => {
    proc.on("error", () => resolve(1));
    proc.on("close", (value) => resolve(value ?? 1));
  });

  if (code !== 0) return null;
  const result = output.trim();
  return result || null;
}

async function waitForDevtools(onStatus?: (message: string) => void): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < STARTUP_TIMEOUT_MS) {
    try {
      const resp = await fetch(`http://${DEBUG_HOST}:${DEBUG_PORT}/json/version`);
      if (resp.ok) return;
    } catch {
      // esperando subir
    }
    onStatus?.("Esperando o navegador iniciar...");
    await sleep(500);
  }
  throw new Error("Não consegui conectar ao navegador automatizado. Veja se o Edge/Chrome abriu direito.");
}

async function waitForToken(onStatus?: (message: string) => void): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < LOGIN_TIMEOUT_MS) {
    const token = await fetchTokenFromTargets();
    if (token) return token;
    onStatus?.("Faça login com Google na janela aberta... estou esperando o token aparecer.");
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("Tempo esgotado esperando login no Z.ai.");
}

async function fetchTokenFromTargets(): Promise<string | null> {
  const targets = await listTargets();
  const pageTargets = targets.filter(
    (target) =>
      target.type === "page" &&
      target.webSocketDebuggerUrl &&
      (target.url.startsWith("https://chat.z.ai") || target.url === "about:blank"),
  );

  for (const target of pageTargets) {
    const token = await evaluateOnTarget(target.webSocketDebuggerUrl!, `(() => {
      try {
        return window.localStorage.getItem("token");
      } catch {
        return null;
      }
    })()`);
    if (typeof token === "string" && token.length > 50) {
      return token;
    }
  }

  return null;
}

async function listTargets(): Promise<DevtoolsTarget[]> {
  const resp = await fetch(`http://${DEBUG_HOST}:${DEBUG_PORT}/json/list`);
  if (!resp.ok) throw new Error(`DevTools list falhou: ${resp.status}`);
  return await resp.json() as DevtoolsTarget[];
}

async function evaluateOnTarget(webSocketUrl: string, expression: string): Promise<unknown> {
  const ws = new WebSocket(webSocketUrl);

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("Falha ao conectar no DevTools WebSocket")), { once: true });
  });

  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      const id = 1;
      const timeout = setTimeout(() => reject(new Error("Timeout avaliando expressão no navegador")), 5_000);

      ws.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          if (msg.id !== id) return;
          clearTimeout(timeout);
          if (msg.error) {
            reject(new Error(msg.error.message ?? "Erro desconhecido no Runtime.evaluate"));
            return;
          }
          resolve(msg.result?.result?.value ?? null);
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
        }
      });

      ws.send(JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: {
          expression,
          returnByValue: true,
          awaitPromise: true,
        },
      }));
    });

    return result;
  } finally {
    try {
      ws.close();
    } catch {
      // ignora
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
