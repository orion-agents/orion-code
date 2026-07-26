import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { matchFiles } from '../src/services/file-glob';

describe('file glob matching', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openhorse-file-glob-'));
  });

  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('matches file prefixes case-insensitively by default', () => {
    writeFileSync(join(root, 'Readme.md'), 'docs');
    writeFileSync(join(root, 'runtime.ts'), 'code');

    expect(matchFiles('read', root).map(item => item.path)).toEqual(['Readme.md']);
  });

  it('allows UI callers to request more than the default 20 matches', () => {
    mkdirSync(join(root, 'src'));
    for (let index = 0; index < 30; index++) {
      writeFileSync(join(root, 'src', `component-${String(index).padStart(2, '0')}.ts`), '');
    }

    expect(matchFiles('src/component', root)).toHaveLength(20);
    expect(matchFiles('src/component', root, { limit: 80 })).toHaveLength(30);
  });
});
