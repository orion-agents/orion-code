import { Buffer } from 'buffer';
import {
  constants,
  existsSync,
  statSync,
  watch as watchFilesystem,
  type BigIntStats,
  type FSWatcher,
} from 'fs';
import { open, readdir, realpath, stat } from 'fs/promises';
import { homedir } from 'os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path';
import { load as loadYaml } from 'js-yaml';
import { getConfigHome } from '../../product/paths';
import { digestRuntimeValue } from '../protocol/canonical';
import {
  LAZY_SKILL_RUNTIME_VERSION,
  type SkillDefinitionV1,
  type SkillDescriptorV1,
  type SkillInvalidationV1,
  type SkillObservationV1,
  type SkillProviderSubscriptionV1,
  type SkillProviderV1,
  type SkillResourceDescriptorV1,
  type SkillResourceV1,
  type SkillScopeV1,
  type SkillSourceScopeV1,
} from './types';

export const FILESYSTEM_SKILL_PROVIDER_VERSION = 1 as const;
export const DEFAULT_FILESYSTEM_SKILL_PROVIDER_ID = 'filesystem-skills-v1';

const SKILL_FILE_NAME = 'SKILL.md';
const DEFAULT_MAX_FRONTMATTER_BYTES = 16 * 1024;
const DEFAULT_MAX_DEFINITION_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RESOURCE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_SKILLS = 2_048;
const DEFAULT_MAX_RESOURCE_FILES = 2_048;
const DEFAULT_MAX_WATCH_PATHS = 1_024;
const DEFAULT_WATCH_DEBOUNCE_MS = 25;
const FRONTMATTER_CHUNK_BYTES = 512;
const OMITTED_RESOURCE_NAMES = new Set(['.DS_Store']);
const OMITTED_RESOURCE_DIRECTORIES = new Set(['.git', 'node_modules']);

export type FilesystemSkillSourceScopeV1 = Exclude<SkillSourceScopeV1, 'remote'>;

export interface FilesystemSkillRootV1 {
  readonly path: string;
  readonly sourceScope: FilesystemSkillSourceScopeV1;
}

export interface FilesystemSkillRootOptionsV1 {
  readonly cwd: string;
  /** Existing config.skills.paths value. */
  readonly configuredPaths?: readonly string[];
  readonly configHome?: string;
  readonly builtinRoot?: string;
}

export interface FilesystemSkillWatchHandleV1 {
  close(): void;
}

export type FilesystemSkillWatchFactoryV1 = (
  path: string,
  invalidate: (event: string) => void
) => FilesystemSkillWatchHandleV1;

export interface FilesystemSkillProviderOptionsV1 {
  readonly roots: readonly FilesystemSkillRootV1[];
  readonly id?: string;
  readonly watch?: boolean;
  readonly watchFactory?: FilesystemSkillWatchFactoryV1;
  readonly watchDebounceMs?: number;
  readonly maxFrontmatterBytes?: number;
  readonly maxDefinitionBytes?: number;
  readonly maxResourceBytes?: number;
  readonly maxSkills?: number;
  readonly maxResourceFiles?: number;
  readonly maxWatchPaths?: number;
}

export interface ProductionFilesystemSkillProviderOptionsV1
  extends FilesystemSkillRootOptionsV1, Omit<FilesystemSkillProviderOptionsV1, 'roots'> {}

export interface FilesystemSkillProviderStatsV1 {
  readonly version: 1;
  readonly catalogScans: number;
  readonly rootsObserved: number;
  readonly skillFilesObserved: number;
  readonly frontmatterPrefixReads: number;
  readonly frontmatterPrefixBytes: number;
  readonly definitionReads: number;
  readonly definitionBytes: number;
  readonly resourceReads: number;
  readonly resourceBytes: number;
  readonly unsafeEntriesRejected: number;
  readonly incompleteObservations: number;
  readonly watchInvalidations: number;
  readonly activeWatchers: number;
  readonly watchErrors: number;
}

interface MutableProviderStats {
  catalogScans: number;
  rootsObserved: number;
  skillFilesObserved: number;
  frontmatterPrefixReads: number;
  frontmatterPrefixBytes: number;
  definitionReads: number;
  definitionBytes: number;
  resourceReads: number;
  resourceBytes: number;
  unsafeEntriesRejected: number;
  incompleteObservations: number;
  watchInvalidations: number;
  watchErrors: number;
}

interface NormalizedRootV1 extends FilesystemSkillRootV1 {
  readonly pathDigest: string;
}

interface FileRevisionV1 {
  readonly bytes: number;
  readonly digest: string;
}

interface SkillRecordV1 {
  readonly descriptor: SkillDescriptorV1;
  readonly descriptorComplete: boolean;
  readonly rootRealPath: string;
  readonly skillDirectoryRealPath: string;
  readonly skillFileRealPath: string;
  readonly skillFileRevision: FileRevisionV1;
}

interface RootReceiptV1 {
  readonly pathDigest: string;
  readonly sourceScope: FilesystemSkillSourceScopeV1;
  readonly state: 'missing' | 'observed' | 'incomplete';
  readonly skillCount: number;
}

interface ScanResultV1 {
  readonly records: readonly SkillRecordV1[];
  readonly receipt: RootReceiptV1;
  readonly watchPaths: readonly string[];
  readonly complete: boolean;
}

interface FrontmatterResultV1 {
  readonly metadata: Record<string, unknown>;
  readonly digest: string;
  readonly complete: boolean;
  readonly revision: FileRevisionV1;
}

interface ResourceRecordV1 {
  readonly descriptor: SkillResourceDescriptorV1;
  readonly realPath: string;
  readonly revision: FileRevisionV1;
}

export class FilesystemSkillProviderError extends Error {
  readonly code = 'ORION_FILESYSTEM_SKILL_PROVIDER_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'FilesystemSkillProviderError';
  }
}

/**
 * Descriptor-first provider for Orion's builtin, user, configured, and project roots.
 * list() reads only bounded frontmatter prefixes; bodies/resources are selection-time IO.
 */
export class FilesystemSkillProviderV1 implements SkillProviderV1 {
  readonly version = FILESYSTEM_SKILL_PROVIDER_VERSION;
  readonly id: string;

  private readonly roots: readonly NormalizedRootV1[];
  private readonly watchEnabled: boolean;
  private readonly watchFactory: FilesystemSkillWatchFactoryV1;
  private readonly watchDebounceMs: number;
  private readonly maxFrontmatterBytes: number;
  private readonly maxDefinitionBytes: number;
  private readonly maxResourceBytes: number;
  private readonly maxSkills: number;
  private readonly maxResourceFiles: number;
  private readonly maxWatchPaths: number;
  private readonly listeners = new Set<(value: SkillInvalidationV1) => void>();
  private readonly watchers = new Map<string, FilesystemSkillWatchHandleV1>();
  private readonly records = new Map<string, SkillRecordV1>();
  private readonly resourceManifests = new Map<string, ReadonlyMap<string, ResourceRecordV1>>();
  private readonly mutableStats: MutableProviderStats = {
    catalogScans: 0,
    rootsObserved: 0,
    skillFilesObserved: 0,
    frontmatterPrefixReads: 0,
    frontmatterPrefixBytes: 0,
    definitionReads: 0,
    definitionBytes: 0,
    resourceReads: 0,
    resourceBytes: 0,
    unsafeEntriesRejected: 0,
    incompleteObservations: 0,
    watchInvalidations: 0,
    watchErrors: 0,
  };
  private watchTimer?: NodeJS.Timeout;

  constructor(options: FilesystemSkillProviderOptionsV1) {
    this.id = normalizeIdentifier(
      options.id ?? DEFAULT_FILESYSTEM_SKILL_PROVIDER_ID,
      'Provider id'
    );
    this.roots = normalizeRoots(options.roots);
    this.watchEnabled = options.watch !== false;
    this.watchFactory = options.watchFactory ?? defaultWatchFactory;
    this.watchDebounceMs = integerOption(
      options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS,
      'watchDebounceMs',
      true
    );
    this.maxFrontmatterBytes = integerOption(
      options.maxFrontmatterBytes ?? DEFAULT_MAX_FRONTMATTER_BYTES,
      'maxFrontmatterBytes'
    );
    this.maxDefinitionBytes = integerOption(
      options.maxDefinitionBytes ?? DEFAULT_MAX_DEFINITION_BYTES,
      'maxDefinitionBytes'
    );
    this.maxResourceBytes = integerOption(
      options.maxResourceBytes ?? DEFAULT_MAX_RESOURCE_BYTES,
      'maxResourceBytes'
    );
    this.maxSkills = integerOption(options.maxSkills ?? DEFAULT_MAX_SKILLS, 'maxSkills');
    this.maxResourceFiles = integerOption(
      options.maxResourceFiles ?? DEFAULT_MAX_RESOURCE_FILES,
      'maxResourceFiles'
    );
    this.maxWatchPaths = integerOption(
      options.maxWatchPaths ?? DEFAULT_MAX_WATCH_PATHS,
      'maxWatchPaths'
    );
  }

  async list(scope: SkillScopeV1, signal: AbortSignal): Promise<SkillObservationV1> {
    throwIfAborted(signal);
    this.mutableStats.catalogScans++;
    const allowed = new Set(scope.sourceScopeOrder ?? this.roots.map(root => root.sourceScope));
    const scans: ScanResultV1[] = [];
    let skillCount = 0;
    for (const root of this.roots.filter(item => allowed.has(item.sourceScope))) {
      throwIfAborted(signal);
      const remaining = this.maxSkills - skillCount;
      if (remaining <= 0) {
        scans.push(emptyScan(root, 'incomplete', false));
        continue;
      }
      const scan = await this.scanRoot(root, remaining, signal);
      scans.push(scan);
      skillCount += scan.records.length;
    }

    const records = scans
      .flatMap(scan => scan.records)
      .sort(
        (left, right) =>
          left.descriptor.name.localeCompare(right.descriptor.name) ||
          left.descriptor.id.localeCompare(right.descriptor.id)
      );
    const next = new Map<string, SkillRecordV1>();
    let collision = false;
    for (const record of records) {
      if (next.has(record.descriptor.id)) {
        collision = true;
        continue;
      }
      next.set(record.descriptor.id, record);
    }
    this.records.clear();
    for (const [id, record] of next) this.records.set(id, record);
    this.resourceManifests.clear();

    const complete = scans.every(scan => scan.complete) && !collision;
    if (!complete) this.mutableStats.incompleteObservations++;
    const descriptors = Object.freeze([...next.values()].map(record => record.descriptor));
    const rootReceipts = scans.map(scan => scan.receipt).sort(compareRootReceipts);
    const digest = digestRuntimeValue({
      version: FILESYSTEM_SKILL_PROVIDER_VERSION,
      providerId: this.id,
      complete,
      roots: rootReceipts,
      descriptors,
    });
    const observation: SkillObservationV1 = deepFreeze({
      version: LAZY_SKILL_RUNTIME_VERSION,
      providerId: this.id,
      digest,
      complete,
      descriptors,
    });
    this.reconcileWatchers([
      ...this.roots.map(root => root.path),
      ...scans.flatMap(scan => scan.watchPaths),
    ]);
    return observation;
  }

  async get(id: string, signal: AbortSignal): Promise<SkillDefinitionV1 | undefined> {
    throwIfAborted(signal);
    const record = this.records.get(id);
    if (!record) return undefined;
    const currentPath = await containedRealPath(
      record.skillFileRealPath,
      record.skillDirectoryRealPath,
      record.rootRealPath
    );
    const read = await readBoundedFile(
      currentPath,
      this.maxDefinitionBytes,
      signal,
      'Skill definition'
    );
    if (read.revision.digest !== record.skillFileRevision.digest) {
      throw new FilesystemSkillProviderError(`Skill ${id} changed after catalog observation.`);
    }
    this.mutableStats.definitionReads++;
    this.mutableStats.definitionBytes += read.buffer.byteLength;
    const resources = await this.buildResourceManifest(record, signal);
    const afterManifest = revisionFromStats(await stat(currentPath, { bigint: true }));
    if (afterManifest.digest !== record.skillFileRevision.digest) {
      throw new FilesystemSkillProviderError(`Skill ${id} changed while loading its manifest.`);
    }
    this.resourceManifests.set(
      id,
      new Map(resources.map(resource => [resource.descriptor.path, resource]))
    );
    return deepFreeze({
      ...record.descriptor,
      body: definitionBody(read.buffer.toString('utf8')),
      resourceManifest: resources.map(resource => resource.descriptor),
    });
  }

  async getResource(id: string, path: string, signal: AbortSignal): Promise<SkillResourceV1> {
    throwIfAborted(signal);
    const normalizedPath = normalizeResourcePath(path);
    const record = this.records.get(id);
    const resource = this.resourceManifests.get(id)?.get(normalizedPath);
    if (!record || !resource) {
      throw new FilesystemSkillProviderError(
        `Resource ${normalizedPath} is not in the selected manifest for Skill ${id}.`
      );
    }
    const currentPath = await containedRealPath(
      resource.realPath,
      record.skillDirectoryRealPath,
      record.rootRealPath
    );
    const read = await readBoundedFile(
      currentPath,
      this.maxResourceBytes,
      signal,
      `Skill resource ${normalizedPath}`
    );
    if (read.revision.digest !== resource.revision.digest) {
      throw new FilesystemSkillProviderError(
        `Skill resource changed after manifest capture: ${id}/${normalizedPath}`
      );
    }
    this.mutableStats.resourceReads++;
    this.mutableStats.resourceBytes += read.buffer.byteLength;
    const mediaType = resource.descriptor.mediaType;
    return Object.freeze({
      skillId: id,
      path: normalizedPath,
      digest: resource.descriptor.digest,
      content: isTextMediaType(mediaType)
        ? read.buffer.toString('utf8')
        : new Uint8Array(read.buffer).slice(),
      ...(mediaType ? { mediaType } : {}),
    });
  }

  subscribe(
    invalidate: (invalidation: SkillInvalidationV1) => void,
    signal: AbortSignal
  ): SkillProviderSubscriptionV1 {
    if (signal.aborted) return Object.freeze({ dispose: () => undefined });
    this.listeners.add(invalidate);
    const onAbort = (): void => {
      void subscription.dispose();
    };
    const subscription: SkillProviderSubscriptionV1 = {
      dispose: (): void => {
        signal.removeEventListener('abort', onAbort);
        this.listeners.delete(invalidate);
        if (this.listeners.size === 0) this.closeWatchers();
      },
    };
    signal.addEventListener('abort', onAbort, { once: true });
    this.reconcileWatchers(this.roots.map(root => root.path));
    return subscription;
  }

  stats(): FilesystemSkillProviderStatsV1 {
    return Object.freeze({
      version: FILESYSTEM_SKILL_PROVIDER_VERSION,
      ...this.mutableStats,
      activeWatchers: this.watchers.size,
    });
  }

  private async scanRoot(
    root: NormalizedRootV1,
    remaining: number,
    signal: AbortSignal
  ): Promise<ScanResultV1> {
    this.mutableStats.rootsObserved++;
    try {
      const rootRealPath = await realpath(root.path);
      const rootStats = await stat(rootRealPath);
      if (!rootStats.isDirectory() && !rootStats.isFile()) {
        return emptyScan(root, 'incomplete', false);
      }
      const trustedRoot = rootStats.isFile() ? dirname(rootRealPath) : rootRealPath;
      const candidates = await skillCandidates(
        rootRealPath,
        rootStats.isFile(),
        remaining + 1,
        signal
      );
      const records: SkillRecordV1[] = [];
      const watchPaths = new Set<string>([rootStats.isFile() ? dirname(root.path) : root.path]);
      let complete = true;
      for (const candidate of candidates) {
        throwIfAborted(signal);
        if (records.length >= remaining) {
          complete = false;
          break;
        }
        const record = await this.observeSkill(root, trustedRoot, candidate, signal);
        if (!record) {
          complete = false;
          continue;
        }
        if (!record.descriptorComplete) complete = false;
        records.push(record);
        watchPaths.add(record.skillDirectoryRealPath);
      }
      return {
        records,
        receipt: {
          pathDigest: root.pathDigest,
          sourceScope: root.sourceScope,
          state: complete ? 'observed' : 'incomplete',
          skillCount: records.length,
        },
        watchPaths: [...watchPaths],
        complete,
      };
    } catch (error) {
      return isMissing(error)
        ? emptyScan(root, 'missing', true)
        : emptyScan(root, 'incomplete', false);
    }
  }

  private async observeSkill(
    root: NormalizedRootV1,
    rootRealPath: string,
    candidate: string,
    signal: AbortSignal
  ): Promise<SkillRecordV1 | undefined> {
    try {
      const skillFileRealPath = await realpath(candidate);
      const skillDirectoryRealPath = dirname(skillFileRealPath);
      if (
        !containsPath(rootRealPath, skillDirectoryRealPath) ||
        !containsPath(skillDirectoryRealPath, skillFileRealPath)
      ) {
        this.mutableStats.unsafeEntriesRejected++;
        return undefined;
      }
      const frontmatter = await readFrontmatterPrefix(
        skillFileRealPath,
        this.maxFrontmatterBytes,
        this.maxDefinitionBytes,
        signal,
        this.mutableStats
      );
      const revision = frontmatter.revision;
      const fallbackName = normalizeSkillName(basename(skillDirectoryRealPath));
      const name = stringValue(frontmatter.metadata.name) || fallbackName;
      const requestedCapabilities = normalizeStringList(
        frontmatter.metadata.requestedCapabilities ??
          frontmatter.metadata.capabilities ??
          frontmatter.metadata.tools
      );
      const pathIdentity = digestRuntimeValue({
        root: root.pathDigest,
        relativePath: toPortablePath(relative(rootRealPath, skillDirectoryRealPath)),
      });
      const descriptorBase = {
        id: `filesystem:${root.sourceScope}:${pathIdentity.slice(0, 24)}`,
        name: normalizeIdentifier(name, `Skill name in ${SKILL_FILE_NAME}`),
        description: stringValue(frontmatter.metadata.description).slice(0, 240),
        providerId: this.id,
        sourceScope: root.sourceScope,
        modelInvocable: booleanValue(
          frontmatter.metadata.modelInvocable ?? frontmatter.metadata['model-invocable'],
          !booleanValue(frontmatter.metadata['disable-model-invocation'], false)
        ),
        userInvocable: booleanValue(
          frontmatter.metadata.userInvocable ?? frontmatter.metadata['user-invocable'],
          true
        ),
        requestedCapabilities,
      } as const;
      const digest = digestRuntimeValue({
        version: FILESYSTEM_SKILL_PROVIDER_VERSION,
        descriptor: descriptorBase,
        skillFileRevision: revision.digest,
        frontmatterDigest: frontmatter.digest,
      });
      this.mutableStats.skillFilesObserved++;
      return {
        descriptor: deepFreeze({ ...descriptorBase, digest }),
        descriptorComplete: frontmatter.complete,
        rootRealPath,
        skillDirectoryRealPath,
        skillFileRealPath,
        skillFileRevision: revision,
      };
    } catch (error) {
      if (!isMissing(error)) this.mutableStats.unsafeEntriesRejected++;
      return undefined;
    }
  }

  private async buildResourceManifest(
    record: SkillRecordV1,
    signal: AbortSignal
  ): Promise<readonly ResourceRecordV1[]> {
    const resources: ResourceRecordV1[] = [];
    const pending = [record.skillDirectoryRealPath];
    let directoriesObserved = 0;
    while (pending.length > 0) {
      throwIfAborted(signal);
      directoriesObserved++;
      if (directoriesObserved > this.maxResourceFiles) {
        throw new FilesystemSkillProviderError(
          `Skill ${record.descriptor.id} exceeds the resource directory limit.`
        );
      }
      const directory = pending.pop()!;
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        throwIfAborted(signal);
        if (entry.name === SKILL_FILE_NAME || OMITTED_RESOURCE_NAMES.has(entry.name)) continue;
        if (entry.isDirectory()) {
          if (!OMITTED_RESOURCE_DIRECTORIES.has(entry.name))
            pending.push(join(directory, entry.name));
          continue;
        }
        if (!entry.isFile()) {
          this.mutableStats.unsafeEntriesRejected++;
          continue;
        }
        if (resources.length >= this.maxResourceFiles) {
          throw new FilesystemSkillProviderError(
            `Skill ${record.descriptor.id} exceeds the resource manifest limit.`
          );
        }
        const resourceRealPath = await containedRealPath(
          join(directory, entry.name),
          record.skillDirectoryRealPath,
          record.rootRealPath
        );
        const resourceStats = await stat(resourceRealPath, { bigint: true });
        if (!resourceStats.isFile()) continue;
        const revision = revisionFromStats(resourceStats);
        const path = normalizeResourcePath(
          toPortablePath(relative(record.skillDirectoryRealPath, resourceRealPath))
        );
        const mediaType = mediaTypeFor(path);
        resources.push({
          realPath: resourceRealPath,
          revision,
          descriptor: deepFreeze({
            path,
            digest: digestRuntimeValue({
              version: FILESYSTEM_SKILL_PROVIDER_VERSION,
              path,
              revision: revision.digest,
            }),
            bytes: revision.bytes,
            ...(mediaType ? { mediaType } : {}),
          }),
        });
      }
    }
    return Object.freeze(
      resources.sort((left, right) => left.descriptor.path.localeCompare(right.descriptor.path))
    );
  }

  private reconcileWatchers(paths: readonly string[]): void {
    if (!this.watchEnabled || this.listeners.size === 0) return;
    const desired = [
      ...new Set(
        paths
          .map(path => nearestWatchablePath(path))
          .filter((path): path is string => Boolean(path))
      ),
    ]
      .sort()
      .slice(0, this.maxWatchPaths);
    for (const [path, watcher] of this.watchers) {
      if (desired.includes(path)) continue;
      watcher.close();
      this.watchers.delete(path);
    }
    for (const path of desired) {
      if (this.watchers.has(path)) continue;
      try {
        this.watchers.set(
          path,
          this.watchFactory(path, event => this.scheduleInvalidation(event))
        );
      } catch {
        this.mutableStats.watchErrors++;
      }
    }
  }

  private scheduleInvalidation(event: string): void {
    if (this.watchDebounceMs === 0) return this.emitInvalidation(event);
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => this.emitInvalidation(event), this.watchDebounceMs);
    this.watchTimer.unref?.();
  }

  private emitInvalidation(event: string): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = undefined;
    this.mutableStats.watchInvalidations++;
    this.records.clear();
    this.resourceManifests.clear();
    const value = Object.freeze({
      providerId: this.id,
      reason: `filesystem_change:${event || 'unknown'}`,
    });
    for (const listener of this.listeners) listener(value);
  }

  private closeWatchers(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = undefined;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
}

export function createFilesystemSkillRootsV1(
  options: FilesystemSkillRootOptionsV1
): readonly FilesystemSkillRootV1[] {
  const cwd = resolveExpandedPath(options.cwd, process.cwd());
  const configHome = resolveExpandedPath(options.configHome ?? getConfigHome(), cwd);
  const builtinRoot = resolveExpandedPath(options.builtinRoot ?? defaultBuiltinRoot(), cwd);
  return Object.freeze([
    { path: builtinRoot, sourceScope: 'builtin' },
    { path: join(configHome, 'skills'), sourceScope: 'user' },
    ...(options.configuredPaths ?? []).map(path => ({
      path: resolveExpandedPath(path, cwd),
      sourceScope: 'configured' as const,
    })),
    { path: join(cwd, '.orion-code', 'skills'), sourceScope: 'project' },
  ]);
}

export function createFilesystemSkillProviderV1(
  options: FilesystemSkillProviderOptionsV1
): FilesystemSkillProviderV1 {
  return new FilesystemSkillProviderV1(options);
}

export function createProductionFilesystemSkillProviderV1(
  options: ProductionFilesystemSkillProviderOptionsV1
): FilesystemSkillProviderV1 {
  const { cwd, configuredPaths, configHome, builtinRoot, ...providerOptions } = options;
  return new FilesystemSkillProviderV1({
    ...providerOptions,
    roots: createFilesystemSkillRootsV1({
      cwd,
      ...(configuredPaths ? { configuredPaths } : {}),
      ...(configHome ? { configHome } : {}),
      ...(builtinRoot ? { builtinRoot } : {}),
    }),
  });
}

function normalizeRoots(roots: readonly FilesystemSkillRootV1[]): readonly NormalizedRootV1[] {
  const output: NormalizedRootV1[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!['builtin', 'user', 'configured', 'project'].includes(root.sourceScope)) {
      throw new FilesystemSkillProviderError(
        `Unsupported filesystem Skill scope: ${root.sourceScope}`
      );
    }
    const path = resolveExpandedPath(root.path, process.cwd());
    const key = `${root.sourceScope}\u0000${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(
      Object.freeze({
        path,
        sourceScope: root.sourceScope,
        pathDigest: digestRuntimeValue({ path, sourceScope: root.sourceScope }),
      })
    );
  }
  return Object.freeze(
    output.sort(
      (left, right) =>
        left.sourceScope.localeCompare(right.sourceScope) || left.path.localeCompare(right.path)
    )
  );
}

async function skillCandidates(
  rootRealPath: string,
  rootIsFile: boolean,
  limit: number,
  signal: AbortSignal
): Promise<readonly string[]> {
  if (rootIsFile) {
    return basename(rootRealPath).toLowerCase() === SKILL_FILE_NAME.toLowerCase()
      ? [rootRealPath]
      : [];
  }
  const direct = join(rootRealPath, SKILL_FILE_NAME);
  try {
    if ((await stat(direct)).isFile()) return [direct];
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const entries = await readdir(rootRealPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const candidates: string[] = [];
  for (const entry of entries) {
    throwIfAborted(signal);
    const directory = join(rootRealPath, entry.name);
    try {
      if (!(await stat(directory)).isDirectory()) continue;
      const file = join(directory, SKILL_FILE_NAME);
      if ((await stat(file)).isFile()) candidates.push(file);
      if (candidates.length >= limit) break;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return candidates;
}

async function readFrontmatterPrefix(
  path: string,
  maxBytes: number,
  maxDefinitionBytes: number,
  signal: AbortSignal,
  stats: MutableProviderStats
): Promise<FrontmatterResultV1> {
  const handle = await openNoFollow(path);
  stats.frontmatterPrefixReads++;
  try {
    const beforeStats = await handle.stat({ bigint: true });
    if (!beforeStats.isFile()) {
      throw new FilesystemSkillProviderError('Skill definition is not a regular file.');
    }
    const revision = revisionFromStats(beforeStats);
    if (revision.bytes > maxDefinitionBytes) {
      throw new FilesystemSkillProviderError(
        `Skill definition exceeds the ${maxDefinitionBytes} byte limit.`
      );
    }
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let parsedResult: Omit<FrontmatterResultV1, 'revision'> | undefined;
    while (bytesRead < maxBytes) {
      throwIfAborted(signal);
      const size = Math.min(bytesRead === 0 ? 8 : FRONTMATTER_CHUNK_BYTES, maxBytes - bytesRead);
      const buffer = Buffer.allocUnsafe(size);
      const result = await handle.read(buffer, 0, size, bytesRead);
      if (result.bytesRead === 0) break;
      chunks.push(buffer.subarray(0, result.bytesRead));
      bytesRead += result.bytesRead;
      stats.frontmatterPrefixBytes += result.bytesRead;
      const text = Buffer.concat(chunks)
        .toString('utf8')
        .replace(/^\uFEFF/, '');
      if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
        parsedResult = {
          metadata: {},
          digest: digestRuntimeValue({ kind: 'legacy', prefix: text }),
          complete: true,
        };
        break;
      }
      const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (!match) continue;
      try {
        const parsed = loadYaml(match[1]);
        const metadata = isRecord(parsed) ? parsed : {};
        parsedResult = {
          metadata,
          digest: digestRuntimeValue({ kind: 'frontmatter', raw: match[1] }),
          complete: isRecord(parsed),
        };
      } catch {
        parsedResult = {
          metadata: {},
          digest: digestRuntimeValue({ kind: 'invalid-frontmatter', value: match[1] }),
          complete: false,
        };
      }
      break;
    }
    if (!parsedResult) {
      const text = Buffer.concat(chunks)
        .toString('utf8')
        .replace(/^\uFEFF/, '');
      const frontmatterStarted = text.startsWith('---\n') || text.startsWith('---\r\n');
      parsedResult = frontmatterStarted
        ? {
            metadata: {},
            digest: digestRuntimeValue({ kind: 'truncated-frontmatter', maxBytes }),
            complete: false,
          }
        : {
            metadata: {},
            digest: digestRuntimeValue({ kind: 'legacy', prefix: text }),
            complete: true,
          };
    }
    const after = revisionFromStats(await handle.stat({ bigint: true }));
    if (after.digest !== revision.digest) {
      throw new FilesystemSkillProviderError('Skill definition changed during catalog scan.');
    }
    return { ...parsedResult, revision };
  } finally {
    await handle.close();
  }
}

async function readBoundedFile(
  path: string,
  maxBytes: number,
  signal: AbortSignal,
  label: string
): Promise<{ buffer: Buffer; revision: FileRevisionV1 }> {
  const handle = await openNoFollow(path);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new FilesystemSkillProviderError(`${label} is not a file.`);
    const revision = revisionFromStats(before);
    if (revision.bytes > maxBytes) {
      throw new FilesystemSkillProviderError(`${label} exceeds the ${maxBytes} byte limit.`);
    }
    const buffer = Buffer.alloc(revision.bytes);
    let offset = 0;
    while (offset < buffer.byteLength) {
      throwIfAborted(signal);
      const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== buffer.byteLength) {
      throw new FilesystemSkillProviderError(`${label} changed while it was being read.`);
    }
    if (revisionFromStats(await handle.stat({ bigint: true })).digest !== revision.digest) {
      throw new FilesystemSkillProviderError(`${label} changed while it was being read.`);
    }
    return { buffer, revision };
  } finally {
    await handle.close();
  }
}

async function openNoFollow(path: string) {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  return open(path, constants.O_RDONLY | noFollow);
}

async function containedRealPath(
  path: string,
  skillRoot: string,
  providerRoot: string
): Promise<string> {
  const output = await realpath(path);
  if (!containsPath(skillRoot, output) || !containsPath(providerRoot, output)) {
    throw new FilesystemSkillProviderError('Skill path escapes its trusted realpath roots.');
  }
  return output;
}

function revisionFromStats(stats: BigIntStats): FileRevisionV1 {
  if (stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new FilesystemSkillProviderError('Skill file size exceeds the safe integer range.');
  }
  return Object.freeze({
    bytes: Number(stats.size),
    digest: digestRuntimeValue({
      dev: stats.dev.toString(),
      ino: stats.ino.toString(),
      size: stats.size.toString(),
      mtimeNs: stats.mtimeNs.toString(),
      ctimeNs: stats.ctimeNs.toString(),
    }),
  });
}

function definitionBody(content: string): string {
  const normalized = content.replace(/^\uFEFF/, '');
  const match = normalized.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  return match ? normalized.slice(match[0].length).trim() : normalized.trim();
}

function normalizeResourcePath(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.split('/').some(segment => segment === '..' || segment === '' || segment === '.')
  ) {
    throw new FilesystemSkillProviderError(
      `Skill resource path must be a contained relative path: ${path}`
    );
  }
  return normalized;
}

function containsPath(root: string, target: string): boolean {
  const result = relative(root, target);
  return (
    result === '' || (!result.startsWith(`..${sep}`) && result !== '..' && !isAbsolute(result))
  );
}

function normalizeIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new FilesystemSkillProviderError(
      `${label} must be non-empty and contain no control characters.`
    );
  }
  return normalized;
}

function normalizeSkillName(value: string): string {
  return (
    value
      .trim()
      .replace(/\.md$/i, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'skill'
  );
}

function normalizeStringList(value: unknown): readonly string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return Object.freeze(
    [
      ...new Set(
        values
          .filter(item => typeof item === 'string')
          .map(item => item.trim())
          .filter(Boolean)
      ),
    ].sort()
  );
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveExpandedPath(value: string, cwd: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\u0000')) {
    throw new FilesystemSkillProviderError('Filesystem Skill root must not be empty.');
  }
  const expanded =
    trimmed === '~'
      ? homedir()
      : trimmed.startsWith('~/')
        ? join(homedir(), trimmed.slice(2))
        : trimmed;
  return resolve(cwd, expanded);
}

function defaultBuiltinRoot(): string {
  return resolve(__dirname, '../../skills/builtin');
}

function defaultWatchFactory(
  path: string,
  invalidate: (event: string) => void
): FilesystemSkillWatchHandleV1 {
  let watcher: FSWatcher;
  try {
    watcher = watchFilesystem(path, { recursive: true, persistent: false }, event =>
      invalidate(event)
    );
  } catch {
    watcher = watchFilesystem(path, { persistent: false }, event => invalidate(event));
  }
  return { close: () => watcher.close() };
}

function nearestWatchablePath(path: string): string | undefined {
  let candidate = resolve(path);
  // At most the direct parent: never turn a missing project Skill directory into
  // a recursive watch of the whole workspace.
  for (let depth = 0; depth <= 1; depth++) {
    if (existsSync(candidate)) {
      try {
        return statSync(candidate).isDirectory() ? candidate : dirname(candidate);
      } catch {
        return undefined;
      }
    }
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
  return undefined;
}

function emptyScan(
  root: NormalizedRootV1,
  state: RootReceiptV1['state'],
  complete: boolean
): ScanResultV1 {
  return {
    records: [],
    receipt: {
      pathDigest: root.pathDigest,
      sourceScope: root.sourceScope,
      state,
      skillCount: 0,
    },
    watchPaths: [],
    complete,
  };
}

function compareRootReceipts(left: RootReceiptV1, right: RootReceiptV1): number {
  return (
    left.sourceScope.localeCompare(right.sourceScope) ||
    left.pathDigest.localeCompare(right.pathDigest)
  );
}

function mediaTypeFor(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case '.md':
      return 'text/markdown';
    case '.txt':
      return 'text/plain';
    case '.json':
      return 'application/json';
    case '.yaml':
    case '.yml':
      return 'application/yaml';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'text/javascript';
    case '.ts':
    case '.tsx':
      return 'text/typescript';
    case '.sh':
      return 'text/x-shellscript';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.svg':
      return 'image/svg+xml';
    default:
      return undefined;
  }
}

function isTextMediaType(mediaType?: string): boolean {
  return Boolean(
    mediaType?.startsWith('text/') ||
    mediaType === 'application/json' ||
    mediaType === 'application/yaml' ||
    mediaType === 'image/svg+xml'
  );
}

function integerOption(value: number, label: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new FilesystemSkillProviderError(
      `${label} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer.`
    );
  }
  return value;
}

function toPortablePath(path: string): string {
  return path.split(sep).join('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason || 'Filesystem Skill operation aborted.'));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
