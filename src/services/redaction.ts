const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [
    /\b((?:GH_TOKEN|GITHUB_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)\s*=\s*)(["']?)[^\s"',;]+/gi,
    '$1$2[REDACTED_SECRET]',
  ],
  [
    /(["'](?:gh_token|github_token|aws_access_key_id|aws_secret_access_key|aws_session_token)["']\s*:\s*)(["'])(?:[^"']+)(["'])/gi,
    '$1$2[REDACTED_SECRET]$3',
  ],
  [/\b(authorization\s*[:=]\s*)(["']?)(?:Bearer\s+)?[^\s"',;]+/gi, '$1$2[REDACTED_SECRET]'],
  [
    /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*)(["']?)[^\s"',;]+/gi,
    '$1$2[REDACTED_SECRET]',
  ],
  [
    /(["'](?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)["']\s*:\s*)(["'])(?:[^"']+)(["'])/gi,
    '$1$2[REDACTED_SECRET]$3',
  ],
  [
    /\b((?:OPENAI_API_KEY|DASHSCOPE_API_KEY|ANTHROPIC_API_KEY|XAI_API_KEY)\s*=\s*)(["']?)[^\s"',;]+/g,
    '$1$2[REDACTED_SECRET]',
  ],
  [/\bsk-[A-Za-z0-9_.-]{8,}\b/g, '[REDACTED_SECRET]'],
  [/\bgh[pousr]_[A-Za-z0-9]{8,}\b/gi, '[REDACTED_SECRET]'],
  [/\bgithub_pat_[A-Za-z0-9_]{8,}\b/gi, '[REDACTED_SECRET]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_SECRET]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED_SECRET]'],
];

export function redactTraceText(text: string): string {
  return SECRET_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    text
  );
}
