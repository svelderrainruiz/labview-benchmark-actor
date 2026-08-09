export function spawnInvocation(command, args, {
  platform = process.platform,
  comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
} = {}) {
  if (platform !== 'win32' || !/\.cmd$/i.test(command)) {
    return { command, args };
  }
  return {
    command: comspec,
    args: ['/d', '/s', '/c', command, ...args],
  };
}
