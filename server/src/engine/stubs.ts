import { readEvidence, type StoredSource } from './evidence-store.js';

/**
 * Stub rendering and the clearing gate.
 *
 * A cleared tool result is replaced by one stub line per source. The stub keeps
 * everything needed to decide whether the source matters — number, kind, URL,
 * size — and the exact call to reopen it. The raw text lives in the Evidence
 * Store, never in the stub.
 */

export interface ClearableMessage {
  role: string;
  content?: string | null;
}

export interface ClearResult {
  /** Tool messages rewritten. */
  clearedMessages: number;
  /** Distinct sources stubbed. */
  stubbedSources: number;
  charsBefore: number;
  charsAfter: number;
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : `${tokens}`;
}

function kindLabel(record: StoredSource): string {
  return record.kind === 'page' ? 'page, fetched' : 'search_result';
}

export function renderStub(record: StoredSource): string {
  const parts = [
    `[Source #${record.sourceIndex}`,
    kindLabel(record),
    record.url,
    `${formatTokens(record.tokens)} tok`,
    'cleared from context',
  ];
  parts.push(`reopen: recall_source({source: ${record.sourceIndex}})`);
  return `[${parts.join(' | ')}]`;
}

function sourceIndexesIn(content: string): number[] {
  const out: number[] = [];
  const re = /\[Source #(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const n = Number(m[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Replaces clearable tool results with stubs, in one batch.
 *
 * The gate: a message is rewritten only if EVERY source number in it resolves
 * to a stored record old enough to clear. One unstored or recent source keeps
 * the whole message raw. A block is never half-cleared, because a stubbed
 * message that still carries raw text for another source would be neither a
 * reliable index nor the evidence itself.
 */
export function clearEligibleMessages(
  messages: ClearableMessage[],
  jobId: string,
  currentRound: number,
  keepRecentRounds: number,
): ClearResult {
  const result: ClearResult = { clearedMessages: 0, stubbedSources: 0, charsBefore: 0, charsAfter: 0 };
  const cutoffRound = currentRound - keepRecentRounds;

  for (const msg of messages) {
    if (msg.role !== 'tool' || typeof msg.content !== 'string') continue;
    if (!msg.content.includes('[Source #')) continue;
    result.charsBefore += msg.content.length;

    const indexes = sourceIndexesIn(msg.content);
    if (indexes.length === 0) {
      result.charsAfter += msg.content.length;
      continue;
    }
    const records: StoredSource[] = [];
    let clearable = true;
    for (const index of indexes) {
      const record = readEvidence(jobId, index);
      /* Never clear what is not stored, and never clear recent rounds. The
         first protects against losing evidence with no way back; the second
         keeps the working set the model is actively using. */
      if (!record || record.round > cutoffRound) {
        clearable = false;
        break;
      }
      records.push(record);
    }
    if (!clearable || records.length === 0) {
      result.charsAfter += msg.content.length;
      continue;
    }
    msg.content = records.map((r) => renderStub(r)).join('\n');
    result.clearedMessages += 1;
    result.stubbedSources += records.length;
    result.charsAfter += msg.content.length;
  }
  return result;
}
