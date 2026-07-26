import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildReferencedFilesPrompt,
  collectReferencedFiles,
  extractFileMentions,
  renderReferencedFiles,
} from '../src/services/file-context';

describe('file context from @ mentions', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'openhorse-file-context-'));
    mkdirSync(join(cwd, 'src'));
    mkdirSync(join(cwd, 'docs'));
    writeFileSync(join(cwd, 'src', 'app.ts'), 'export const answer = 42;\n');
    writeFileSync(join(cwd, 'docs', 'plan.md'), '# Plan\nShip it.\n');
    writeFileSync(join(cwd, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  });

  afterEach(() => {
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  });

  it('extracts unique @ mentions and strips trailing punctuation', () => {
    expect(extractFileMentions('read @src/app.ts, then @docs/plan.md. and @src/app.ts')).toEqual([
      'src/app.ts',
      'docs/plan.md',
    ]);
  });

  it('loads referenced file contents inside the project', () => {
    const files = collectReferencedFiles('explain @src/app.ts', cwd);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: 'src/app.ts',
      kind: 'file',
      content: 'export const answer = 42;\n',
    });
  });

  it('summarizes referenced directories', () => {
    const files = collectReferencedFiles('open @src', cwd);

    expect(files[0].kind).toBe('directory');
    expect(files[0].entries).toContain('file app.ts');
  });

  it('does not load paths outside the project', () => {
    const files = collectReferencedFiles('read @../secret.txt', cwd);

    expect(files[0].kind).toBe('outside');
    expect(files[0].error).toContain('outside');
  });

  it('marks missing and binary references without throwing', () => {
    const files = collectReferencedFiles('read @missing.txt and @bin.dat', cwd);

    expect(files.map(file => file.kind)).toEqual(['missing', 'binary']);
  });

  it('renders referenced files for prompt injection', () => {
    const prompt = buildReferencedFilesPrompt('read @src/app.ts and @docs', cwd);

    expect(prompt).toContain('User-referenced files');
    expect(prompt).toContain('### @src/app.ts');
    expect(prompt).toContain('export const answer = 42;');
    expect(prompt).toContain('### @docs');
    expect(prompt).toContain('file plan.md');
  });

  it('respects total render budget', () => {
    const rendered = renderReferencedFiles(
      collectReferencedFiles('read @src/app.ts @docs/plan.md', cwd),
      { maxTotalChars: 80 }
    );

    expect(rendered).toContain('[truncated by context budget]');
    expect(rendered.length).toBeLessThanOrEqual(180);
  });
});
