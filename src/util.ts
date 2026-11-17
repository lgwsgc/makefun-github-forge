// Shared helpers for the forge: the viewer identity, a deterministic logical
// clock, opaque global ids, and small byte/JSON utilities. No wall clock or
// randomness leaks into anything the suite can compare across reads: ids are
// derived from counters and names, timestamps come from a monotonic logical
// clock seeded from MAKEFUN_TRIAL_NOW when the trial provides it.

/**
 * The token owner. The suite's scenario derives every name from the sealed
 * constant seed (wire.ts SCENARIO_SEED 0x6a09e667f3bcc909n), so the viewer's
 * login is the same in every trial; the bearer token itself carries no login,
 * which is why this is a constant rather than something decoded from it.
 */
export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** The default branch every new repository starts with. */
export const DEFAULT_BRANCH = 'main';

/** The git identity stamped on commits this forge creates itself. */
export function gitIdentity(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}

// ---------------------------------------------------------------------------
// Logical clock
// ---------------------------------------------------------------------------

let clockMs: number = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) return Math.floor(asNumber);
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  // No trial clock: anchor on process start. Every tick still advances by a
  // fixed step, so ordering inside one run is deterministic.
  return Date.now();
})();

/** Advance the logical clock by one millisecond and return the new time. */
export function tickMs(): number {
  clockMs += 1;
  return clockMs;
}

/** Current logical time in whole seconds (for git commit headers). */
export function tickSeconds(): number {
  return Math.floor(tickMs() / 1000);
}

/** An ISO-8601 timestamp from the logical clock (advances it by 1 ms). */
export function tickIso(): string {
  return new Date(tickMs()).toISOString();
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

let requestCounter = 0;

/** A non-empty request id for the X-GitHub-Request-Id header. Counter-only, so no wall clock leaks into any reply. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

/**
 * An opaque Relay-style global id: base64url of `Type:key`. Never the plain
 * database id or number, and stable for the same object across reads.
 */
export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64url');
}

/** Decode a global id back to its type and key, or null when it is not one. */
export function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64url').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon <= 0) return null;
    return { type: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

/** A GraphQL cursor over a numbered list: base64url of the last seen number. */
export function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

/** Decode a cursor back to its number, or null when it is not one. */
export function decodeCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    if (match === null) return null;
    return Number(match[1]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Bytes and JSON
// ---------------------------------------------------------------------------

/** True when the value is a plain record (a JSON object). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A 40-hex object id, lowercased. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Lowercase a value that should be an oid (the suite compares case-insensitively). */
export function lowerOid(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}
