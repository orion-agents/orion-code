/**
 * Bash Security Module
 *
 * Provides safety checks and sandbox options for command execution.
 */

/**
 * Commands that are considered read-only and safe to execute without confirmation.
 * These commands only read data and do not modify the filesystem.
 */
export const READ_ONLY_COMMANDS = [
  // File listing/reading
  'ls',
  'dir',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'file',
  'stat',
  'wc',
  'du',
  'tree',
  'find',
  'locate',
  'which',
  'whereis',

  // File searching
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'sed',  // when without -i flag
  'awk',
  'cut',
  'sort',
  'uniq',
  'tr',
  'diff',
  'cmp',

  // Git read operations
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch',  // listing branches
  'git tag',     // listing tags
  'git remote',
  'git rev-parse',
  'git ls-files',
  'git ls-tree',

  // Package/dependency info
  'npm list',
  'npm info',
  'npm view',
  'npm search',
  'npm outdated',
  'yarn list',
  'yarn info',
  'pnpm list',
  'pnpm info',

  // Node/Python version
  'node --version',
  'node -v',
  'npm --version',
  'npm -v',
  'yarn --version',
  'pnpm --version',
  'python --version',
  'python -V',
  'python3 --version',
  'pip --version',
  'pip3 --version',

  // System info
  'echo',
  'printenv',
  'env',
  'whoami',
  'hostname',
  'date',
  'uptime',
  'uname',
  'arch',
  'pwd',
  'id',
  'groups',
  'getent',

  // Network info (read-only)
  'ping',
  'curl',   // when without file output
  'wget',   // when without file output
  'nslookup',
  'dig',
  'host',
  'ip',
  'ifconfig',
  'netstat',

  // Process info
  'ps',
  'top',
  'htop',
  'lsof',
  'pgrep',

  // Package managers (checking/listing is read-only)
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'pip',
  'pip3',
  'cargo',
  'top',
  'htop',
  'jobs',

  // JSON/YAML processing (read-only when no file write)
  'jq',
  'yq',

  // Help/version commands
  'help',
  'man',
  'info',
  'whatis',
  '--help',
  '-h',
  '--version',
  '-V',
];

/**
 * Validation commands that are safe enough to run without an interactive
 * confirmation prompt. They may read the project and execute local test code,
 * but they are standard verification steps for coding-agent work.
 */
export const VALIDATION_COMMAND_PATTERNS = [
  /^(npx\s+)?tsc\b.*--noEmit\b/,
  /^npx\s+(jest|vitest|eslint)\b/,
  /^(npm|pnpm|yarn)\s+test(\s|$)/,
  /^(npm|pnpm|yarn)\s+run\s+(test|lint|typecheck|check)(\s|$)/,
  /^pnpm\s+(test|lint|typecheck|check)(\s|$)/,
  /^yarn\s+(test|lint|typecheck|check)(\s|$)/,
];

/**
 * Dangerous command patterns that should always be blocked or require confirmation.
 */
export const DANGEROUS_PATTERNS = [
  // Filesystem destruction
  { pattern: /rm\s+-rf\s+\/$/, reason: 'Attempting to delete root directory' },
  { pattern: /rm\s+-rf\s+~$/, reason: 'Attempting to delete home directory' },
  { pattern: /rm\s+-rf\s+\*/, reason: 'Attempting to delete all files in current directory' },
  { pattern: /rm\s+-rf\s+\.\//, reason: 'Attempting to delete current directory contents' },

  // Disk operations
  { pattern: /mkfs/, reason: 'Attempting to format filesystem' },
  { pattern: /dd\s+of=\/dev/, reason: 'Attempting to write directly to disk device' },
  { pattern: /fdisk/, reason: 'Attempting to modify disk partitions' },

  // Fork bombs
  { pattern: /:\(\)\s*\{/, reason: 'Fork bomb detected' },
  { pattern: /\|\:\&/, reason: 'Fork bomb variant detected' },

  // System modification
  { pattern: /chmod\s+-R\s+777/, reason: 'Attempting to make all files executable' },
  { pattern: /chown\s+-R/, reason: 'Attempting to change ownership recursively' },

  // Package removal
  { pattern: /apt\s+remove/, reason: 'Attempting to remove system packages' },
  { pattern: /apt-get\s+remove/, reason: 'Attempting to remove system packages' },
  { pattern: /yum\s+remove/, reason: 'Attempting to remove system packages' },
  { pattern: /brew\s+uninstall/, reason: 'Attempting to remove packages' },

  // Process killing (mass)
  { pattern: /kill\s+-9\s+-1/, reason: 'Attempting to kill all processes' },
  { pattern: /pkill\s+-9/, reason: 'Attempting to force kill processes' },

  // Network dangerous
  { pattern: /iptables\s+-F/, reason: 'Attempting to flush firewall rules' },
  { pattern: /iptables\s+-P\s+INPUT\s+DROP/, reason: 'Attempting to block all incoming traffic' },
];

/**
 * Potentially destructive patterns that should ask for confirmation.
 */
export const POTENTIALLY_DESTRUCTIVE_PATTERNS = [
  /rm\s+-[rf]/,
  /rm\s+.*\s+-[rf]/,
  /chmod/,
  /chown/,
  /kill/,
  /pkill/,
  /mv\s+.*\s+\/dev\/null/,
  />\s*\/dev\/sda/,
  /curl.*>\s*\//,
  /wget.*-O\s*\//,
];

/**
 * Result of a quote-aware scan over a whole command line.
 */
export interface ShellCommandScan {
  /** The individual commands on the line, split on unquoted separators. */
  segments: string[];
  /**
   * False when the line uses a construct this scanner cannot reason about --
   * command substitution, process substitution or an unbalanced quote. Such a
   * line can hide an arbitrary command and must never be auto-approved.
   */
  supported: boolean;
  /** True when the line redirects output somewhere other than /dev/null. */
  writesFile: boolean;
}

/** The one redirect target that does not count as writing to the filesystem. */
const DISCARD_REDIRECT_TARGET = '/dev/null';

/**
 * Split a command line into the individual commands it will actually run.
 *
 * The classifier below hands out "run without confirmation" verdicts, so it has
 * to see every command on the line rather than just the leading token. Quote
 * state is tracked so `echo "a && b"` stays one segment, and substitutions are
 * reported as unsupported instead of being silently skipped over.
 */
export function scanShellCommand(cmd: string): ShellCommandScan {
  const segments: string[] = [];
  let current = '';
  let supported = true;
  let writesFile = false;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  const pushSegment = (): void => {
    const segment = current.trim();
    if (segment.length > 0) {
      segments.push(segment);
    }
    current = '';
  };

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];

    if (ch === '\\' && !inSingleQuote && next !== undefined) {
      current += ch + next;
      i++;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) {
      current += ch;
      continue;
    }

    // Command and process substitution can hide an arbitrary command inside an
    // otherwise innocent-looking line, and neither is worth modelling here.
    if (ch === '`' || (ch === '$' && next === '(') || ((ch === '<' || ch === '>') && next === '(')) {
      supported = false;
      current += ch;
      continue;
    }

    if (ch === ';' || ch === '\n') {
      pushSegment();
      continue;
    }
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      pushSegment();
      i++;
      continue;
    }
    if (ch === '&' || ch === '|') {
      pushSegment();
      continue;
    }

    if (ch === '>') {
      let cursor = i + 1;
      if (cmd[cursor] === '>') {
        cursor++;
      }
      if (cmd[cursor] === '&') {
        // `>&1` / `2>&1` duplicate a descriptor and `>&-` closes one; nothing
        // reaches the filesystem. Consume the whole reference so its `&` is not
        // mistaken for a background-job separator.
        let end = cursor + 1;
        while (end < cmd.length && cmd[end] >= '0' && cmd[end] <= '9') {
          end++;
        }
        if (cmd[end] === '-') {
          end++;
        }
        current += cmd.slice(i, end);
        i = end - 1;
        continue;
      }
      while (cursor < cmd.length && (cmd[cursor] === ' ' || cmd[cursor] === '\t')) {
        cursor++;
      }
      const target = cmd.slice(cursor).split(/[\s;&|<>]/)[0];
      if (target !== DISCARD_REDIRECT_TARGET) {
        writesFile = true;
      }
      current += ch;
      continue;
    }

    current += ch;
  }

  pushSegment();

  return {
    segments,
    supported: supported && !inSingleQuote && !inDoubleQuote,
    writesFile,
  };
}

/**
 * Require every command on the line to satisfy `predicate`.
 *
 * A single unrecognised segment is enough to withhold the auto-approval, which
 * is what stops `echo hi && rm -rf ~` from inheriting `echo`'s verdict.
 */
function everySegmentSatisfies(cmd: string, predicate: (segment: string) => boolean): boolean {
  const scan = scanShellCommand(cmd.trim());
  if (!scan.supported || scan.writesFile || scan.segments.length === 0) {
    return false;
  }
  return scan.segments.every(predicate);
}

/**
 * Check if a command is read-only and safe to execute without confirmation.
 *
 * Every command on the line must be independently read-only.
 */
export function isReadOnlyCommand(cmd: string): boolean {
  return everySegmentSatisfies(cmd, isReadOnlySegment);
}

/**
 * Check whether a single command -- with no separators left in it -- is read-only.
 */
function isReadOnlySegment(trimmedCmd: string): boolean {
  // Check exact matches first
  if (READ_ONLY_COMMANDS.includes(trimmedCmd)) {
    return true;
  }

  // Check if command starts with a read-only command
  const baseCmd = trimmedCmd.split(' ')[0];
  if (READ_ONLY_COMMANDS.includes(baseCmd)) {
    // Pipe to shell interpreters is always dangerous.
    if (/\|\s*(sh|bash|zsh|dash|fish|python|perl|ruby|lua|node)\b/.test(trimmedCmd)) {
      return false;
    }
    // Additional checks for commands that might modify files or execute code.
    if (baseCmd === 'sed' && trimmedCmd.includes('-i')) {
      return false; // sed -i modifies files
    }
    if (baseCmd === 'curl' && (trimmedCmd.includes('>') || /(^|\s)-o\b/.test(trimmedCmd) || /(^|\s)--output\b/.test(trimmedCmd))) {
      return false; // curl with file output (-o/--output/>) writes a file
    }
    if (baseCmd === 'wget' && (trimmedCmd.includes('>') || /(^|\s)-O\b/.test(trimmedCmd) || /(^|\s)--output-document\b/.test(trimmedCmd))) {
      return false; // wget with file output writes a file
    }
    if (baseCmd === 'find' && /(^|\s)-(exec|execdir|ok|okdir|delete)\b/.test(trimmedCmd)) {
      return false; // find -exec/-ok runs arbitrary commands; -delete removes files
    }
    if (baseCmd === 'awk' && (/\bsystem\s*\(/.test(trimmedCmd) || /\bgetline\b/.test(trimmedCmd) || trimmedCmd.includes('>'))) {
      return false; // awk can exec (system/getline) or write files (>)
    }
    if (baseCmd === 'sort' && (/(^|\s)-o\b/.test(trimmedCmd) || trimmedCmd.includes('>'))) {
      return false; // sort -o / redirect writes a file
    }
    // npm/pip/cargo/yarn install commands have side effects
    if ((baseCmd === 'npm' || baseCmd === 'yarn' || baseCmd === 'pnpm') &&
        /\b(install|add|remove|uninstall|publish|link|unlink|deprecate|audit fix|fund)\b/.test(trimmedCmd)) {
      return false;
    }
    if ((baseCmd === 'pip' || baseCmd === 'pip3') && /\binstall\b/.test(trimmedCmd)) {
      return false; // pip install modifies system
    }
    if (baseCmd === 'cargo' && /\b(install|publish|update|remove)\b/.test(trimmedCmd)) {
      return false;
    }
    return true;
  }

  // Check for git read commands
  if (trimmedCmd.startsWith('git ')) {
    const gitCmd = trimmedCmd.slice(4).trim();
    for (const roGitCmd of READ_ONLY_COMMANDS.filter(c => c.startsWith('git '))) {
      if (gitCmd.startsWith(roGitCmd.slice(4))) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a command is a bounded validation command.
 *
 * Segment-aware for the same reason as `isReadOnlyCommand`: without it,
 * `npm test && rm -rf /tmp/x` matches the leading validation pattern and is
 * auto-approved in full.
 */
export function isValidationCommand(cmd: string): boolean {
  return everySegmentSatisfies(cmd, segment =>
    VALIDATION_COMMAND_PATTERNS.some(pattern => pattern.test(segment))
  );
}

/**
 * Check if a command matches dangerous patterns.
 * Returns the first matched dangerous pattern, or null if safe.
 */
export function checkDangerousCommand(cmd: string): { pattern: RegExp; reason: string } | null {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(cmd)) {
      return { pattern, reason };
    }
  }
  return null;
}

/**
 * Check if a command is potentially destructive.
 */
export function isPotentiallyDestructive(cmd: string): boolean {
  for (const pattern of POTENTIALLY_DESTRUCTIVE_PATTERNS) {
    if (pattern.test(cmd)) {
      return true;
    }
  }
  return false;
}

/**
 * Get the security assessment for a command.
 */
export function assessCommandSecurity(cmd: string): {
  level: 'safe' | 'caution' | 'dangerous' | 'blocked';
  reason?: string;
  isReadOnly: boolean;
} {
  // Check for blocked commands
  const dangerousMatch = checkDangerousCommand(cmd);
  if (dangerousMatch) {
    return {
      level: 'blocked',
      reason: dangerousMatch.reason,
      isReadOnly: false,
    };
  }

  // Check for read-only commands
  if (isReadOnlyCommand(cmd)) {
    return {
      level: 'safe',
      isReadOnly: true,
    };
  }

  // Check for common verification commands explicitly requested by users.
  if (isValidationCommand(cmd)) {
    return {
      level: 'safe',
      reason: 'Validation command',
      isReadOnly: true,
    };
  }

  // Check for potentially destructive commands
  if (isPotentiallyDestructive(cmd)) {
    return {
      level: 'caution',
      reason: 'Command may have destructive effects',
      isReadOnly: false,
    };
  }

  // Default: ask for confirmation for unknown commands
  return {
    level: 'caution',
    reason: 'Command requires confirmation',
    isReadOnly: false,
  };
}

/**
 * Sandbox execution options.
 */
export interface SandboxOptions {
  mode: 'none' | 'docker' | 'bubblewrap';
  container?: string;
  timeout?: number;
  network?: boolean;
}

/**
 * Default sandbox options (disabled).
 */
export const DEFAULT_SANDBOX_OPTIONS: SandboxOptions = {
  mode: 'none',
};

/**
 * Wrap command for sandbox execution.
 * Returns the modified command for sandbox execution.
 */
export function wrapForSandbox(cmd: string, options: SandboxOptions): string {
  if (options.mode === 'none') {
    return cmd;
  }

  if (options.mode === 'docker') {
    const container = options.container || 'orion-code-sandbox';
    const networkFlag = options.network ? '' : '--network none';
    return `docker exec ${networkFlag} ${container} sh -c '${cmd.replace(/'/g, "'\\''")}'`;
  }

  if (options.mode === 'bubblewrap') {
    // bubblewrap (bwrap) for Linux sandboxing
    const networkFlag = options.network ? '' : '--unshare-net';
    return `bwrap ${networkFlag} --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /bin /bin --bind /tmp /tmp --proc /proc --dev-bind /dev /dev sh -c '${cmd.replace(/'/g, "'\\''")}'`;
  }

  return cmd;
}
