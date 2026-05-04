import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStatuslineCommand,
  installStatusline,
} from "../src/statusline/install.js";

let tmpDir: string;
let configDir: string;
let settingsFile: string;
let sourceScript: string;

function readSettings(): any {
  return JSON.parse(readFileSync(settingsFile, "utf-8"));
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "opencode-statusline-install-"));
  configDir = join(tmpDir, "config");
  settingsFile = join(tmpDir, ".claude", "settings.json");
  sourceScript = join(tmpDir, "dist-statusline.js");
  mkdirSync(join(tmpDir, ".claude"), { recursive: true });
  writeFileSync(sourceScript, "#!/usr/bin/env bun\nconsole.log('ok');\n");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("installStatusline", () => {
  test("creates settings and installs the script when statusLine is absent", () => {
    const result = installStatusline({
      configDir,
      claudeSettingsFile: settingsFile,
      runtimeCommand: "bun",
      sourceScriptFile: sourceScript,
    });

    const scriptPath = join(configDir, "statusline.js");
    const settings = readSettings();

    expect(result.status).toBe("installed");
    expect(existsSync(scriptPath)).toBe(true);
    expect(settings.statusLine).toEqual({
      type: "command",
      command: buildStatuslineCommand(scriptPath, "bun"),
      padding: 1,
      refreshInterval: 5,
    });
  });

  test("is idempotent when settings already point to opencode-go script", () => {
    const first = installStatusline({
      configDir,
      claudeSettingsFile: settingsFile,
      runtimeCommand: "bun",
      sourceScriptFile: sourceScript,
    });
    const second = installStatusline({
      configDir,
      claudeSettingsFile: settingsFile,
      runtimeCommand: "bun",
      sourceScriptFile: sourceScript,
    });

    expect(first.status).toBe("installed");
    expect(second.status).toBe("already-installed");
  });

  test("refuses to overwrite a foreign statusLine", () => {
    const original = {
      statusLine: {
        type: "command",
        command: "node C:/Users/me/.claude/custom-statusline.js",
      },
    };
    writeFileSync(settingsFile, JSON.stringify(original, null, 2));

    const result = installStatusline({
      configDir,
      claudeSettingsFile: settingsFile,
      runtimeCommand: "bun",
      sourceScriptFile: sourceScript,
    });

    expect(result.status).toBe("conflict");
    expect(result.manualSnippet).toContain("statusLine");
    expect(readSettings()).toEqual(original);
  });

  test("invalid settings JSON fails without changing the file", () => {
    writeFileSync(settingsFile, "{ nope");

    expect(() =>
      installStatusline({
        configDir,
        claudeSettingsFile: settingsFile,
        sourceScriptFile: sourceScript,
      }),
    ).toThrow("Invalid Claude Code settings JSON");

    expect(readFileSync(settingsFile, "utf-8")).toBe("{ nope");
  });
});
