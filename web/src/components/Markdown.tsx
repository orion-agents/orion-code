import { useState, type ReactNode } from 'react';

import { Icon } from './Icon';

export interface MarkdownProps {
  readonly children: string;
  readonly className?: string;
}

export function Markdown({ children, className = '' }: MarkdownProps) {
  return <div className={`markdown ${className}`.trim()}>{renderBlocks(children)}</div>;
}

function renderBlocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const content: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        content.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <CodeBlock key={`code-${index}`} language={fence[1].trim()} content={content.join('\n')} />
      );
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      // Heading level maps 1:1 to the markdown syntax: `#` → <h1>, `##` → <h2>.
      // The previous `+ 1` shifted every level down (and level 1 fell through to <h6>).
      const level = Math.min(6, heading[1].length);
      blocks.push(
        createHeading(level, inlineMarkdown(heading[2], `heading-${index}`), `heading-${index}`)
      );
      index += 1;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push(<blockquote key={`quote-${index}`}>{renderBlocks(quote.join('\n'))}</blockquote>);
      continue;
    }
    const listMatch = line.match(/^\s*(?:[-*+] |\d+[.)] )(.+)$/);
    if (listMatch) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      const pattern = ordered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/;
      while (index < lines.length) {
        const match = lines[index].match(pattern);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      const children = items.map((item, itemIndex) => (
        <li key={`item-${index}-${itemIndex}`}>
          {inlineMarkdown(item, `list-${index}-${itemIndex}`)}
        </li>
      ));
      blocks.push(
        ordered ? (
          <ol key={`list-${index}`}>{children}</ol>
        ) : (
          <ul key={`list-${index}`}>{children}</ul>
        )
      );
      continue;
    }
    const headerCells = parseTableRow(line);
    if (headerCells && headerCells.length >= 1 && index + 1 < lines.length) {
      const alignments = parseTableSeparator(lines[index + 1]);
      if (alignments && alignments.length === headerCells.length) {
        const rows: string[][] = [headerCells];
        index += 2;
        while (index < lines.length) {
          const row = parseTableRow(lines[index]);
          if (!row || row.length !== headerCells.length) break;
          rows.push(row);
          index += 1;
        }
        blocks.push(renderTable(rows, alignments, `table-${index}`));
        continue;
      }
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(
      <p key={`paragraph-${index}`}>{inlineMarkdown(paragraph.join(' '), `paragraph-${index}`)}</p>
    );
  }
  return blocks;
}

function startsBlock(line: string): boolean {
  return (
    /^\s*```/.test(line) ||
    /^(#{1,6})\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*(?:[-*+] |\d+[.)] )/.test(line) ||
    parseTableRow(line) !== null
  );
}

type TableAlignment = 'left' | 'center' | 'right';

function parseTableRow(line: string): string[] | null {
  if (!line.includes('|')) return null;
  const cells = line.split('|');
  const leadingBlank = cells[0].trim() === '';
  const trailingBlank = cells[cells.length - 1].trim() === '';
  const trimmed = leadingBlank && trailingBlank ? cells.slice(1, -1) : cells;
  if (trimmed.length === 0) return null;
  return trimmed.map(cell => cell.trim());
}

function parseTableSeparator(line: string): TableAlignment[] | null {
  if (!line.includes('|') && !/[-:]/.test(line)) return null;
  let cells = line.split('|').map(cell => cell.trim());
  if (cells.length >= 2 && cells[0] === '' && cells[cells.length - 1] === '') {
    cells = cells.slice(1, -1);
  }
  if (cells.length < 1) return null;
  const alignments: TableAlignment[] = [];
  for (const cell of cells) {
    if (cell === '') return null;
    if (!/^:?-+:?$/.test(cell)) return null;
    const startsColon = cell.startsWith(':');
    const endsColon = cell.endsWith(':');
    if (startsColon && endsColon) alignments.push('center');
    else if (endsColon) alignments.push('right');
    else alignments.push('left');
  }
  return alignments;
}

function renderTable(rows: string[][], alignments: TableAlignment[], key: string): ReactNode {
  const [header, ...body] = rows;
  const cellStyle = (alignment: TableAlignment): { textAlign: TableAlignment } | undefined =>
    alignment === 'left' ? undefined : { textAlign: alignment };
  return (
    <table key={key} className="markdown-table">
      <thead>
        <tr>
          {header.map((cell, ci) => (
            <th key={`th-${ci}`} style={cellStyle(alignments[ci])}>
              {inlineMarkdown(cell, `${key}-th-${ci}`)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((row, ri) => (
          <tr key={`tr-${ri}`}>
            {row.map((cell, ci) => (
              <td key={`td-${ri}-${ci}`} style={cellStyle(alignments[ci])}>
                {inlineMarkdown(cell, `${key}-td-${ri}-${ci}`)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function inlineMarkdown(source: string, keyPrefix: string): ReactNode[] {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g;
  const output: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let part = 0;
  while ((match = pattern.exec(source))) {
    if (match.index > cursor) output.push(source.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${part++}`;
    if (token.startsWith('`')) {
      output.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      output.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link && safeLink(link[2])) {
        output.push(
          <a
            key={key}
            href={link[2]}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            {link[1]}
          </a>
        );
      } else {
        output.push(token);
      }
    }
    cursor = match.index + token.length;
  }
  if (cursor < source.length) output.push(source.slice(cursor));
  return output;
}

function safeLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function createHeading(level: number, children: ReactNode, key: string): ReactNode {
  if (level === 1) return <h1 key={key}>{children}</h1>;
  if (level === 2) return <h2 key={key}>{children}</h2>;
  if (level === 3) return <h3 key={key}>{children}</h3>;
  if (level === 4) return <h4 key={key}>{children}</h4>;
  if (level === 5) return <h5 key={key}>{children}</h5>;
  return <h6 key={key}>{children}</h6>;
}

function CodeBlock({ language, content }: { readonly language: string; readonly content: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1400);
    } catch {
      setCopyState('failed');
    }
  };
  return (
    <figure className="code-block">
      <figcaption>
        <span>{language || 'text'}</span>
        <button type="button" className="icon-text-button" onClick={copy} aria-label="复制代码">
          <Icon name={copyState === 'copied' ? 'check' : 'copy'} size={15} />
          {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制'}
        </button>
      </figcaption>
      <pre tabIndex={0} aria-label={`${language || '文本'}代码块`}>
        <code>{content}</code>
      </pre>
    </figure>
  );
}

export function sanitizeDisplayText(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export function safeJson(value: unknown, maxLength = 8_000): string {
  const secret = /api.?key|authorization|cookie|password|secret|token/i;
  let text: string;
  try {
    text = JSON.stringify(
      value,
      (key, child) => (key && secret.test(key) ? '[REDACTED]' : child),
      2
    );
  } catch {
    text = String(value);
  }
  const sanitized = sanitizeDisplayText(text);
  return sanitized.length <= maxLength ? sanitized : `${sanitized.slice(0, maxLength)}\n…已截断`;
}
