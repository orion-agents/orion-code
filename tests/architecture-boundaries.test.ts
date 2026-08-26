import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join, normalize, relative, resolve } from 'path';
import ts from 'typescript';

const SRC_ROOT = resolve(__dirname, '../src');
const DEPRECATED_PUBLIC_TYPES = [
  'OpenHorseConfig',
  'OpenHorseRuntime',
  'OpenHorseCLIConfig',
  'OpenHorseTool',
  'OpenHorseUiRuntime',
  'OpenHorseInkRuntime',
] as const;

function sourceFiles(directory = SRC_ROOT): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/u.test(entry.name) ? [normalize(path)] : [];
  });
}

function resolveSourceImport(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const target = resolve(dirname(importer), specifier);
  const candidates = [
    `${target}.ts`,
    `${target}.tsx`,
    join(target, 'index.ts'),
    join(target, 'index.tsx'),
  ];
  const resolvedPath = candidates.find(existsSync);
  return resolvedPath ? normalize(resolvedPath) : null;
}

function isRuntimeImport(statement: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(statement)) {
    if (statement.isTypeOnly) return false;
    return (
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause) ||
      statement.exportClause.elements.some(element => !element.isTypeOnly)
    );
  }

  const clause = statement.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) {
    return true;
  }
  return clause.namedBindings.elements.some(element => !element.isTypeOnly);
}

function valueDependencyGraph(files: readonly string[]): Map<string, string[]> {
  const fileSet = new Set(files);
  const graph = new Map(files.map(file => [file, [] as string[]]));

  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const addDependency = (specifier: string): void => {
      const dependency = resolveSourceImport(file, specifier);
      if (dependency && fileSet.has(dependency)) graph.get(file)?.push(dependency);
    };

    for (const statement of source.statements) {
      if (
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        isRuntimeImport(statement)
      ) {
        addDependency(statement.moduleSpecifier.text);
      }
    }

    const visitRuntimeLoads = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0]) &&
        ((ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
          node.expression.kind === ts.SyntaxKind.ImportKeyword)
      ) {
        addDependency(node.arguments[0].text);
      }
      ts.forEachChild(node, visitRuntimeLoads);
    };
    visitRuntimeLoads(source);
  }
  return graph;
}

function findPath(
  graph: ReadonlyMap<string, readonly string[]>,
  start: string,
  target: string,
  seen = new Set<string>()
): string[] | null {
  if (start === target) return [start];
  if (seen.has(start)) return null;
  seen.add(start);
  for (const dependency of graph.get(start) ?? []) {
    const suffix = findPath(graph, dependency, target, seen);
    if (suffix) return [start, ...suffix];
  }
  return null;
}

describe('architecture boundaries (#70)', () => {
  it('does not redeclare or export deprecated OpenHorse public type names', () => {
    const offenders = sourceFiles().flatMap(file => {
      const source = readFileSync(file, 'utf8');
      return DEPRECATED_PUBLIC_TYPES.filter(name =>
        new RegExp(`\\b${name}\\b`, 'u').test(source)
      ).map(name => `${relative(SRC_ROOT, file)}:${name}`);
    });
    expect(offenders).toEqual([]);
  });

  it('keeps commands/runtime value dependencies acyclic', () => {
    const files = sourceFiles();
    const graph = valueDependencyGraph(files);
    const crossBoundaryCycles: string[] = [];

    for (const [source, dependencies] of graph) {
      for (const dependency of dependencies) {
        const crossesBoundary =
          (source.includes('/commands/') && dependency.includes('/runtime/')) ||
          (source.includes('/runtime/') && dependency.includes('/commands/'));
        if (!crossesBoundary) continue;
        const returnPath = findPath(graph, dependency, source);
        if (returnPath) {
          crossBoundaryCycles.push(
            [source, ...returnPath].map(file => relative(SRC_ROOT, file)).join(' -> ')
          );
        }
      }
    }

    expect(crossBoundaryCycles).toEqual([]);
  });

  it('physically removes legacy agent, harness, runner, and mock SDK owners', () => {
    const removed = [
      'init.ts',
      'agents/coder.ts',
      'agents/coordinator.ts',
      'agents/fork.ts',
      'agents/leader.ts',
      'agents/router.ts',
      'agents/worker-pool.ts',
      'core/agent.ts',
      'core/brain.ts',
      'harness/harness.ts',
      'harness/safety.ts',
      'services/agent-runner.ts',
      'services/task-manager.ts',
      'sdk/index.ts',
      'sdk/init.ts',
      'sdk/query.ts',
      'sdk/sessions.ts',
      'sdk/types.ts',
    ];
    expect(removed.filter(path => existsSync(join(SRC_ROOT, path)))).toEqual([]);
  });
});
