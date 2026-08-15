import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  COMPACT_BENCHMARK_CORPUS_V1,
  canonicalCompactBenchmarkCorpus,
  compactBenchmarkCorpusHash,
} from '../src/harness/compact-benchmark-corpus';

describe('compact benchmark corpus contract', () => {
  test('keeps eight uniquely identified cases with explicit required facts', () => {
    expect(COMPACT_BENCHMARK_CORPUS_V1).toHaveLength(8);
    expect(new Set(COMPACT_BENCHMARK_CORPUS_V1.map(item => item.id)).size).toBe(8);
    expect(COMPACT_BENCHMARK_CORPUS_V1.every(item => item.required.length >= 3)).toBe(true);
    expect(compactBenchmarkCorpusHash()).toBe(
      '9cb627c56d31ff345aa199edc632fe045d2f95f38490ae4860d5adc8e137fe1d'
    );
  });

  test('keeps the architecture ledger synchronized with the executable fixture', () => {
    const document = readFileSync(
      resolve(__dirname, '..', 'docs', 'architecture', 'compact-benchmark.md'),
      'utf8'
    );

    const block = document.match(/```json\n([\s\S]*?)\n```/u)?.[1];
    expect(block).toBeDefined();
    expect(JSON.stringify(JSON.parse(block!))).toBe(canonicalCompactBenchmarkCorpus());
    expect(document).toContain(compactBenchmarkCorpusHash());
  });
});
