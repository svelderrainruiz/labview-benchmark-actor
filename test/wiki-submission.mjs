// Runs the offline wiki-submission fixtures (test/wiki_submission_test.py) with the Python 3 standard library.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const python = ['python3', 'python', 'py'].find((candidate) => spawnSync(candidate, ['-c', 'import sys; sys.exit(sys.version_info < (3, 9))']).status === 0);
if (!python) throw new Error('wiki-submission tests need Python 3.9+ (python3, python or py)');
const result = spawnSync(python, ['-B', '-m', 'unittest', 'discover', '-v', '-s', 'test', '-p', 'wiki_submission_test.py'], { cwd: root, stdio: 'inherit', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('wiki-submission fixtures passed');
