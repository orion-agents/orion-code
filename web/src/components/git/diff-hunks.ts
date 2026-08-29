export interface DiffHunk {
  readonly title: string;
  readonly lines: readonly string[];
}

/** Returns only real unified-diff hunks; section and file headers remain non-selectable metadata. */
export function splitHunks(lines: readonly string[]): readonly DiffHunk[] {
  const hunks: Array<{ title: string; lines: string[] }> = [];
  let current: { title: string; lines: string[] } | undefined;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (current) hunks.push(current);
      current = { title: line, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

export function buildReviewContext(
  input: {
    readonly path: string;
    readonly repositoryRevision: string;
  },
  hunk: DiffHunk
): string {
  const metadata = {
    schemaVersion: 1,
    type: 'review_context',
    repositoryRevision: input.repositoryRevision,
    path: input.path,
    hunk: hunk.title,
  } as const;
  const body = hunk.lines.join('\n').slice(0, 12_000);
  return [
    `请审阅 ${input.path} 的这个 diff hunk，并指出正确性、安全性和测试风险：`,
    '',
    '```review_context',
    JSON.stringify(metadata, null, 2),
    '```',
    '',
    '```diff',
    body,
    '```',
  ].join('\n');
}
