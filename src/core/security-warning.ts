/**
 * orion code - Token 安全警告
 *
 * v0.1.11: 检测对话中 Token/密钥暴露，提醒用户安全风险
 *
 * 检测类型：
 *   - GitHub Token (ghp_)
 *   - OpenAI API Key (sk-)
 *   - AWS Access Key (AKIA)
 *   - Generic secret pattern
 */

// ============================================================================
// Token Pattern Definitions
// ============================================================================

export const TOKEN_PATTERNS = [
  {
    name: 'GitHub Personal Access Token',
    pattern: /ghp_[A-Za-z0-9]{36}/,
    description: 'GitHub personal access token',
    severity: 'high',
  },
  {
    name: 'GitHub OAuth Access Token',
    pattern: /gho_[A-Za-z0-9]{36}/,
    description: 'GitHub OAuth access token',
    severity: 'high',
  },
  {
    name: 'GitHub App Token',
    pattern: /ghu_[A-Za-z0-9]{36}/,
    description: 'GitHub app user-to-server token',
    severity: 'high',
  },
  {
    name: 'OpenAI API Key',
    pattern: /sk-[A-Za-z0-9]{48}/,
    description: 'OpenAI API secret key',
    severity: 'high',
  },
  {
    name: 'OpenAI Project Key',
    pattern: /sk-proj-[A-Za-z0-9]{48}/,
    description: 'OpenAI project API key',
    severity: 'high',
  },
  {
    name: 'AWS Access Key ID',
    pattern: /AKIA[A-Z0-9]{16}/,
    description: 'AWS access key ID',
    severity: 'high',
  },
  {
    name: 'Anthropic API Key',
    pattern: /sk-ant-[A-Za-z0-9-_]{80}/,
    description: 'Anthropic API key',
    severity: 'high',
  },
  {
    name: 'Generic Secret Pattern',
    pattern: /[A-Za-z0-9]{32}-[A-Za-z0-9]{32}/,
    description: 'Generic API secret format',
    severity: 'medium',
  },
];

export type TokenSeverity = 'high' | 'medium' | 'low';

export interface DetectedToken {
  name: string;
  pattern: string;
  match: string;
  severity: TokenSeverity;
  description: string;
}

// ============================================================================
// Detection Functions
// ============================================================================

/**
 * 检测消息中的 Token/密钥
 * @param content - 要检测的内容
 * @returns 检测到的 Token 列表
 */
export function detectSecretsInMessage(content: string): DetectedToken[] {
  const detected: DetectedToken[] = [];

  for (const tokenDef of TOKEN_PATTERNS) {
    const matches = content.match(tokenDef.pattern);
    if (matches) {
      for (const match of matches) {
        detected.push({
          name: tokenDef.name,
          pattern: tokenDef.pattern.source,
          match: match,
          severity: tokenDef.severity as TokenSeverity,
          description: tokenDef.description,
        });
      }
    }
  }

  return detected;
}

/**
 * 检查是否包含高风险 Token
 */
export function hasHighRiskSecret(content: string): boolean {
  const detected = detectSecretsInMessage(content);
  return detected.some(t => t.severity === 'high');
}

/**
 * 生成安全警告消息
 */
export function generateSecurityWarning(detected: DetectedToken[]): string {
  if (detected.length === 0) return '';

  const lines: string[] = [];
  lines.push('⚠️ Security Alert: Token/Secret detected in message');
  lines.push('');

  const highRisk = detected.filter(t => t.severity === 'high');
  const mediumRisk = detected.filter(t => t.severity === 'medium');

  if (highRisk.length > 0) {
    lines.push('HIGH RISK tokens detected:');
    for (const t of highRisk) {
      // Mask the actual token value
      const masked = t.match.slice(0, 8) + '...' + t.match.slice(-4);
      lines.push(`  - ${t.name}: ${masked}`);
    }
    lines.push('');
    lines.push('These tokens should be revoked immediately after use.');
  }

  if (mediumRisk.length > 0) {
    lines.push('POTENTIAL secrets detected:');
    for (const t of mediumRisk) {
      const masked = t.match.slice(0, 8) + '...' + t.match.slice(-4);
      lines.push(`  - ${t.name}: ${masked}`);
    }
  }

  lines.push('');
  lines.push('Recommendation:');
  lines.push('  1. Never share tokens/secrets in chat');
  lines.push('  2. Use environment variables or secure storage');
  lines.push('  3. Rotate compromised tokens immediately');

  return lines.join('\n');
}

/**
 * 对消息内容进行安全检查并返回警告（如果有）
 */
export function checkMessageSecurity(content: string): { safe: boolean; warning?: string } {
  const detected = detectSecretsInMessage(content);

  if (detected.length === 0) {
    return { safe: true };
  }

  return {
    safe: false,
    warning: generateSecurityWarning(detected),
  };
}

// ============================================================================
// Export
// ============================================================================

export const SECURITY_WARNING_MODULE = {
  detectSecretsInMessage,
  hasHighRiskSecret,
  generateSecurityWarning,
  checkMessageSecurity,
  TOKEN_PATTERNS,
};