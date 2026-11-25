// test/package-files.mjs -- the .vsix must not carry the repository's kit or tooling root files (issue #98).
// `.wiki-generator.json` shipped inside the package once, and a Windows checkout turned it into CRLF, so the
// package differed per plane. This test lists the files `vsce` would package and fails when one of those root
// dotfiles is in the list; a negative control proves the check rejects a list that contains one.
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLING = /^(\.wiki-generator\.json|\.cruft\.json|\.repo-standards-review(\.json|\/.*)?)$/;

export function toolingFilesIn(list) {
  return list.map((entry) => entry.replace(/\\/g, '/')).filter((entry) => TOOLING.test(entry));
}

assert.deepStrictEqual(
  toolingFilesIn(['package.json', '.wiki-generator.json', '.cruft.json', '.repo-standards-review.json', '.repo-standards-review/wiki_generate.py', 'media/viewer.js']),
  ['.wiki-generator.json', '.cruft.json', '.repo-standards-review.json', '.repo-standards-review/wiki_generate.py'],
  'negative control: the check must flag every kit and tooling root file',
);

const vsce = join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
const packaged = execFileSync(process.execPath, [vsce, 'ls'], { cwd: root, stdio: 'pipe' }).toString().split(/\r?\n/).filter(Boolean);
assert.ok(packaged.length > 0 && packaged.includes('package.json'), 'precondition: vsce ls lists the package files');
assert.deepStrictEqual(toolingFilesIn(packaged), [], 'kit or tooling root files must not be in the .vsix (add them to .vscodeignore)');
console.log(`package-files: PASS, ${packaged.length} packaged files, no kit or tooling root file`);
