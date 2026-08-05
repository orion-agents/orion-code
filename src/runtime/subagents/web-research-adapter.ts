/**
 * Web research adapter (v0.1.4, P0-R2).
 *
 * Normalizes the read-only web tooling into the Research schema. It does NOT
 * re-implement SSRF / DNS / redirect / body / abort guards - it reuses the
 * lexical guard from `src/tools/web` for selection-time pre-checks and delegates
 * the full per-hop guard (DNS rebinding, redirect chains, Content-Length,
 * abort) to whatever `fetch` dependency the caller injects (the default is the
 * real `webFetchTool`, which already enforces all of it).
 *
 * Hard rules (from the plan):
 *  - Only specialized WebSearch / WebFetch capability; no generic MCP.
 *  - Provider fallback changes the *provider* only - it never drops a source's
 *    status or writes a failure as a success.
 *  - A security gate failure yields a `blocked` / `failed` source with a
 *    structured `failureReason`. It never throws and never masquerades as a hit.
 *  - The adapter is pure with respect to deps, so the whole search -> select ->
 *    fetch -> hash pipeline is testable without network.
 */

import { createHash } from 'crypto';
import { isUrlSafeForSSRF } from '../../tools/web';
import type { ResearchRequest, ResearchSource, SourceStatus } from './research-types';

/** Normalized search hit as produced by an injected search dependency. */
export interface RawSearchResult {
  query: string;
  /** Provider that returned this hit (e.g. 'websearch-mcp', 'tavily', 'ddg'). */
  provider: string;
  title: string;
  url: string;
  snippet?: string;
  /**
   * Status of the *search* step for this hit. A blocked/error hit is recorded as
   * a blocked/failed source and is never fetched.
   */
  status: 'ok' | 'blocked' | 'error';
  failureReason?: string;
}

/** Normalized fetch outcome as produced by an injected fetch dependency. */
export interface RawFetchResult {
  url: string;
  status: 'ok' | 'blocked' | 'error';
  /** Retrieved content (already converted to markdown by the real web tool). */
  content?: string;
  /** URL after redirects - use this as canonicalUrl so citations are stable. */
  finalUrl?: string;
  /** Bytes of the raw body (used for the per-packet byte budget). */
  bytes?: number;
  redirects?: string[];
  failureReason?: string;
}

export interface WebResearchDeps {
  /** Search provider chain. May perform internal provider fallback. */
  search: (query: string, limit: number) => Promise<RawSearchResult[]>;
  /** Fetch a single URL. Default wraps the real WebFetch tool (full guard set). */
  fetch: (url: string, prompt?: string) => Promise<RawFetchResult>;
  /** Selection-time domain allowlist; when set, only matching hosts pass. */
  allowedDomains?: string[];
  /** Overridable clock for deterministic tests. */
  now?: () => Date;
}

export interface WebResearchResult {
  /** Sources actually collected (retrieved / partial / failed / blocked). */
  sources: ResearchSource[];
  /** URLs that passed selection but were skipped due to budget/timeout. Redacted. */
  skipped: string[];
  /** URLs rejected by the security / domain gate. Redacted. */
  blocked: string[];
  /** Provider recorded for the (last) successful search. */
  provider: string | null;
  bytesFetched: number;
  durationMs: number;
  truncatedDueToBytes: boolean;
  timedOut: boolean;
  notes: string[];
}

/** Map a raw status to the research schema's SourceStatus. */
function toSourceStatus(raw: RawSearchResult['status'] | RawFetchResult['status']): SourceStatus {
  switch (raw) {
    case 'ok':
      return 'retrieved';
    case 'blocked':
      return 'blocked';
    case 'error':
      return 'failed';
  }
}

/** Host of a URL, lower-cased, brackets stripped for IPv6 literals. */
function hostOf(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  } catch {
    return null;
  }
}

/** True when `url`'s host is the domain or a subdomain of it. */
function matchesDomain(url: string, domain: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  const d = domain.toLowerCase();
  return host === d || host.endsWith('.' + d);
}

function domainAllowed(url: string, allowed?: string[]): boolean {
  if (!allowed || allowed.length === 0) return true;
  return allowed.some(d => matchesDomain(url, d));
}

function hashContent(canonicalUrl: string, content: string): string {
  return createHash('sha256')
    .update(`${canonicalUrl}\n${content}`)
    .digest('hex');
}

/**
 * Run a controlled web research pass for a `web`/`mixed` request.
 *
 * Pipeline: validate mode -> search -> select (SSRF + domain gate, capped at
 * maxSources) -> fetch (byte budget + overall duration budget) -> emit sources.
 * Security-gate failures become `blocked`/`failed` sources; they never throw
 * and never become `retrieved`.
 */
export async function runWebResearch(
  request: ResearchRequest,
  deps: WebResearchDeps,
): Promise<WebResearchResult> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const notes: string[] = [];

  const result: WebResearchResult = {
    sources: [],
    skipped: [],
    blocked: [],
    provider: null,
    bytesFetched: 0,
    durationMs: 0,
    truncatedDueToBytes: false,
    timedOut: false,
    notes,
  };

  if (request.mode !== 'web' && request.mode !== 'mixed') {
    notes.push(`web research skipped: mode is '${request.mode}'`);
    result.durationMs = now().getTime() - startedAt.getTime();
    return result;
  }

  const query = request.objective.trim();
  const limit = Math.max(1, Math.min(request.maxSources, 50));

  let hits: RawSearchResult[] = [];
  try {
    hits = await deps.search(query, limit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notes.push(`search dependency threw: ${msg}`);
  }

  // Select: security + domain gate, capped at maxSources.
  const selected: Array<{ hit: RawSearchResult; rank: number }> = [];
  for (let i = 0; i < hits.length && selected.length < request.maxSources; i++) {
    const hit = hits[i];
    if (hit.status !== 'ok') {
      // Search-level failure/block: record directly, never fetch.
      result.sources.push(buildSource(hit, { rank: i, now: now() }));
      continue;
    }
    const ssrf = isUrlSafeForSSRF(hit.url);
    if (!ssrf.safe) {
      result.blocked.push(redactUrl(hit.url).url);
      result.sources.push(
        buildSource(hit, { rank: i, now: now(), override: { status: 'blocked', failureReason: ssrf.reason } }),
      );
      continue;
    }
    if (!domainAllowed(hit.url, deps.allowedDomains ?? request.scope.domains)) {
      result.blocked.push(redactUrl(hit.url).url);
      result.sources.push(
        buildSource(hit, {
          rank: i,
          now: now(),
          override: { status: 'blocked', failureReason: 'domain not in allowlist' },
        }),
      );
      continue;
    }
    if (hit.provider) result.provider = hit.provider;
    selected.push({ hit, rank: i });
  }

  if (selected.length === 0) {
    result.durationMs = now().getTime() - startedAt.getTime();
    return result;
  }

  // Fetch each selected URL under byte + duration budgets.
  const byteBudget = Math.max(0, request.maxFetchBytes);
  for (const { hit, rank } of selected) {
    if (result.timedOut) {
      result.skipped.push(redactUrl(hit.url).url);
      continue;
    }
    // Byte budget: once exhausted, stop fetching (remaining become skipped, not
    // a failure - they can be retried, so status stays silent).
    if (byteBudget > 0 && result.bytesFetched >= byteBudget) {
      result.truncatedDueToBytes = true;
      result.skipped.push(redactUrl(hit.url).url);
      continue;
    }

    let fetched: RawFetchResult;
    try {
      fetched = await deps.fetch(hit.url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.sources.push(
        buildSource(hit, { rank, now: now(), override: { status: 'failed', failureReason: `fetch threw: ${msg}` } }),
      );
      continue;
    }

    // Duration budget: abort remaining fetches after the wall clock is exceeded.
    if (now().getTime() - startedAt.getTime() > request.maxDurationMs) {
      result.timedOut = true;
    }

    const status = toSourceStatus(fetched.status);
    const bytes = fetched.bytes ?? (fetched.content ? Buffer.byteLength(fetched.content, 'utf8') : 0);
    result.bytesFetched += bytes;

    // Redirects can introduce credentials the search hit never had, so the
    // final URL gets the same treatment. Hashing the redacted URL keeps the
    // content hash stable when only a rotating token in the query differs.
    const finalRedacted = redactUrl(fetched.finalUrl ?? hit.url);
    // The audit trail spans both URLs: a secret stripped from the search hit
    // still happened even if the post-redirect URL was clean.
    const removed = [...new Set([...redactUrl(hit.url).removed, ...finalRedacted.removed])];
    const source: ResearchSource = buildSource(hit, {
      rank,
      now: now(),
      override: {
        status,
        failureReason: fetched.failureReason,
        canonicalUrl: finalRedacted.url,
        displayUrl: finalRedacted.url,
        excerpt: fetched.content ? fetched.content.slice(0, 4000) : hit.snippet,
        contentHash: fetched.content ? hashContent(finalRedacted.url, fetched.content) : undefined,
        ...(removed.length > 0 ? { redactions: removed } : {}),
      },
    });
    result.sources.push(source);
  }

  result.durationMs = now().getTime() - startedAt.getTime();
  return result;
}

interface BuildOpts {
  rank: number;
  now: Date;
  override?: Partial<ResearchSource>;
}

function buildSource(hit: RawSearchResult, opts: BuildOpts): ResearchSource {
  // Redact once, at the boundary, and use the safe URL for every field that
  // leaves this module. Keeping a raw `canonicalUrl` next to a redacted
  // `displayUrl` only works if every consumer remembers to read the latter -
  // and the persisted packet and the renderer both read `canonicalUrl`.
  const redacted = redactUrl(hit.url);
  const base: ResearchSource = {
    id: `web-${opts.rank + 1}`,
    kind: 'search_result',
    canonicalUrl: redacted.url,
    displayUrl: redacted.url,
    title: hit.title,
    excerpt: hit.snippet,
    provider: hit.provider,
    retrievedAt: opts.now.toISOString(),
    status: toSourceStatus(hit.status),
    failureReason: hit.failureReason,
    ...(redacted.removed.length > 0 ? { redactions: redacted.removed } : {}),
  };
  return { ...base, ...opts.override };
}

const SECRET_QUERY_PARAM = /^(api_?key|token|secret|access_?token|auth)$/i;

/**
 * Strip secret-bearing query params (?api_key=, ?token=, ...) from a URL and
 * report which ones were removed.
 *
 * The removal list feeds `ResearchSource.redactions` so a reader can tell that
 * a URL was rewritten - a silently redacted URL is indistinguishable from one
 * that never carried a credential, which makes after-the-fact auditing
 * impossible.
 *
 * A URL with nothing to strip is returned byte-identical (not re-serialised),
 * so redaction never perturbs the content hash of a clean source.
 */
function redactUrl(url: string): { url: string; removed: string[] } {
  try {
    const u = new URL(url);
    const removed: string[] = [];
    for (const key of [...u.searchParams.keys()]) {
      if (SECRET_QUERY_PARAM.test(key)) {
        u.searchParams.delete(key);
        removed.push(key);
      }
    }
    return removed.length > 0 ? { url: u.toString(), removed } : { url, removed: [] };
  } catch {
    return { url, removed: [] };
  }
}
