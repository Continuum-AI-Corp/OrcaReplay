import type { CanonicalContent, CanonicalRequest, CanonicalResponse } from '@orcareplay/plugin-api';
import type { RecordedExchange } from '@orcareplay/proxy';

/**
 * Turning intercepted model exchanges into trace events.
 *
 * This is where the project's central observation is cashed in. A tool result never appears in the
 * response that requested it — the harness runs the tool and hands the result back on the *next*
 * request. So we hold each `tool_use` open and close it when a later request carries the matching
 * `tool_result`, which is how a proxy that only sees model traffic still reconstructs the whole
 * tool loop without touching the agent.
 *
 * The consequence to keep in mind: a tool call whose result never comes back (the run ended, the
 * agent crashed) stays unresolved, and `unresolved()` reports it rather than silently dropping it.
 */

export interface PendingToolCall {
  id: string;
  name: string;
  input: unknown;
  /** seq of the tool.call event, so the tool.result can point back at it. */
  seq: number;
  turn: number;
}

export interface DerivedEvent {
  type: 'model.request' | 'model.response' | 'tool.call' | 'tool.result';
  actor: 'agent' | 'model' | 'harness';
  attrs: Record<string, unknown>;
  payload?: unknown;
  /** Index into the pending map, resolved to a real seq by the caller. */
  causesToolId?: string;
}

export class ExchangeEventDeriver {
  readonly #pending = new Map<string, PendingToolCall>();
  /**
   * Tool results already turned into events. Necessary because the conversation is resent in
   * full every turn: without this, a result would be re-emitted on every subsequent request and
   * a long run would accumulate one duplicate per turn per tool call.
   */
  readonly #closed = new Set<string>();

  /** Tool calls that were issued but whose result never came back. */
  unresolved(): PendingToolCall[] {
    // A pending entry now outlives the result that answered it, so that the recorder can still
    // resolve the call's seq for `causes` after derive has returned. `#closed` is the authority on
    // whether a call was actually answered; "still in #pending" no longer means "unanswered".
    return [...this.#pending.values()].filter((p) => !this.#closed.has(p.id));
  }

  /**
   * Derive the events for one exchange. Returns them in the order they should be appended;
   * `tool.result` events come first because they describe work that happened *before* this
   * request was made.
   */
  derive(exchange: RecordedExchange, turn: number): DerivedEvent[] {
    const events: DerivedEvent[] = [];

    for (const result of collectToolResults(exchange.canonicalRequest)) {
      // Already accounted for on an earlier turn — the resent conversation is not new information.
      if (this.#closed.has(result.tool_use_id)) continue;
      // No pending call either: recording began mid-conversation, so this result is the first
      // thing we know about that tool use. Record it rather than lose it.
      const pending = this.#pending.get(result.tool_use_id);
      events.push({
        type: 'tool.result',
        actor: 'harness',
        attrs: {
          tool_use_id: result.tool_use_id,
          name: pending?.name ?? 'unknown',
          is_error: result.is_error ?? false,
          bytes: result.content.length,
        },
        payload: result.content,
        causesToolId: result.tool_use_id,
      });
      // Deliberately not deleted here. The recorder resolves the call's seq *after* derive
      // returns — it has to, since the seq only exists once the event is written — so dropping the
      // entry in this loop meant `causes` came back empty on every tool result ever recorded, with
      // no error to notice. `#closed` is what stops a resent result being re-emitted, so the
      // pending entry can outlive the result it answered without any duplication.
      this.#closed.add(result.tool_use_id);
    }

    events.push({
      type: 'model.request',
      actor: 'agent',
      attrs: {
        model: exchange.canonicalRequest.model,
        dialect: exchange.dialect,
        messages: exchange.canonicalRequest.messages.length,
        tools: exchange.canonicalRequest.tools?.length ?? 0,
      },
      payload: exchange.rawRequest,
    });

    const response = exchange.canonicalResponse;
    events.push({
      type: 'model.response',
      actor: 'model',
      attrs: {
        model: response?.model ?? exchange.canonicalRequest.model,
        stop_reason: response?.stop_reason ?? 'unknown',
        input_tokens: response?.usage.input_tokens ?? 0,
        output_tokens: response?.usage.output_tokens ?? 0,
        status: exchange.status,
        duration_ms: exchange.durationMs ?? 0,
        streamed: exchange.streamed,
      },
      payload: exchange.rawResponse,
    });

    for (const use of collectToolUses(response)) {
      events.push({
        type: 'tool.call',
        actor: 'model',
        attrs: { tool_use_id: use.id, name: use.name, input: use.input },
      });
      // seq is assigned by the writer; the caller patches it back in via markPending.
      this.#pending.set(use.id, { id: use.id, name: use.name, input: use.input, seq: -1, turn });
    }

    return events;
  }

  markPending(toolUseId: string, seq: number): void {
    const p = this.#pending.get(toolUseId);
    if (p) p.seq = seq;
  }

  seqOf(toolUseId: string): number | undefined {
    const seq = this.#pending.get(toolUseId)?.seq;
    return seq === undefined || seq < 0 ? undefined : seq;
  }
}

function collectToolResults(
  req: CanonicalRequest,
): Array<Extract<CanonicalContent, { type: 'tool_result' }>> {
  const out: Array<Extract<CanonicalContent, { type: 'tool_result' }>> = [];
  // Only the trailing user message can carry results for the calls we are still holding open;
  // scanning the whole conversation would re-emit every earlier result on every turn.
  const last = req.messages[req.messages.length - 1];
  if (!last || last.role !== 'user') return out;
  for (const block of last.content) {
    if (block.type === 'tool_result') out.push(block);
  }
  return out;
}

function collectToolUses(
  res: CanonicalResponse | undefined,
): Array<Extract<CanonicalContent, { type: 'tool_use' }>> {
  if (!res) return [];
  return res.content.filter(
    (b): b is Extract<CanonicalContent, { type: 'tool_use' }> => b.type === 'tool_use',
  );
}
