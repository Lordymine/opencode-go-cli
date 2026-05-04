#!/usr/bin/env bun

import { formatStatusline, type StatuslineStyle } from "./format.js";
import { readStatuslineState } from "./state.js";
import { writeStatuslineDebugCapture } from "./debug.js";

function parseStyle(value: unknown): StatuslineStyle {
  return value === "minimal" ? "minimal" : "compact";
}

function parseMaxWidth(): number | undefined {
  const raw = process.env["OPENCODE_STATUSLINE_MAX_WIDTH"] ?? process.env["COLUMNS"];
  const value = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function parseInput(text: string): { input: unknown; parseOk: boolean } {
  try {
    const clean = text.replace(/^\uFEFF/, "").trim();
    return { input: clean ? JSON.parse(clean) : {}, parseOk: true };
  } catch {
    return { input: {}, parseOk: false };
  }
}

export async function runStatusline(): Promise<void> {
  try {
    const rawInput = await readStdin();
    const { input, parseOk } = parseInput(rawInput);
    const state = readStatuslineState();
    writeStatuslineDebugCapture({ rawInput, input, parseOk, state });
    const line = formatStatusline(input, state, {
      style: parseStyle(process.env["OPENCODE_STATUSLINE_STYLE"]),
      maxWidth: parseMaxWidth(),
    });
    process.stdout.write(`${line}\n`);
  } catch {
    process.stdout.write("\n");
  }
}

if (import.meta.main) {
  await runStatusline();
}
