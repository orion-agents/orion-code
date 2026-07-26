import type { ToolDetailRepository, ToolDetailPage } from '../runtime/tool-detail-repository';
import type { TuiToolDetailSummary, ToolInspectorState } from './state';
import { open } from 'fs/promises';

export interface InspectorDetailState {
  content: string;
  nextOffsetBytes?: number;
  totalBytes: number;
  redacted: boolean;
  loading: boolean;
  error?: string;
}

export interface ToolInspectorViewModel {
  entries: TuiToolDetailSummary[];
  selectedIndex: number;
  selected?: TuiToolDetailSummary;
  detail?: InspectorDetailState;
  expandedCallIds: string[];
  searchQuery: string;
  detailOffset: number;
  error?: string;
}

const DETAIL_PAGE_BYTES = 64 * 1024;

/** Controller for Inspector filtering and cancellable paged detail reads. */
export class TranscriptInspectorController {
  private readonly details = new Map<string, InspectorDetailState>();
  private requestGeneration = 0;

  constructor(
    private readonly repository: ToolDetailRepository,
    private readonly projectPath: string,
  ) {}

  view(entries: TuiToolDetailSummary[], inspector: ToolInspectorState): ToolInspectorViewModel {
    const query = inspector.searchQuery.trim().toLowerCase();
    const filtered = query
      ? entries.filter(entry => [
        entry.toolName,
        entry.callId,
        entry.summary,
        this.details.get(entry.callId)?.content,
      ]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(query)))
      : entries;
    const selectedIndex = Math.max(0, Math.min(filtered.length - 1, inspector.selectedIndex));
    const selected = filtered[selectedIndex];
    return {
      entries: filtered,
      selectedIndex,
      selected,
      detail: selected ? this.details.get(selected.callId) : undefined,
      expandedCallIds: inspector.expandedCallIds,
      searchQuery: inspector.searchQuery,
      detailOffset: inspector.detailOffset,
      error: inspector.error,
    };
  }

  async load(entry: TuiToolDetailSummary, append = false): Promise<void> {
    const current = this.details.get(entry.callId);
    const offsetBytes = append ? current?.nextOffsetBytes : 0;
    if (append && offsetBytes === undefined) return;
    const generation = ++this.requestGeneration;
    this.details.set(entry.callId, {
      content: append ? current?.content ?? '' : '',
      totalBytes: current?.totalBytes ?? entry.outputBytes,
      nextOffsetBytes: current?.nextOffsetBytes,
      redacted: current?.redacted ?? false,
      loading: true,
    });
    try {
      const page = entry.artifactId
        ? await this.repository.read({
          callId: entry.callId,
          sequence: entry.sequence,
          artifactId: entry.artifactId,
          outputBytes: entry.outputBytes,
        }, { offsetBytes: offsetBytes ?? 0, limitBytes: DETAIL_PAGE_BYTES }, this.projectPath)
        : unavailablePage(entry);
      if (generation !== this.requestGeneration) return;
      this.details.set(entry.callId, {
        content: append ? `${current?.content ?? ''}${page.content}` : page.content,
        nextOffsetBytes: page.nextOffsetBytes,
        totalBytes: page.totalBytes,
        redacted: Boolean(current?.redacted || page.redacted),
        loading: false,
      });
    } catch (error) {
      if (generation !== this.requestGeneration) return;
      this.details.set(entry.callId, {
        content: append ? current?.content ?? '' : '',
        totalBytes: current?.totalBytes ?? entry.outputBytes,
        redacted: current?.redacted ?? false,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Stream a complete, redacted detail without retaining it in Inspector state. */
  async *readPages(entry: TuiToolDetailSummary): AsyncGenerator<ToolDetailPage> {
    if (!entry.artifactId) {
      yield unavailablePage(entry);
      return;
    }
    let offsetBytes = 0;
    while (true) {
      const page = await this.repository.read({
        callId: entry.callId,
        sequence: entry.sequence,
        artifactId: entry.artifactId,
        outputBytes: entry.outputBytes,
      }, { offsetBytes, limitBytes: DETAIL_PAGE_BYTES }, this.projectPath);
      yield page;
      if (page.nextOffsetBytes === undefined || page.nextOffsetBytes <= offsetBytes) return;
      offsetBytes = page.nextOffsetBytes;
    }
  }

  async writeDetailToFile(entry: TuiToolDetailSummary, filePath: string): Promise<void> {
    const file = await open(filePath, 'w', 0o600);
    try {
      for await (const page of this.readPages(entry)) {
        await file.write(page.content);
      }
    } finally {
      await file.close();
    }
  }

  cancel(): void {
    this.requestGeneration += 1;
  }
}

function unavailablePage(entry: TuiToolDetailSummary): ToolDetailPage {
  const content = entry.summary || 'Full output is unavailable for this legacy tool entry.';
  return {
    content,
    offsetBytes: 0,
    totalBytes: Buffer.byteLength(content, 'utf8'),
    redacted: false,
  };
}
