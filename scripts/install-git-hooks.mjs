import { execFileSync } from 'node:child_process';

try {
  const current = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (current && current !== '.githooks') {
    console.error(
      `Git hooks path '${current}' conflicts with mandatory .githooks. `
      + 'Chain scripts/release-components.mjs --precommit from that hook or unset core.hooksPath, then retry.'
    );
    process.exit(1);
  }
} catch {
  // An unset hooks path is the expected first-install state.
}

try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
  console.log('Installed repository Git hooks from .githooks.');
} catch {
  console.log('Git worktree unavailable; repository hooks were not installed.');
}
