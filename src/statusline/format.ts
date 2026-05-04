import type { Provider } from "../constants.js";
import type { StatuslineState } from "./state.js";

export type StatuslineStyle = "compact" | "minimal";

export interface FormatStatuslineOptions {
  style?: StatuslineStyle;
  now?: Date;
  maxWidth?: number;
}

interface Segment {
  text: string;
  optional?: boolean;
}

const PROVIDER_LABELS: Record<Provider, string> = {
  opencode: "OpenCode Go",
  openai: "OpenAI",
  qwen: "Qwen",
  zai: "Z.ai",
};

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percent(value: number): string {
  return `${Math.round(value)}%`;
}

function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(Math.max(0, Math.round(value)));
}

function usageTokens(context: Record<string, any>): number | null {
  const current = record(context.current_usage);
  const input = numberValue(current.input_tokens);
  if (input === null) {
    const totalInput = numberValue(context.total_input_tokens);
    const totalOutput = numberValue(context.total_output_tokens) ?? 0;
    if (totalInput === null) return null;
    return totalInput + totalOutput;
  }
  const created = numberValue(current.cache_creation_input_tokens) ?? 0;
  const read = numberValue(current.cache_read_input_tokens) ?? 0;
  return input + created + read;
}

function formatContext(input: Record<string, any>, state: StatuslineState | null): string | null {
  const context = record(input.context_window);
  const used = numberValue(context.used_percentage);
  const remaining = numberValue(context.remaining_percentage);
  const size = numberValue(context.context_window_size);
  const usedTokens =
    usageTokens(context) ??
    state?.lastUsage?.contextTokens ??
    state?.lastUsage?.totalTokens ??
    null;

  if (used === null && remaining === null) {
    if (size !== null && usedTokens !== null && usedTokens > 0) {
      const estimatedUsed = Math.min(100, Math.max(0, (usedTokens / size) * 100));
      const remainingTokens = Math.max(0, size - usedTokens);
      return `ctx ~${percent(estimatedUsed)} (${compactTokens(remainingTokens)} left)`;
    }
    return null;
  }

  if (used !== null && size !== null && usedTokens !== null) {
    const remainingTokens = Math.max(0, size - usedTokens);
    return `ctx ${percent(used)} (${compactTokens(remainingTokens)} left)`;
  }

  if (used !== null && remaining !== null) {
    return `ctx ${percent(used)} (${percent(remaining)} left)`;
  }

  if (used !== null) return `ctx ${percent(used)}`;
  return `ctx ${percent(remaining!)} left`;
}

function formatReset(epochSeconds: unknown, now: Date): string | null {
  const reset = numberValue(epochSeconds);
  if (reset === null) return null;
  const diffSeconds = Math.max(0, Math.round(reset - now.getTime() / 1000));
  if (diffSeconds < 60) return `${diffSeconds}s`;
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const hrs = hours % 24;
  return hrs > 0 ? `${days}d${hrs}h` : `${days}d`;
}

function formatLimit(label: string, value: unknown, reset: unknown, now: Date): string | null {
  const used = numberValue(value);
  if (used === null) return null;
  const resetLabel = formatReset(reset, now);
  return resetLabel
    ? `${label} ${percent(used)} reset ${resetLabel}`
    : `${label} ${percent(used)}`;
}

function formatProvider(provider: unknown): string | null {
  const key = stringValue(provider) as Provider | null;
  return key && PROVIDER_LABELS[key] ? PROVIDER_LABELS[key] : null;
}

function truncate(text: string, maxWidth?: number): string {
  if (!maxWidth || maxWidth <= 0 || text.length <= maxWidth) return text;
  if (maxWidth <= 3) return text.slice(0, maxWidth);
  return `${text.slice(0, maxWidth - 3)}...`;
}

function fitSegments(segments: Segment[], maxWidth?: number): string {
  const active = [...segments];
  let text = active.map((segment) => segment.text).join(" | ");
  if (!maxWidth || text.length <= maxWidth) return text;

  for (let i = active.length - 1; i >= 0 && text.length > maxWidth; i--) {
    if (!active[i]?.optional) continue;
    active.splice(i, 1);
    text = active.map((segment) => segment.text).join(" | ");
  }

  return truncate(text, maxWidth);
}

export function formatStatusline(
  input: unknown,
  state: StatuslineState | null = null,
  options: FormatStatuslineOptions = {},
): string {
  const data = record(input);
  const model = record(data.model);
  const now = options.now ?? new Date();
  const style = options.style ?? "compact";

  const modelLabel =
    stringValue(model.display_name) ??
    stringValue(model.id) ??
    stringValue(state?.model) ??
    "Claude Code";
  const context = formatContext(data, state);

  if (style === "minimal") {
    return fitSegments(
      [
        { text: modelLabel },
        ...(context ? [{ text: context }] : []),
      ],
      options.maxWidth,
    );
  }

  const limits = record(data.rate_limits);
  const fiveHour = record(limits.five_hour ?? state?.rateLimits?.five_hour);
  const sevenDay = record(limits.seven_day ?? state?.rateLimits?.seven_day);
  const provider = formatProvider(state?.provider);
  const effort = stringValue(record(data.effort).level);

  return fitSegments(
    [
      ...(provider ? [{ text: provider, optional: true }] : []),
      { text: modelLabel },
      ...(effort ? [{ text: effort, optional: true }] : []),
      ...(context ? [{ text: context }] : []),
      ...(
        formatLimit("5h", fiveHour.used_percentage, fiveHour.resets_at, now)
          ? [{
              text: formatLimit("5h", fiveHour.used_percentage, fiveHour.resets_at, now)!,
              optional: true,
            }]
          : []
      ),
      ...(
        formatLimit("7d", sevenDay.used_percentage, sevenDay.resets_at, now)
          ? [{
              text: formatLimit("7d", sevenDay.used_percentage, sevenDay.resets_at, now)!,
              optional: true,
            }]
          : []
      ),
    ],
    options.maxWidth,
  );
}
