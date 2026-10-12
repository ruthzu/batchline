/**
 * In-memory conversation state for the voice layer.
 *
 * A voice conversation is more than one utterance: the baker traces a lot,
 * then asks for a response draft built FROM that trace, then approves it.
 * Each step lives in a different request, so the intermediate results have to
 * live somewhere. That somewhere is this module — a plain Map, deliberately:
 *
 *   - Nothing here touches DynamoDB or the 7 real tools. It is conversational
 *     scratch space, not ledger data, so losing it on a restart loses nothing
 *     that was ever committed.
 *   - Entries expire after SESSION_TTL_MS (30 minutes), checked on read and
 *     pruned on write, so an abandoned conversation cannot accumulate state
 *     (or a stale "approve" target) forever.
 *
 * Keyed by sessionId supplied by the client. No sessionId -> the voice layer
 * never touches this store, i.e. stateless behavior.
 */

import type { TraceLotResult } from "@batchline/shared";
import type {
  OrderAction,
  PreviewResponseResult,
} from "../tools/preview-response.js";

/** How long a session survives without a read or a write. */
export const SESSION_TTL_MS = 30 * 60 * 1000;

/** The last trace_ingredient_lot result in this conversation, and when. */
export type StoredTrace = {
  trace: TraceLotResult;
  tracedAt: number;
};

/**
 * The last preview_response result in this conversation, plus EXACTLY the
 * orderActions it was built from. commit_approved_response must receive the
 * same orderActions as the preview a human actually approved — the preview
 * alone doesn't carry them — so they are stored verbatim, not re-derived.
 */
export type StoredPreview = {
  preview: PreviewResponseResult;
  orderActions: OrderAction[];
  createdAt: number;
};

export type VoiceSession = {
  lastTrace?: StoredTrace;
  pendingPreview?: StoredPreview;
};

type SessionEntry = VoiceSession & {
  /** Last read-or-write time; the 30-minute TTL is measured from here. */
  updatedAt: number;
};

const sessions = new Map<string, SessionEntry>();

// ---------------------------------------------------------------------------
// Injectable clock. Production always uses Date.now; the session-flow test
// installs a fake one so expiry can be exercised without waiting 30 minutes.
// setSessionClock returns the previous clock so tests can restore it.
// ---------------------------------------------------------------------------

let clock: () => number = () => Date.now();

export function setSessionClock(fn: () => number): () => void {
  const previous = clock;
  clock = fn;
  return () => {
    clock = previous;
  };
}

function isExpired(entry: SessionEntry, now: number): boolean {
  return now - entry.updatedAt > SESSION_TTL_MS;
}

/** Drop every entry older than the TTL. Called on every write. */
export function pruneSessions(): number {
  const now = clock();
  let pruned = 0;
  for (const [sessionId, entry] of sessions) {
    if (isExpired(entry, now)) {
      sessions.delete(sessionId);
      pruned += 1;
    }
  }
  return pruned;
}

/**
 * Read a session. An expired entry is deleted and reported as absent, so
 * "expired" and "never existed" are indistinguishable to callers — both mean
 * "there is no conversational context".
 */
export function getSession(sessionId: string): VoiceSession | undefined {
  if (!sessionId) return undefined;
  const entry = sessions.get(sessionId);
  if (!entry) return undefined;
  if (isExpired(entry, clock())) {
    sessions.delete(sessionId);
    return undefined;
  }
  return entry;
}

/**
 * Merge a patch into a session, creating it if needed. A field explicitly set
 * to `undefined` in the patch is removed (that is how a committed preview is
 * cleared). Expired entries are pruned first, per the write-path rule.
 */
export function setSession(sessionId: string, patch: VoiceSession): void {
  if (!sessionId) return;
  pruneSessions();
  const now = clock();
  const existing = getSession(sessionId);
  const next: SessionEntry = {
    ...(existing ?? {}),
    ...patch,
    updatedAt: now,
  };
  sessions.set(sessionId, next);
}

/** Forget a session entirely (used by "New conversation" flows and tests). */
export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/** Number of live (unexpired) sessions — for tests and diagnostics. */
export function sessionCount(): number {
  pruneSessions();
  return sessions.size;
}
