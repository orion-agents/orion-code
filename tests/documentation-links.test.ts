import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';

function collectMarkdown(path: string): string[] {
  if (!statSync(path).isDirectory()) return path.endsWith('.md') ? [path] : [];
  return readdirSync(path).flatMap(entry => collectMarkdown(join(path, entry)));
}

describe('documentation links', () => {
  it('keeps every repository-relative Markdown link resolvable after archival moves', () => {
    const root = resolve(__dirname, '..');
    const files = [
      join(root, 'README.md'),
      join(root, 'README.zh-CN.md'),
      ...collectMarkdown(join(root, 'docs')),
    ];
    const broken: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const links = source.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu);
      for (const match of links) {
        let target = match[1]
          .trim()
          .replace(/^<|>$/gu, '')
          .split(/\s+["']/u, 1)[0];
        if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/iu.test(target)) {
          continue;
        }
        target = target.split('#', 1)[0].split('?', 1)[0];
        try {
          target = decodeURIComponent(target);
        } catch {
          broken.push(`${file}: invalid URL encoding in ${match[1]}`);
          continue;
        }
        const destination = resolve(dirname(file), target);
        if (!existsSync(destination)) {
          const line = source.slice(0, match.index).split('\n').length;
          broken.push(`${file}:${line} -> ${match[1]}`);
        }
      }
    }

    expect(broken).toEqual([]);
  });
});
