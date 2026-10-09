/**
 * v0.3.23 T23-B1/B2 — lightweight repository symbol index.
 *
 * Parses TypeScript/JavaScript sources with the compiler API (already a
 * dependency) into a per-file record: symbols (functions/classes/interfaces/
 * types/enums), their exportedness, and resolved relative import edges.
 *
 * Maintenance is incremental: each file keeps a mtime+size digest, and
 * `update()` re-parses only the stale subset. The index never reads file
 * CONTENT beyond parsing — it follows the workspace root and skips the usual
 * high-noise directories (node_modules, dist, .git, hidden, build outputs).
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, relative, resolve, dirname } from 'path';

import ts from 'typescript';

export interface RepoSymbolEntryV1 {
  readonly name: string;
  readonly kind:
    | 'function'
    | 'class'
    | 'interface'
    | 'type'
    | 'enum'
    | 'const'
    | 'let'
    | 'var'
    | 'method';
  readonly file: string;
  readonly line: number;
  readonly exported: boolean;
}

export interface RepoFileRecordV1 {
  /** Workspace-relative POSIX-style path. */
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly symbols: readonly RepoSymbolEntryV1[];
  /** Workspace-relative paths this file imports (relative specifiers only). */
  readonly imports: readonly string[];
  readonly exportedNames: readonly string[];
}

export interface RepoIndexStatsV1 {
  readonly files: number;
  readonly parsed: number;
  readonly skipped: number;
  readonly symbols: number;
  readonly durationMs: number;
  readonly incremental: boolean;
}

export interface RepoSymbolIndexOptionsV1 {
  readonly include?: readonly string[];
  readonly ignore?: readonly string[];
  readonly maxFiles?: number;
}

const DEFAULT_IGNORE = [
  'node_modules',
  'dist',
  'build',
  'out',
  '.git',
  'coverage',
  '.cache',
  'target',
  'vendor',
  '__pycache__',
];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf('.')));
}

/** Walk the workspace root collecting source files (bounded). */
function walkSources(
  root: string,
  ignore: ReadonlySet<string>,
  maxFiles: number
): { paths: string[]; skipped: number } {
  const paths: string[] = [];
  let skipped = 0;
  const visit = (directory: string): void => {
    if (paths.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (paths.length >= maxFiles) return;
      if (entry.startsWith('.') || ignore.has(entry)) continue;
      const absolute = join(directory, entry);
      let stats;
      try {
        stats = statSync(absolute);
      } catch {
        continue;
      }
      if (stats.isDirectory()) visit(absolute);
      else if (stats.isFile() && isSourceFile(entry)) {
        if (paths.length < maxFiles) paths.push(absolute);
        else skipped += 1;
      }
    }
  };
  visit(root);
  return { paths, skipped };
}

function fileDigest(stats: { mtimeMs: number; size: number }): string {
  return `${Math.round(stats.mtimeMs)}:${stats.size}`;
}

/** Extract symbols + import edges from one source file. */
function parseSource(
  root: string,
  absolutePath: string
): {
  symbols: RepoSymbolEntryV1[];
  imports: string[];
  exportedNames: string[];
} {
  const relativePath = relative(root, absolutePath).split('\\').join('/');
  const source = ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const symbols: RepoSymbolEntryV1[] = [];
  const imports: string[] = [];
  const exportedNames: string[] = [];
  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const push = (
    node: ts.Node,
    name: string,
    kind: RepoSymbolEntryV1['kind'],
    exported: boolean
  ): void => {
    if (!name) return;
    symbols.push({ name, kind, file: relativePath, line: lineOf(node), exported });
    if (exported) exportedNames.push(name);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (specifier.startsWith('.')) {
        const resolvedBase = resolve(dirname(absolutePath), specifier);
        for (const candidate of [
          resolvedBase,
          `${resolvedBase}.ts`,
          `${resolvedBase}.tsx`,
          `${resolvedBase}.js`,
          `${resolvedBase}.jsx`,
          join(resolvedBase, 'index.ts'),
          join(resolvedBase, 'index.js'),
        ]) {
          if (existsSync(candidate) && !statSync(candidate).isDirectory()) {
            imports.push(relative(root, candidate).split('\\').join('/'));
            break;
          }
        }
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name)
      push(
        node,
        node.name.text,
        'function',
        node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) === true
      );
    else if (ts.isClassDeclaration(node) && node.name)
      push(
        node,
        node.name.text,
        'class',
        node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) === true
      );
    else if (ts.isInterfaceDeclaration(node) && node.name)
      push(
        node,
        node.name.text,
        'interface',
        node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) === true
      );
    else if (ts.isTypeAliasDeclaration(node) && node.name)
      push(
        node,
        node.name.text,
        'type',
        node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) === true
      );
    else if (ts.isEnumDeclaration(node) && node.name)
      push(
        node,
        node.name.text,
        'enum',
        node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) === true
      );
    else if (ts.isVariableStatement(node)) {
      const exported = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) === true;
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          const kind =
            declaration.name.getText(source).length > 0 &&
            node.declarationList.flags & ts.NodeFlags.Const
              ? 'const'
              : node.declarationList.flags & ts.NodeFlags.Let
                ? 'let'
                : 'var';
          push(node, declaration.name.text, kind as RepoSymbolEntryV1['kind'], exported);
        }
      }
    } else if (
      (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      ts.isIdentifier(node.name)
    ) {
      push(node, node.name.text, 'method', false);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return { symbols, imports, exportedNames };
}

/**
 * The workspace symbol index. Construction does not parse anything; call
 * `build()` (full) or `update()` (incremental).
 */
export class RepoSymbolIndexV1 {
  private readonly root: string;
  private readonly ignore: ReadonlySet<string>;
  private readonly maxFiles: number;
  private readonly files = new Map<string, RepoFileRecordV1>();
  private readonly digests = new Map<string, string>();

  constructor(root: string, options: RepoSymbolIndexOptionsV1 = {}) {
    this.root = resolve(root);
    this.ignore = new Set([...DEFAULT_IGNORE, ...(options.ignore ?? [])]);
    this.maxFiles = options.maxFiles ?? 5_000;
  }

  get workspaceRoot(): string {
    return this.root;
  }

  /** Full build: parse every source file under the root. */
  build(): RepoIndexStatsV1 {
    this.files.clear();
    this.digests.clear();
    return this.update();
  }

  /** Incremental update: re-parse only files whose digest changed or that are new. */
  update(): RepoIndexStatsV1 {
    const startedAt = Date.now();
    const { paths, skipped } = walkSources(this.root, this.ignore, this.maxFiles);
    const seen = new Set<string>();
    let parsed = 0;
    let symbolCount = 0;
    for (const absolute of paths) {
      const relativePath = relative(this.root, absolute).split('\\').join('/');
      seen.add(relativePath);
      let stats;
      try {
        stats = statSync(absolute);
      } catch {
        continue;
      }
      const digest = fileDigest(stats);
      const existing = this.digests.get(relativePath);
      if (existing === digest && this.files.has(relativePath)) {
        symbolCount += this.files.get(relativePath)?.symbols.length ?? 0;
        continue;
      }
      try {
        const parsedFile = parseSource(this.root, absolute);
        const record: RepoFileRecordV1 = {
          path: relativePath,
          mtimeMs: stats.mtimeMs,
          size: stats.size,
          symbols: parsedFile.symbols,
          imports: parsedFile.imports,
          exportedNames: parsedFile.exportedNames,
        };
        this.files.set(relativePath, record);
        this.digests.set(relativePath, digest);
        parsed += 1;
        symbolCount += record.symbols.length;
      } catch {
        // Unparsable source: skip it; a later update will retry.
      }
    }
    // Drop records for files that no longer exist.
    for (const path of [...this.files.keys()]) {
      if (!seen.has(path)) {
        this.files.delete(path);
        this.digests.delete(path);
      }
    }
    return {
      files: this.files.size,
      parsed,
      skipped,
      symbols: symbolCount,
      durationMs: Math.max(0, Date.now() - startedAt),
      incremental: this.files.size > 0 && parsed < this.files.size,
    };
  }

  getSnapshot(): ReadonlyMap<string, RepoFileRecordV1> {
    return new Map(this.files);
  }

  findSymbol(name: string): readonly RepoSymbolEntryV1[] {
    const results: RepoSymbolEntryV1[] = [];
    for (const record of this.files.values()) {
      for (const symbol of record.symbols) {
        if (symbol.name === name) results.push(symbol);
      }
    }
    return results;
  }

  importersOf(relativePath: string): readonly string[] {
    const normalized = relativePath.split('\\').join('/');
    const results: string[] = [];
    for (const record of this.files.values()) {
      if (record.imports.includes(normalized)) results.push(record.path);
    }
    return results;
  }

  invalidate(relativePath: string): void {
    const normalized = relativePath.split('\\').join('/');
    this.files.delete(normalized);
    this.digests.delete(normalized);
  }
}
