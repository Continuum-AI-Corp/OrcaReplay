/**
 * Canonical intermediate representation.
 *
 * Every model exchange is recorded twice: the raw provider bytes (which is what makes exact
 * replay exact) and this canonical form (which is what makes forking a Claude-recorded run onto
 * GPT possible at all). Never discard the raw bytes to save space — blob dedup already handles
 * size, and a lossy trace cannot be replayed exactly.
 */

export type CanonicalContent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'image'; media_type: string; data: string };

export interface CanonicalMessage {
  role: 'user' | 'assistant';
  content: CanonicalContent[];
}

export interface CanonicalTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface CanonicalRequest {
  model: string;
  system?: string;
  messages: CanonicalMessage[];
  tools?: CanonicalTool[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream?: boolean;
  metadata?: Record<string, unknown>;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error';

export interface CanonicalResponse {
  id: string;
  model: string;
  stop_reason: StopReason;
  content: CanonicalContent[];
  usage: Usage;
}

export type CanonicalChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_delta'; id: string; name: string; partial_json: string }
  | { type: 'done'; response: CanonicalResponse };

export interface Money {
  amount: number;
  currency: 'USD';
}

export interface ModelInfo {
  id: string;
  context_window?: number;
  input_price_per_mtok?: number;
  output_price_per_mtok?: number;
}
