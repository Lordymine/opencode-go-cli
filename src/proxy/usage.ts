import { updateStatuslineUsage } from "../statusline/state.js";

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function mapChatUsageToAnthropic(usage: any): AnthropicUsage {
  const promptDetails = usage?.prompt_tokens_details ?? {};

  return {
    input_tokens: numberOrZero(usage?.prompt_tokens ?? usage?.input_tokens),
    output_tokens: numberOrZero(usage?.completion_tokens ?? usage?.output_tokens),
    cache_creation_input_tokens: numberOrZero(
      usage?.cache_creation_input_tokens ?? promptDetails.cache_creation_tokens,
    ),
    cache_read_input_tokens: numberOrZero(
      usage?.cache_read_input_tokens ?? promptDetails.cached_tokens,
    ),
  };
}

export function mapResponsesUsageToAnthropic(usage: any): AnthropicUsage {
  const inputDetails = usage?.input_tokens_details ?? {};

  return {
    input_tokens: numberOrZero(usage?.input_tokens),
    output_tokens: numberOrZero(usage?.output_tokens),
    cache_creation_input_tokens: numberOrZero(
      usage?.cache_creation_input_tokens ?? inputDetails.cache_creation_tokens,
    ),
    cache_read_input_tokens: numberOrZero(
      usage?.cache_read_input_tokens ?? inputDetails.cached_tokens,
    ),
  };
}

export function recordStatuslineUsage(usage: AnthropicUsage): void {
  try {
    updateStatuslineUsage(usage);
  } catch {}
}
