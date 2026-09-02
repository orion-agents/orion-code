/**
 * Preserve the browser-owned foreground Session even when it falls outside the
 * currently loaded catalog page. The subsequent snapshot request validates
 * that the Session still exists and upserts its summary into the visible page.
 */
export function selectPreferredForegroundSession(
  storedSessionId: string | null,
  sessions: readonly { readonly id: string }[],
  hostDefault: string | null
): string | null {
  if (storedSessionId) return storedSessionId;
  const available = new Set(sessions.map(session => session.id));
  if (hostDefault && available.has(hostDefault)) return hostDefault;
  return sessions[0]?.id ?? null;
}
