import type { ToolContext } from '../framework/tool';
import { createBatchReadToolV1 } from './batch-read-service';
import { createBuiltinToolCatalogV1, type BuiltinToolCatalogV1 } from './builtin-tool-provider';
import {
  createFirstPartyCoreToolProviderV1,
  type FirstPartyCoreToolProviderV1,
} from './first-party-core-provider';
import {
  createFirstPartyLongTailToolProviderV1,
  type FirstPartyLongTailToolProviderV1,
} from './first-party-long-tail-provider';

export interface ProductionFirstPartyToolUniverseV1 {
  readonly core: FirstPartyCoreToolProviderV1;
  readonly longTail: FirstPartyLongTailToolProviderV1;
  readonly catalog: BuiltinToolCatalogV1;
}

/** Static product composition: lightweight descriptors now, exact executors on demand. */
export function createProductionFirstPartyToolUniverseV1(options: {
  readonly context: ToolContext;
}): ProductionFirstPartyToolUniverseV1 {
  const core = createFirstPartyCoreToolProviderV1(options);
  const longTail = createFirstPartyLongTailToolProviderV1(options);
  const batchRead = createBatchReadToolV1();
  const catalog = createBuiltinToolCatalogV1(
    [
      ...core.catalog.entries.map(entry => entry.tool),
      ...longTail.catalog.entries.map(entry => entry.tool),
      batchRead,
    ],
    { context: options.context }
  );
  return Object.freeze({ core, longTail, catalog });
}
