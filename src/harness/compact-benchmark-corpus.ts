import { createHash } from 'crypto';

export interface CompactBenchmarkCase {
  id: string;
  setup: string;
  required: string[];
}

/** Fixed, provider-neutral compact corpus. Order and key order are canonical. */
export const COMPACT_BENCHMARK_CORPUS_V1: CompactBenchmarkCase[] = [
  {
    id: 'C01-large-tool',
    setup: 'tool_output:repeat(x,65536)',
    required: ['objective', 'criterion:c1', 'tool_pair:t1', 'next_action'],
  },
  {
    id: 'C02-parallel-tools',
    setup: 'parallel_calls:[read:a,read:b];results_reverse_order',
    required: ['call_result_pair:a', 'call_result_pair:b', 'original_order'],
  },
  {
    id: 'C03-steer-rollback',
    setup: 'edit:a;user_steer:revert_a_edit_b',
    required: ['latest_instruction', 'reverted:a', 'changed:b'],
  },
  {
    id: 'C04-resume',
    setup: 'compact;crash_after_prepare;restart_resume',
    required: ['canonical_transcript', 'committed_checkpoint_only', 'no_replayed_side_effect'],
  },
  {
    id: 'C05-cjk',
    setup: 'objective:修复权限边界;constraint:不得修改用户文件',
    required: ['objective', 'constraint', 'criterion:cjk1'],
  },
  {
    id: 'C06-provider-failure',
    setup: 'candidate_provider:[timeout,empty,invalid_schema]',
    required: ['old_checkpoint_active', 'bounded_retry', 'typed_failure'],
  },
  {
    id: 'C07-oversized-item',
    setup: 'single_message:repeat(y,131072)',
    required: ['explicit_over_budget', 'no_partial_protocol_item', 'typed_pause_or_fallback'],
  },
  {
    id: 'C08-repeat-compact',
    setup: 'compact_rounds:10;no_new_facts',
    required: ['no_fact_loss', 'stable_refs', 'thrash_bound'],
  },
];

export function canonicalCompactBenchmarkCorpus(): string {
  return JSON.stringify(COMPACT_BENCHMARK_CORPUS_V1);
}

export function compactBenchmarkCorpusHash(): string {
  return createHash('sha256').update(canonicalCompactBenchmarkCorpus(), 'utf8').digest('hex');
}
