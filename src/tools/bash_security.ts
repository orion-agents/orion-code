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
  'sed', // when without -i flag
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
  'git branch', // listing branches
  'git tag', // listing tags
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
  // NOTE: `env` is deliberately absent. It is a command wrapper
  // (`env [NAME=VALUE]... COMMAND [ARG]...`), not a read-only command, so
  // allow-listing it classified `env node -e '<anything>'` as safe and ran it
  // without confirmation. A bare `env` (no wrapped command) still resolves to
  // read-only through unwrapCommandWrappers().
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
  'curl', // when without file output
  'wget', // when without file output
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

  // Job control
  // NOTE: the package-manager drivers (npm/npx/yarn/pnpm/pip/cargo) are
  // deliberately NOT listed here. Whether they read or execute depends entirely
  // on the sub-command, so they are allow-listed per sub-command in
  // READ_ONLY_SUBCOMMANDS instead.
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
 * Sub-commands that only read state, keyed by the driver that runs them.
 *
 * The drivers themselves must never appear in READ_ONLY_COMMANDS: `npm run`,
 * `npm exec`, `yarn <script>`, `pnpm run`, `cargo run` and `npx <pkg>` all
 * execute arbitrary project-defined or freshly downloaded code, so the safe
 * surface has to be enumerated rather than subtracted.
 */
export const READ_ONLY_SUBCOMMANDS: Record<string, readonly string[]> = {
  git: [
    'status',
    'log',
    'diff',
    'show',
    'branch',
    'tag',
    'remote',
    'rev-parse',
    'ls-files',
    'ls-tree',
  ],
  npm: ['list', 'ls', 'info', 'view', 'search', 'outdated', 'why'],
  yarn: ['list', 'info', 'why'],
  pnpm: ['list', 'ls', 'info', 'why', 'outdated'],
  cargo: ['tree', 'metadata', 'search'],
  pip: ['list', 'show', 'freeze'],
  pip3: ['list', 'show', 'freeze'],
};

/**
 * git options that hand execution to an external program or write a file,
 * whichever sub-command they are attached to.
 */
const GIT_UNSAFE_OPTIONS = /(^|\s)--(ext-diff|extcmd|output|exec-path|upload-pack|receive-pack)\b/;

/**
 * `git branch` / `git tag` only list when they are given nothing but these
 * flags. Any other argument may create, move or delete a ref, so the allow-list
 * is deliberately valueless flags only -- `git branch --contains HEAD` reads,
 * but prompting for it is far cheaper than letting `git branch -D main` through.
 */
const GIT_LISTING_FLAGS: Record<string, RegExp> = {
  branch:
    /^(-a|--all|-r|--remotes|-v|-vv|--verbose|-l|--list|--no-color|--color(=.+)?|--sort=.+|--format=.+)$/,
  tag: /^(-l|--list|-n\d*|-i|--ignore-case|--no-color|--color(=.+)?|--sort=.+|--format=.+)$/,
};

/** `git remote` reads with no argument, or via these two sub-sub-commands. */
const GIT_REMOTE_READ_ONLY_ACTIONS = new Set(['show', 'get-url']);

/**
 * Validation commands that are safe enough to run without an interactive
 * confirmation prompt. They may read the project and execute local test code,
 * but they are standard verification steps for coding-agent work.
 */
export const VALIDATION_COMMAND_PATTERNS = [
  /^(npx\s+)?tsc\b.*--noEmit\b/,
  /^npx\s+(jest|vitest|eslint)\b/,
  /^(npm|pnpm|yarn)\s+test(\s|$)/,
  /^npm\s+run\s+(test|lint|typecheck|check|build)(\s|$)/,
  /^(pnpm|yarn)\s+(test|lint|typecheck|check)(\s|$)/,
];

/**
 * Dangerous command patterns that should always be blocked or require confirmation.
 */
export const DANGEROUS_PATTERNS = [
  // Filesystem destruction.
  // NOTE: these literal forms are a backstop only. Flag order, long options and
  // trailing arguments all defeat them, so the authoritative check is the
  // structured one in findDestructiveRmTarget(); see checkDangerousCommand().
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
    if (inSingleQuote) {
      // Single quotes disable every expansion, so the contents stay inert.
      current += ch;
      continue;
    }
    if (inDoubleQuote) {
      // Double quotes only suppress globbing and word splitting -- bash still
      // expands `$(...)` and backticks inside them. Skipping the substitution
      // check here made `echo "$(rm -rf $HOME)"` classify as safe/read-only and
      // auto-approve, i.e. a straight command-execution bypass.
      if (ch === '`' || (ch === '$' && next === '(')) {
        supported = false;
      }
      current += ch;
      continue;
    }

    // Command and process substitution can hide an arbitrary command inside an
    // otherwise innocent-looking line, and neither is worth modelling here.
    if (
      ch === '`' ||
      (ch === '$' && next === '(') ||
      ((ch === '<' || ch === '>') && next === '(')
    ) {
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

  // A wrapper decides nothing: `env`, `timeout`, `nice` and friends just hand
  // control to whatever follows, so classify that instead. Without this,
  // matching on the head token alone made `env node -e '<code>'` read-only.
  const unwrapped = unwrapCommandWrappers(trimmedCmd.split(/\s+/).filter(Boolean));
  if (unwrapped) {
    // Running as another user is never read-only, however benign the payload.
    if (unwrapped.privileged) return false;
    // `env` / `printenv` with no wrapped command just prints the environment.
    if (unwrapped.tokens.length === 0) return true;
    return isReadOnlySegment(unwrapped.tokens.join(' '));
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
    if (
      baseCmd === 'curl' &&
      (trimmedCmd.includes('>') ||
        /(^|\s)-o\b/.test(trimmedCmd) ||
        /(^|\s)--output\b/.test(trimmedCmd))
    ) {
      return false; // curl with file output (-o/--output/>) writes a file
    }
    if (
      baseCmd === 'wget' &&
      (trimmedCmd.includes('>') ||
        /(^|\s)-O\b/.test(trimmedCmd) ||
        /(^|\s)--output-document\b/.test(trimmedCmd))
    ) {
      return false; // wget with file output writes a file
    }
    if (baseCmd === 'find' && /(^|\s)-(exec|execdir|ok|okdir|delete)\b/.test(trimmedCmd)) {
      return false; // find -exec/-ok runs arbitrary commands; -delete removes files
    }
    if (
      baseCmd === 'awk' &&
      (/\bsystem\s*\(/.test(trimmedCmd) ||
        /\bgetline\b/.test(trimmedCmd) ||
        trimmedCmd.includes('>'))
    ) {
      return false; // awk can exec (system/getline) or write files (>)
    }
    if (baseCmd === 'sort' && (/(^|\s)-o\b/.test(trimmedCmd) || trimmedCmd.includes('>'))) {
      return false; // sort -o / redirect writes a file
    }
    return true;
  }

  // Driver commands are read-only only for an explicitly allow-listed
  // sub-command, matched on the exact token.
  return isReadOnlyDriverInvocation(trimmedCmd);
}

/**
 * Classify `git`, `npm`, `cargo` and friends by their sub-command.
 *
 * Matching is on the exact sub-command token. The previous implementation used
 * `startsWith`, which let `git difftool --extcmd=...` match the `git diff`
 * entry and run an arbitrary program.
 */
function isReadOnlyDriverInvocation(segment: string): boolean {
  const tokens = segment.split(/\s+/).filter(token => token.length > 0);
  const driver = tokens[0];
  const subcommand = tokens[1];
  const allowed = driver ? READ_ONLY_SUBCOMMANDS[driver] : undefined;

  if (!allowed || !subcommand || !allowed.includes(subcommand)) {
    return false;
  }

  if (driver !== 'git') {
    return true;
  }

  if (GIT_UNSAFE_OPTIONS.test(segment)) {
    return false;
  }

  const args = tokens.slice(2);

  if (subcommand === 'remote') {
    // `git remote [-v]` lists; `git remote show|get-url <name>` reads.
    // Everything else -- add, remove, rename, set-url, prune -- mutates.
    const positional = args.filter(arg => arg !== '-v' && arg !== '--verbose');
    return positional.length === 0 || GIT_REMOTE_READ_ONLY_ACTIONS.has(positional[0]);
  }

  const listingFlags = GIT_LISTING_FLAGS[subcommand];
  if (listingFlags) {
    return args.every(arg => listingFlags.test(arg));
  }

  return true;
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
 * Wrappers that run another command with a modified environment, scheduling
 * class or lifetime. They neither escalate privilege nor change what the
 * wrapped command does, so the *wrapped* command decides the classification.
 */
const TRANSPARENT_WRAPPERS = [
  'env',
  'timeout',
  'nice',
  'ionice',
  'stdbuf',
  'setsid',
  'nohup',
  'time',
  'command',
  'builtin',
  'exec',
  'xargs',
] as const;

/**
 * Wrappers that escalate privilege. The wrapped command may look read-only, but
 * running it as another user never is, so these never inherit a `safe` verdict.
 */
const PRIVILEGE_WRAPPERS = new Set(['sudo', 'doas']);

/** Wrappers that may precede `rm` without changing what it deletes. */
const COMMAND_WRAPPERS = new Set<string>([...PRIVILEGE_WRAPPERS, ...TRANSPARENT_WRAPPERS]);

/**
 * Flags that consume the *following* token as their value, per wrapper.
 *
 * Anything absent here is treated as self-contained, so a value that is
 * attached with `=` (`--unset=PATH`) needs no entry. Getting this wrong in the
 * conservative direction only costs a confirmation prompt; getting it wrong the
 * other way would let a flag value be mistaken for the wrapped binary.
 */
const WRAPPER_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  timeout: new Set(['-k', '--kill-after', '-s', '--signal']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid']),
  stdbuf: new Set(['-i', '--input', '-o', '--output', '-e', '--error']),
  time: new Set(['-f', '--format', '-o', '--output']),
  exec: new Set(['-a']),
  xargs: new Set([
    '-I',
    '-i',
    '--replace',
    '-n',
    '--max-args',
    '-P',
    '--max-procs',
    '-d',
    '--delimiter',
    '-a',
    '--arg-file',
    '-E',
    '-e',
    '--eof',
    '-L',
    '-l',
    '--max-lines',
    '-s',
    '--max-chars',
  ]),
  sudo: new Set([
    '-u',
    '--user',
    '-g',
    '--group',
    '-p',
    '--prompt',
    '-D',
    '--chdir',
    '-R',
    '--chroot',
  ]),
  doas: new Set(['-u', '-C']),
};

/** Wrappers that take positional operands of their own before the command. */
const WRAPPER_POSITIONAL_OPERANDS: Record<string, number> = {
  // `timeout DURATION COMMAND ...`
  timeout: 1,
};

/** `env env env ...` is pathological, not legitimate; bound the unwrapping. */
const MAX_WRAPPER_DEPTH = 8;

/** Outcome of peeling command wrappers off the head of a segment. */
interface UnwrappedCommand {
  /** Tokens of the real command. Empty when the wrapper had no command
   *  (`env` on its own just prints the environment). */
  tokens: string[];
  /** True when `sudo`/`doas` was one of the peeled wrappers. */
  privileged: boolean;
}

/**
 * Peel `env`/`timeout`/`sudo`/... off the head of a segment and return the
 * command that will actually run.
 *
 * Returns null when the segment does not start with a wrapper, so callers can
 * cheaply tell "nothing to do" from "resolved to an empty command".
 *
 * Wrapper-specific operands are skipped so the resolution survives realistic
 * spellings: `env -i FOO=bar node -e '...'`, `timeout -k 1s 5 rm -rf /` and
 * `nice -10 ls` all resolve to `node`, `rm` and `ls` respectively.
 */
function unwrapCommandWrappers(tokens: readonly string[]): UnwrappedCommand | null {
  let index = 0;
  let privileged = false;
  let unwrapped = false;

  for (let depth = 0; depth < MAX_WRAPPER_DEPTH; depth++) {
    const head = tokens[index];
    if (head === undefined) break;

    // Accept absolute paths: /usr/bin/env is the same wrapper as env.
    const wrapper = head.slice(head.lastIndexOf('/') + 1);
    if (!COMMAND_WRAPPERS.has(wrapper)) break;

    unwrapped = true;
    if (PRIVILEGE_WRAPPERS.has(wrapper)) privileged = true;
    index++;

    const valueFlags = WRAPPER_VALUE_FLAGS[wrapper];
    let endOfOptions = false;

    while (index < tokens.length) {
      const token = tokens[index];

      if (!endOfOptions && token === '--') {
        endOfOptions = true;
        index++;
        continue;
      }

      if (!endOfOptions && token.length > 1 && token.startsWith('-')) {
        const flag = token.split('=')[0];
        index += valueFlags?.has(flag) && !token.includes('=') ? 2 : 1;
        continue;
      }

      // `env` accepts any number of NAME=value assignments before the command.
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        index++;
        continue;
      }

      break;
    }

    let operands = WRAPPER_POSITIONAL_OPERANDS[wrapper] ?? 0;
    while (operands > 0 && index < tokens.length) {
      index++;
      operands--;
    }
  }

  if (!unwrapped) return null;
  return { tokens: tokens.slice(index), privileged };
}

/** A parsed `rm` invocation: the flags that matter, plus its operands. */
interface RmInvocation {
  recursive: boolean;
  force: boolean;
  noPreserveRoot: boolean;
  targets: string[];
}

/**
 * Targets whose deletion is never a legitimate agent action, in the normalised
 * form produced by {@link normalizeRmTarget}.
 */
const CATASTROPHIC_RM_TARGETS = new Set([
  '/',
  '~',
  '.',
  '..',
  '*',
  // System roots: wiping any of these bricks the machine just as thoroughly as
  // `/` does, and no build or cleanup step has a reason to touch them.
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib64',
  '/opt',
  '/proc',
  '/root',
  '/sbin',
  '/srv',
  '/sys',
  '/usr',
  '/var',
  '/home',
  '/Users',
  '/System',
  '/Library',
  '/Applications',
]);

/**
 * Reduce an `rm` operand to a canonical path so that every spelling of the same
 * catastrophic target collapses onto one key: `/`, `/*`, `/**` and `///` all
 * become `/`, and `~/`, `~/*`, `$HOME`, `${HOME}/` all become `~`.
 */
function normalizeRmTarget(raw: string): string {
  let target = raw.trim();

  const quote = target[0];
  if ((quote === "'" || quote === '"') && target.endsWith(quote) && target.length > 1) {
    target = target.slice(1, -1).trim();
  }

  target = target.replace(/^\$\{HOME\}/, '~').replace(/^\$HOME/, '~');
  // A trailing glob deletes the directory's contents, which is the same disaster
  // as deleting the directory itself.
  target = target.replace(/\/\*+$/, '/');
  target = target.replace(/\/{2,}/g, '/');

  if (target.length > 1) {
    target = target.replace(/\/+$/, '');
  }

  return target;
}

/**
 * Parse a single command segment as an `rm` invocation.
 *
 * Returns null when the segment does not run `rm`. Flags are collected
 * order-independently, so `-rf`, `-fr`, `-r -f` and `--recursive --force` are
 * all recognised as the same request.
 */
function parseRmInvocation(segment: string): RmInvocation | null {
  const rawTokens = segment.split(/\s+/).filter(token => token.length > 0);
  // Wrappers hide the real binary from a head-token check: without unwrapping
  // their own flags and operands, `timeout 5 rm -rf /` never parses as `rm`.
  const tokens = unwrapCommandWrappers(rawTokens)?.tokens ?? rawTokens;

  let index = 0;
  const binary = tokens[index];
  if (!binary || !/(^|\/)rm$/.test(binary)) {
    return null;
  }
  index++;

  const invocation: RmInvocation = {
    recursive: false,
    force: false,
    noPreserveRoot: false,
    targets: [],
  };
  let endOfOptions = false;

  for (; index < tokens.length; index++) {
    const token = tokens[index];

    if (!endOfOptions && token === '--') {
      endOfOptions = true;
      continue;
    }

    if (!endOfOptions && token.startsWith('--')) {
      if (token === '--recursive') invocation.recursive = true;
      else if (token === '--force') invocation.force = true;
      else if (token === '--no-preserve-root') invocation.noPreserveRoot = true;
      continue;
    }

    if (!endOfOptions && token.length > 1 && token.startsWith('-')) {
      for (const flag of token.slice(1)) {
        if (flag === 'r' || flag === 'R') invocation.recursive = true;
        else if (flag === 'f') invocation.force = true;
      }
      continue;
    }

    invocation.targets.push(token);
  }

  return invocation;
}

/**
 * Structured replacement for the literal `rm -rf /` patterns.
 *
 * Returns the normalised target that makes the command catastrophic, or null.
 * Matching on parsed flags and canonicalised operands closes the rewrites that
 * defeat the anchored patterns: `rm -fr /`, `rm -r -f /`,
 * `rm --recursive --force /`, `rm -rf /*` and, most importantly,
 * `rm -rf / --no-preserve-root` -- the only form that actually deletes anything
 * on GNU coreutils.
 */
export function findDestructiveRmTarget(cmd: string): string | null {
  for (const segment of scanShellCommand(cmd).segments) {
    const invocation = parseRmInvocation(segment);
    if (!invocation) continue;

    // `rm /` without -r or -f cannot remove a directory, so it is noise rather
    // than a threat. Either flag turns the same operand into a real deletion.
    if (!invocation.recursive && !invocation.force) continue;

    for (const target of invocation.targets) {
      if (CATASTROPHIC_RM_TARGETS.has(normalizeRmTarget(target))) {
        return target;
      }
    }
  }

  return null;
}

/** Reported when the structured `rm` check fires rather than a literal pattern. */
const DESTRUCTIVE_RM_PATTERN = /\brm\b/;

/** Human-readable description of why a normalised target is off-limits. */
function describeCatastrophicTarget(raw: string): string {
  const normalized = normalizeRmTarget(raw);

  if (normalized === '/') return 'the root directory';
  if (normalized === '~') return 'the home directory';
  if (normalized === '.' || normalized === '..' || normalized === '*') {
    return 'the current directory contents';
  }
  return `the system directory ${normalized}`;
}

/**
 * Check if a command matches dangerous patterns.
 * Returns the first matched dangerous pattern, or null if safe.
 */
export function checkDangerousCommand(cmd: string): { pattern: RegExp; reason: string } | null {
  const rmTarget = findDestructiveRmTarget(cmd);
  if (rmTarget) {
    return {
      pattern: DESTRUCTIVE_RM_PATTERN,
      reason: `Attempting to delete ${describeCatastrophicTarget(rmTarget)} (${rmTarget})`,
    };
  }

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

/*
 * The `SandboxOptions` / `DEFAULT_SANDBOX_OPTIONS` / `wrapForSandbox` trio that
 * used to live here has been removed.
 *
 * `wrapForSandbox` advertised network isolation it never delivered: it emitted
 * `docker exec --network none <container> sh -c '<cmd>'`, but `--network` is a
 * `docker run` flag and `docker exec` rejects it with `unknown flag`. With
 * `network: true` the flag was dropped altogether, so neither configuration
 * isolated anything. Building the wrapper as a shell string was unsound anyway:
 * every layer re-parses the command, so a quoting bug becomes a sandbox escape.
 *
 * `src/tools/sandbox.ts` supersedes it with an argv-based implementation that
 * probes backend availability and fails closed. Use `planSandboxedCommand()`
 * from there instead.
 */
