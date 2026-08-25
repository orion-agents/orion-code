import { redactTraceText } from '../../services/redaction';
import { estimateTokens } from '../../utils/token-estimate';
import { digestRuntimeValue } from '../protocol/canonical';
import {
  PROMPT_REGISTRY_VERSION,
  type PromptAssemblyReceiptV1,
  type PromptAssemblyRequestV1,
  type PromptAssemblyV1,
  type PromptContributorInputsV1,
  type PromptContributorKindV1,
  type PromptDeclaredOmissionReasonV1,
  type PromptSectionInputV1,
  type PromptSectionReceiptV1,
  type PromptSelectionReasonV1,
  type SelectedPromptSectionV1,
} from './types';

const SAFE_ID = /^[a-z][a-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTRIBUTOR_SLOTS = Object.freeze([
  ['taskContext', 'task_context'],
  ['skill', 'skill'],
  ['memory', 'memory'],
  ['project', 'project'],
  ['goal', 'goal'],
  ['subagent', 'subagent'],
  ['mode', 'mode'],
] as const satisfies ReadonlyArray<
  readonly [keyof PromptContributorInputsV1, PromptContributorKindV1]
>);
const DECLARED_OMISSION_REASONS = new Set<PromptDeclaredOmissionReasonV1>([
  'not_selected_by_plan',
  'source_unavailable',
  'authority_denied',
  'not_applicable',
]);
const PROMPT_AUTHORITIES = new Set([
  'system',
  'developer',
  'project',
  'user',
  'tool',
  'session',
  'runtime',
]);
const CACHEABILITY_VALUES = new Set(['cacheable', 'non_cacheable']);
const REDACTION_POLICIES = new Set(['none', 'secrets']);

interface NormalizedPromptSection extends SelectedPromptSectionV1 {
  readonly enabled: boolean;
  readonly omissionReason?: PromptDeclaredOmissionReasonV1;
}

interface OmittedPromptSection {
  readonly section: NormalizedPromptSection;
  readonly reason: PromptSelectionReasonV1;
}

export class PromptRegistryError extends Error {
  readonly code: string = 'ORION_PROMPT_REGISTRY_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'PromptRegistryError';
  }
}

export class PromptBudgetExceededError extends PromptRegistryError {
  override readonly code = 'ORION_PROMPT_BUDGET_EXCEEDED';

  constructor(
    public readonly sectionId: string | undefined,
    public readonly requiredTokens: number,
    public readonly availableTokens: number,
    scope: 'section' | 'assembly'
  ) {
    super(
      scope === 'section'
        ? `Mandatory Prompt section ${sectionId} requires ${requiredTokens} tokens; budget is ${availableTokens}.`
        : `Mandatory Prompt sections require ${requiredTokens} tokens; assembly budget is ${availableTokens}.`
    );
    this.name = 'PromptBudgetExceededError';
  }
}

/** Deterministic, atomic Prompt section selection and assembly. */
export class PromptRegistryV1 {
  readonly version = PROMPT_REGISTRY_VERSION;

  assemble(request: PromptAssemblyRequestV1): PromptAssemblyV1 {
    const hardTokenBudget = nonNegativeSafeInteger(
      request.hardTokenBudget,
      'Prompt hard token budget'
    );
    const sections = normalizeContributors(request.contributors);
    assertUniqueSectionIds(sections);

    const mandatory: NormalizedPromptSection[] = [];
    const optional: NormalizedPromptSection[] = [];
    const omitted: OmittedPromptSection[] = [];

    for (const section of sections) {
      if (!section.enabled) {
        if (section.mandatory) {
          throw new PromptRegistryError(
            `Mandatory Prompt section ${section.id} cannot be disabled by its contributor.`
          );
        }
        omitted.push({
          section,
          reason: section.omissionReason ?? 'not_selected_by_plan',
        });
        continue;
      }
      if (section.estimatedTokens > section.tokenBudget) {
        if (section.mandatory) {
          throw new PromptBudgetExceededError(
            section.id,
            section.estimatedTokens,
            section.tokenBudget,
            'section'
          );
        }
        omitted.push({ section, reason: 'section_token_budget_exceeded' });
        continue;
      }
      if (section.mandatory) mandatory.push(section);
      else optional.push(section);
    }

    mandatory.sort(selectionOrder);
    optional.sort(selectionOrder);
    const selected: NormalizedPromptSection[] = [...mandatory];
    const mandatoryTokens = estimateRenderedTokens(selected);
    if (mandatoryTokens > hardTokenBudget) {
      throw new PromptBudgetExceededError(undefined, mandatoryTokens, hardTokenBudget, 'assembly');
    }

    for (const section of optional) {
      const candidate = [...selected, section];
      if (estimateRenderedTokens(candidate) <= hardTokenBudget) selected.push(section);
      else omitted.push({ section, reason: 'global_token_budget_exceeded' });
    }

    selected.sort(renderOrder);
    omitted.sort((left, right) => selectionOrder(left.section, right.section));
    const selectedSections = selected.map(section => selectedOutput(section));
    const text = renderSections(selected);
    const prefixSections = selected.filter(section => section.cacheablePrefix);
    const prefixText = renderSections(prefixSections);
    const promptDigest = digestRuntimeValue(text);
    const cacheablePrefixDigest = digestRuntimeValue(prefixText);
    const receiptSections = [
      ...selected.map(section => sectionReceipt(section, true, selectionReason(section))),
      ...omitted.map(item => sectionReceipt(item.section, false, item.reason)),
    ];
    const receiptBase = {
      version: PROMPT_REGISTRY_VERSION,
      hardTokenBudget,
      estimatedTokens: estimateTokens(text),
      selectedSectionIds: selected.map(section => section.id),
      omittedSectionIds: omitted.map(item => item.section.id),
      sections: receiptSections,
      promptDigest,
      cacheablePrefixDigest,
    } as const;
    const receipt: PromptAssemblyReceiptV1 = deepFreeze({
      ...receiptBase,
      digest: digestRuntimeValue(receiptBase),
    });

    return deepFreeze({
      version: PROMPT_REGISTRY_VERSION,
      text,
      sections: selectedSections,
      cacheablePrefix: {
        sectionIds: prefixSections.map(section => section.id),
        estimatedTokens: estimateTokens(prefixText),
        digest: cacheablePrefixDigest,
        text: prefixText,
      },
      receipt,
    });
  }
}

/** Create a safe source revision digest without exposing the source input. */
export function digestPromptSource(value: unknown): string {
  return digestRuntimeValue(value);
}

/** Assert a persisted receipt was not modified after assembly. */
export function verifyPromptAssemblyReceipt(receipt: PromptAssemblyReceiptV1): void {
  if (receipt.version !== PROMPT_REGISTRY_VERSION) {
    throw new PromptRegistryError(`Unsupported Prompt receipt version: ${receipt.version}`);
  }
  const { digest, ...receiptBase } = receipt;
  if (digestRuntimeValue(receiptBase) !== digest) {
    throw new PromptRegistryError('Prompt assembly receipt digest mismatch.');
  }
  for (const section of receipt.sections) {
    validateSafeId(section.id, 'Prompt section id');
    validateSafeId(section.sourceId, `Prompt section ${section.id} source id`);
    validateSourceDigest(section.sourceDigest, `Prompt section ${section.id} source digest`);
    validateSourceDigest(section.contentDigest, `Prompt section ${section.id} content digest`);
  }
  for (const id of [...receipt.selectedSectionIds, ...receipt.omittedSectionIds]) {
    validateSafeId(id, 'Prompt receipt section id');
  }
  validateSourceDigest(receipt.promptDigest, 'Prompt receipt prompt digest');
  validateSourceDigest(receipt.cacheablePrefixDigest, 'Prompt receipt cacheable prefix digest');
  validateSourceDigest(receipt.digest, 'Prompt receipt digest');
  const selected = receipt.sections.filter(section => section.selected).map(section => section.id);
  const omitted = receipt.sections.filter(section => !section.selected).map(section => section.id);
  if (
    JSON.stringify(selected) !== JSON.stringify(receipt.selectedSectionIds) ||
    JSON.stringify(omitted) !== JSON.stringify(receipt.omittedSectionIds)
  ) {
    throw new PromptRegistryError('Prompt assembly receipt selection manifest mismatch.');
  }
}

function normalizeContributors(contributors: PromptContributorInputsV1): NormalizedPromptSection[] {
  const normalized: NormalizedPromptSection[] = [];
  for (const [slot, contributor] of CONTRIBUTOR_SLOTS) {
    for (const input of contributors[slot] ?? []) {
      normalized.push(normalizeSection(input, contributor));
    }
  }
  return normalized;
}

function normalizeSection(
  input: PromptSectionInputV1,
  contributor: PromptContributorKindV1
): NormalizedPromptSection {
  const id = validateSafeId(input.id, 'Prompt section id');
  const sourceId = validateSafeId(input.source.id, `Prompt section ${id} source id`);
  const sourceDigest = validateSourceDigest(
    input.source.digest,
    `Prompt section ${id} source digest`
  );
  if (!Number.isSafeInteger(input.priority)) {
    throw new PromptRegistryError(`Prompt section ${id} priority must be a safe integer.`);
  }
  const tokenBudget = nonNegativeSafeInteger(
    input.tokenBudget,
    `Prompt section ${id} token budget`
  );
  if (typeof input.content !== 'string') {
    throw new PromptRegistryError(`Prompt section ${id} content must be text.`);
  }
  if (input.atomic !== true) {
    throw new PromptRegistryError(`Prompt section ${id} must be atomic in Prompt Registry v1.`);
  }
  if (!PROMPT_AUTHORITIES.has(input.authority)) {
    throw new PromptRegistryError(`Prompt section ${id} has an unsupported authority.`);
  }
  if (!CACHEABILITY_VALUES.has(input.cacheability)) {
    throw new PromptRegistryError(`Prompt section ${id} has unsupported cacheability.`);
  }
  if (!REDACTION_POLICIES.has(input.redaction)) {
    throw new PromptRegistryError(`Prompt section ${id} has an unsupported redaction policy.`);
  }
  if (typeof input.mandatory !== 'boolean' || typeof input.dynamic !== 'boolean') {
    throw new PromptRegistryError(`Prompt section ${id} lifecycle flags must be boolean.`);
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new PromptRegistryError(`Prompt section ${id} enabled flag must be boolean.`);
  }
  const enabled = input.enabled !== false;
  if (input.omissionReason && !DECLARED_OMISSION_REASONS.has(input.omissionReason)) {
    throw new PromptRegistryError(`Prompt section ${id} has an unsupported omission reason.`);
  }
  if (enabled && input.omissionReason) {
    throw new PromptRegistryError(
      `Prompt section ${id} cannot declare an omission reason while enabled.`
    );
  }
  const redacted = redactTraceText(input.content);
  if (input.redaction === 'none' && redacted !== input.content) {
    throw new PromptRegistryError(
      `Prompt section ${id} contains secret-like content but disables redaction.`
    );
  }
  const redactionApplied = input.redaction === 'secrets' && redacted !== input.content;
  const content = input.redaction === 'secrets' ? redacted : input.content;
  const cacheablePrefix = !input.dynamic && input.cacheability === 'cacheable';

  return deepFreeze({
    id,
    authority: input.authority,
    contributor,
    sourceId,
    sourceDigest,
    priority: input.priority,
    tokenBudget,
    estimatedTokens: estimateTokens(content),
    mandatory: input.mandatory === true,
    atomic: true,
    dynamic: input.dynamic === true,
    cacheability: input.cacheability,
    cacheablePrefix,
    redaction: input.redaction,
    redactionApplied,
    contentDigest: digestRuntimeValue(content),
    content,
    enabled,
    omissionReason: input.omissionReason,
  });
}

function selectedOutput(section: NormalizedPromptSection): SelectedPromptSectionV1 {
  return deepFreeze({
    id: section.id,
    authority: section.authority,
    contributor: section.contributor,
    sourceId: section.sourceId,
    sourceDigest: section.sourceDigest,
    priority: section.priority,
    tokenBudget: section.tokenBudget,
    estimatedTokens: section.estimatedTokens,
    mandatory: section.mandatory,
    atomic: section.atomic,
    dynamic: section.dynamic,
    cacheability: section.cacheability,
    cacheablePrefix: section.cacheablePrefix,
    redaction: section.redaction,
    redactionApplied: section.redactionApplied,
    contentDigest: section.contentDigest,
    content: section.content,
  });
}

function sectionReceipt(
  section: NormalizedPromptSection,
  selected: boolean,
  reason: PromptSelectionReasonV1
): PromptSectionReceiptV1 {
  return deepFreeze({
    id: section.id,
    authority: section.authority,
    contributor: section.contributor,
    sourceId: section.sourceId,
    sourceDigest: section.sourceDigest,
    priority: section.priority,
    tokenBudget: section.tokenBudget,
    estimatedTokens: section.estimatedTokens,
    mandatory: section.mandatory,
    atomic: section.atomic,
    dynamic: section.dynamic,
    cacheability: section.cacheability,
    cacheablePrefix: selected && section.cacheablePrefix,
    redaction: section.redaction,
    redactionApplied: section.redactionApplied,
    selected,
    reason,
    contentDigest: section.contentDigest,
  });
}

function selectionReason(section: NormalizedPromptSection): PromptSelectionReasonV1 {
  return section.mandatory ? 'mandatory' : 'selected_by_priority';
}

function selectionOrder(left: NormalizedPromptSection, right: NormalizedPromptSection): number {
  return (
    right.priority - left.priority ||
    left.id.localeCompare(right.id) ||
    left.contributor.localeCompare(right.contributor)
  );
}

function renderOrder(left: NormalizedPromptSection, right: NormalizedPromptSection): number {
  if (left.cacheablePrefix !== right.cacheablePrefix) return left.cacheablePrefix ? -1 : 1;
  return selectionOrder(left, right);
}

function renderSections(sections: readonly NormalizedPromptSection[]): string {
  return [...sections]
    .sort(renderOrder)
    .map(section => section.content)
    .join('\n\n');
}

function estimateRenderedTokens(sections: readonly NormalizedPromptSection[]): number {
  return estimateTokens(renderSections(sections));
}

function assertUniqueSectionIds(sections: readonly NormalizedPromptSection[]): void {
  const ids = new Set<string>();
  for (const section of sections) {
    if (ids.has(section.id)) {
      throw new PromptRegistryError(`Duplicate Prompt section id: ${section.id}`);
    }
    ids.add(section.id);
  }
}

function validateSafeId(value: string, label: string): string {
  const normalized = value.trim();
  if (!SAFE_ID.test(normalized) || redactTraceText(normalized) !== normalized) {
    throw new PromptRegistryError(`${label} must be a safe stable id.`);
  }
  return normalized;
}

function validateSourceDigest(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA256.test(normalized)) {
    throw new PromptRegistryError(`${label} must be a SHA-256 digest.`);
  }
  return normalized;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PromptRegistryError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
