export interface CaptureMetadata {
  workload: 'labview-launch';
  plane: 'WIN' | 'LINUX';
  source: 'ffmpeg-gdigrab' | 'ffmpeg-x11grab';
}

export function labviewCandidatesForPlatform(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    return [
      'C:\\Program Files (x86)\\National Instruments\\LabVIEW 2026\\LabVIEW.exe',
      'C:\\Program Files\\National Instruments\\LabVIEW 2026\\LabVIEW.exe',
    ];
  }
  if (platform === 'linux') {
    return [
      '/usr/local/natinst/LabVIEW-2026-64/labview',
      '/usr/local/natinst/LabVIEW-2026-64/labview64',
    ];
  }
  return [];
}

export function captureMetadataForPlatform(platform: NodeJS.Platform): CaptureMetadata {
  if (platform === 'linux') {
    return { workload: 'labview-launch', plane: 'LINUX', source: 'ffmpeg-x11grab' };
  }
  return { workload: 'labview-launch', plane: 'WIN', source: 'ffmpeg-gdigrab' };
}

export function ffmpegCaptureArgsForPlatform(
  platform: NodeJS.Platform,
  framePattern: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'win32') {
    return ['-y', '-f', 'gdigrab', '-framerate', '12', '-i', 'desktop', framePattern];
  }
  if (platform === 'linux') {
    const display = String(env.DISPLAY || '').trim();
    if (!display) throw new Error('Linux LabVIEW capture requires DISPLAY from the active graphical session');
    return ['-y', '-f', 'x11grab', '-framerate', '12', '-draw_mouse', '0', '-i', display, framePattern];
  }
  throw new Error(`LabVIEW launch capture is unsupported on ${platform}`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function linuxSamplerScript(outFile: string): string {
  const out = shellQuote(outFile);
  return [
    'set -eu',
    `out=${out}`,
    'read_cpu() {',
    "  awk '/^cpu / { idle=$5+$6; total=0; for(i=2;i<=NF;i++) total+=$i; print total, idle; exit }' /proc/stat",
    '}',
    'set -- $(read_cpu); prev_total=$1; prev_idle=$2',
    'while true; do',
    '  sleep 0.1',
    '  set -- $(read_cpu); total=$1; idle=$2',
    '  total_delta=$((total-prev_total)); idle_delta=$((idle-prev_idle))',
    "  cpu=$(awk -v t=\"$total_delta\" -v i=\"$idle_delta\" 'BEGIN { if (t <= 0) print 0; else printf \"%.1f\", 100*(t-i)/t }')",
    "  total_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)",
    "  avail_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)",
    "  ram=$(awk -v t=\"$total_kb\" -v a=\"$avail_kb\" 'BEGIN { printf \"%.1f\", (t-a)/1024 }')",
    '  ms=$(date +%s%3N)',
    "  printf '{\"ms\":%s,\"cpuPct\":%s,\"ramMb\":%s,\"diskPct\":0,\"disks\":[]}\\n' \"$ms\" \"$cpu\" \"$ram\" >> \"$out\"",
    '  prev_total=$total; prev_idle=$idle',
    'done',
  ].join('\n');
}
