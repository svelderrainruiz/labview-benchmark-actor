function quoteForCmd(value) {
  const text = String(value);
  if (/^[A-Za-z0-9._:/\\-]+$/.test(text)) {
    return text;
  }
  return `"${text.replace(/(["^&|<>])/g, '^$1')}"`;
}

export function spawnInvocation(command, args, {
  platform = process.platform,
  comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
} = {}) {
  if (platform !== 'win32' || !/\.cmd$/i.test(command)) {
    return { command, args };
  }
  const commandText = [quoteForCmd(command), ...args.map(quoteForCmd)].join(' ');
  return {
    command: comspec,
    args: ['/d', '/s', '/c', `call ${commandText}`],
  };
}
