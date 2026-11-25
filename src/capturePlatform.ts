import * as path from 'node:path';

export type CaptureWorkload = 'labview-launch' | 'desktop-capture';

export interface CaptureMetadata {
  workload: CaptureWorkload;
  plane: 'WIN' | 'LINUX';
  source: CaptureSource;
  frameIntervalSeconds?: number;
  /** #134 local-model loop: a desktop capture at a frame rate (frames per second) instead of an interval. */
  framesPerSecond?: number;
}

export const CAPTURE_SOURCES = ['ffmpeg-gdigrab', 'ffmpeg-x11grab', 'gnome-shell-screencast', 'ffmpeg-lavfi-testsrc'] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];
export const MAX_CAPTURE_FPS = 30;

export function desktopCaptureInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 120) {
    throw new Error('Desktop frame interval must be an integer from 1 through 120 seconds');
  }
  return value;
}

/** A desktop frame rate in frames per second: a number above 0 and at most 30. */
export function captureFramesPerSecond(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_CAPTURE_FPS) {
    throw new Error(`Capture frame rate must be a number above 0 and at most ${MAX_CAPTURE_FPS} frames per second`);
  }
  return value;
}

/** The frame rate a capture was recorded at, from its capture-meta.json: framesPerSecond, else 1/interval, else 12. */
export function captureFpsOf(meta: Pick<CaptureMetadata, 'workload' | 'frameIntervalSeconds' | 'framesPerSecond'>): number {
  if (meta.framesPerSecond !== undefined) return captureFramesPerSecond(meta.framesPerSecond);
  return meta.workload === 'desktop-capture' ? 1 / desktopCaptureInterval(meta.frameIntervalSeconds) : 12;
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

export function captureMetadataForPlatform(platform: NodeJS.Platform, sessionType = ''): CaptureMetadata {
  if (platform === 'linux') {
    if (sessionType.trim().toLowerCase() === 'wayland') {
      return { workload: 'labview-launch', plane: 'LINUX', source: 'gnome-shell-screencast' };
    }
    return { workload: 'labview-launch', plane: 'LINUX', source: 'ffmpeg-x11grab' };
  }
  return { workload: 'labview-launch', plane: 'WIN', source: 'ffmpeg-gdigrab' };
}

export function gnomeScreencastScript(): string {
  return [
    'const { Gio, GLib, GLibUnix } = imports.gi;',
    'const proxy = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null, "org.gnome.Shell.Screencast", "/org/gnome/Shell/Screencast", "org.gnome.Shell.Screencast", null);',
    'const options = { framerate: new GLib.Variant("i", 12), "draw-cursor": new GLib.Variant("b", true) };',
    'const [started, output] = proxy.call_sync("Screencast", new GLib.Variant("(sa{sv})", [ARGV[0], options]), Gio.DBusCallFlags.NONE, -1, null).deep_unpack();',
    'if (!started) throw new Error("GNOME Shell rejected the screencast request");',
    'print(`READY:${output}`);',
    'const loop = new GLib.MainLoop(null, false);',
    'const stop = () => { try { proxy.call_sync("StopScreencast", null, Gio.DBusCallFlags.NONE, -1, null); } finally { loop.quit(); } return GLib.SOURCE_REMOVE; };',
    'GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 2, stop);',
    'GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 15, stop);',
    'loop.run();',
  ].join('\n');
}

export function x11DisplayForCapture(env: NodeJS.ProcessEnv = process.env): string {
  const display = String(env.DISPLAY || '').trim();
  if (!display) throw new Error('Linux LabVIEW capture requires DISPLAY from the active graphical session');
  const sessionType = String(env.XDG_SESSION_TYPE || '').trim().toLowerCase();
  if (sessionType !== 'x11') {
    throw new Error('Ubuntu LabVIEW capture requires an Xorg session (XDG_SESSION_TYPE=x11); Wayland rootless Xwayland produces incomplete frames');
  }
  return display;
}

export function ffmpegCaptureArgsForPlatform(
  platform: NodeJS.Platform,
  framePattern: string,
  env: NodeJS.ProcessEnv = process.env,
  x11VideoSize?: string,
  frameIntervalSeconds?: number,
): string[] {
  const frameRate = frameIntervalSeconds === undefined ? '12' : `1/${desktopCaptureInterval(frameIntervalSeconds)}`;
  return ffmpegFrameCaptureArgs(platform, framePattern, frameRate, env, x11VideoSize);
}

/** The desktop frame-sequence capture argv (gdigrab on Windows, x11grab on Xorg) at an ffmpeg `-framerate` value. */
export function ffmpegFrameCaptureArgs(
  platform: NodeJS.Platform,
  framePattern: string,
  frameRate: string,
  env: NodeJS.ProcessEnv = process.env,
  x11VideoSize?: string,
): string[] {
  if (platform === 'win32') {
    return ['-y', '-f', 'gdigrab', '-framerate', frameRate, '-i', 'desktop', framePattern];
  }
  if (platform === 'linux') {
    const display = x11DisplayForCapture(env);
    const videoSize = String(x11VideoSize ?? '');
    if (!/^[1-9]\d*x[1-9]\d*$/.test(videoSize)) {
      throw new Error('Ubuntu LabVIEW capture requires the active X11 desktop dimensions');
    }
    return ['-y', '-f', 'x11grab', '-framerate', frameRate, '-video_size', videoSize, '-draw_mouse', '0', '-i', display, framePattern];
  }
  throw new Error(`LabVIEW launch capture is unsupported on ${platform}`);
}

/** A synthetic frame-sequence capture (ffmpeg lavfi testsrc, read at its real rate) for CI and headless checks. */
export function ffmpegTestSourceArgs(framePattern: string, framesPerSecond: number, size = '640x360'): string[] {
  const fps = captureFramesPerSecond(framesPerSecond);
  if (!/^[1-9]\d*x[1-9]\d*$/.test(size)) throw new Error('Test source size must be WIDTHxHEIGHT');
  return ['-y', '-re', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=${fps}`, framePattern];
}

export function parseX11DisplaySize(xdpyinfo: string): string {
  const match = /\bdimensions:\s+([1-9]\d*)x([1-9]\d*)\s+pixels\b/i.exec(xdpyinfo);
  if (!match) throw new Error('xdpyinfo did not report active X11 desktop dimensions');
  return `${match[1]}x${match[2]}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function linuxSamplerScript(outFile: string): string {
  const out = shellQuote(outFile);
  return [
    'set -eu',
    `out=${out}`,
    'epoch_ms() {',
    '  local ns; ns=$(date +%s%N)',
    '  printf \'%s\\n\' "${ns:0:${#ns}-6}"',
    '}',
    'read_cpu() {',
    "  awk '/^cpu / { idle=$5+$6; total=0; for(i=2;i<=NF;i++) total+=$i; print total, idle; exit }' /proc/stat",
    '}',
    'read_disks() {',
    "  awk 'NF >= 14 { print $3, $6, $10, $13 }' /proc/diskstats",
    '}',
    'declare -A prev_read prev_write prev_io',
    'while read -r name sectors_read sectors_written io_ms; do',
    '  case "$name" in loop*|ram*|zram*) continue ;; esac',
    '  [ -d "/sys/block/$name" ] || continue',
    '  prev_read["$name"]=$sectors_read',
    '  prev_write["$name"]=$sectors_written',
    '  prev_io["$name"]=$io_ms',
    'done < <(read_disks)',
    'prev_ms=$(epoch_ms)',
    'set -- $(read_cpu); prev_total=$1; prev_idle=$2',
    'while true; do',
    '  sleep 0.1',
    '  set -- $(read_cpu); total=$1; idle=$2',
    '  total_delta=$((total-prev_total)); idle_delta=$((idle-prev_idle))',
    "  cpu=$(awk -v t=\"$total_delta\" -v i=\"$idle_delta\" 'BEGIN { if (t <= 0) print 0; else printf \"%.1f\", 100*(t-i)/t }')",
    "  total_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)",
    "  avail_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)",
    "  ram=$(awk -v t=\"$total_kb\" -v a=\"$avail_kb\" 'BEGIN { printf \"%.1f\", (t-a)/1024 }')",
    '  ms=$(epoch_ms)',
    '  elapsed=$((ms-prev_ms)); [ "$elapsed" -gt 0 ] || elapsed=1',
    "  disk_pct=0; disks=''; separator=''",
    '  while read -r name sectors_read sectors_written io_ms; do',
    '    case "$name" in loop*|ram*|zram*) continue ;; esac',
    '    [ -d "/sys/block/$name" ] || continue',
    '    read_delta=$((sectors_read-${prev_read[$name]:-$sectors_read}))',
    '    write_delta=$((sectors_written-${prev_write[$name]:-$sectors_written}))',
    '    io_delta=$((io_ms-${prev_io[$name]:-$io_ms}))',
    '    [ "$read_delta" -ge 0 ] || read_delta=0',
    '    [ "$write_delta" -ge 0 ] || write_delta=0',
    '    [ "$io_delta" -ge 0 ] || io_delta=0',
    "    read_mbs=$(awk -v s=\"$read_delta\" -v e=\"$elapsed\" 'BEGIN { printf \"%.3f\", s*512*1000/e/1000000 }')",
    "    write_mbs=$(awk -v s=\"$write_delta\" -v e=\"$elapsed\" 'BEGIN { printf \"%.3f\", s*512*1000/e/1000000 }')",
    "    util=$(awk -v i=\"$io_delta\" -v e=\"$elapsed\" 'BEGIN { v=100*i/e; if(v>100)v=100; printf \"%.1f\", v }')",
    "    disk_pct=$(awk -v a=\"$disk_pct\" -v b=\"$util\" 'BEGIN { print (b>a ? b : a) }')",
    "    disks=\"${disks}${separator}{\\\"name\\\":\\\"${name}\\\",\\\"writeMBs\\\":${write_mbs},\\\"readMBs\\\":${read_mbs}}\"",
    "    separator=','",
    '    prev_read["$name"]=$sectors_read',
    '    prev_write["$name"]=$sectors_written',
    '    prev_io["$name"]=$io_ms',
    '  done < <(read_disks)',
    "  printf '{\"ms\":%s,\"cpuPct\":%s,\"ramMb\":%s,\"diskPct\":%s,\"disks\":[%s]}\\n' \"$ms\" \"$cpu\" \"$ram\" \"$disk_pct\" \"$disks\" >> \"$out\"",
    '  prev_total=$total; prev_idle=$idle',
    '  prev_ms=$ms',
    'done',
  ].join('\n');
}

// PowerShell sampler: fast System.Diagnostics.PerformanceCounter reads (NextValue() is sub-ms, unlike the old
// ~0.8 s CIM loop) frame-locked to ~100 ms. Emits CPU %, used RAM MB, disk % busy (kept for back-compat) AND
// per-PHYSICAL-DISK write/read THROUGHPUT in MB/s (decimal, bytes/1e6) for every physical disk. A modest
// sustained write (e.g. ~11 MB/s) registers on the throughput curve even though % Disk Time barely moves.
export function windowsSamplerScript(outFile: string): string {
  const out = outFile.replace(/'/g, "''");
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$out='${out}'`,
    'function NewPC($cat,$ctr,$inst){ try { if ($inst) { New-Object System.Diagnostics.PerformanceCounter $cat,$ctr,$inst } else { New-Object System.Diagnostics.PerformanceCounter $cat,$ctr } } catch { $null } }',
    '$totalMb=[math]::Round((Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize/1024,0)',
    "$cpu=NewPC 'Processor' '% Processor Time' '_Total'",
    "$avail=NewPC 'Memory' 'Available MBytes' $null",
    "$dt=NewPC 'PhysicalDisk' '% Disk Time' '_Total'",
    "$insts=@()",
    "try { $insts=@((New-Object System.Diagnostics.PerformanceCounterCategory 'PhysicalDisk').GetInstanceNames() | Where-Object { $_ -ne '_Total' } | Sort-Object) } catch {}",
    '$wc=@{}; $rc=@{}',
    "foreach($i in $insts){ $wc[$i]=NewPC 'PhysicalDisk' 'Disk Write Bytes/sec' $i; $rc[$i]=NewPC 'PhysicalDisk' 'Disk Read Bytes/sec' $i }",
    'foreach($x in @($cpu,$dt)+$wc.Values+$rc.Values){ if($x){ try{ [void]$x.NextValue() }catch{} } }',
    'while ($true) {',
    '  $t0=[DateTimeOffset]::UtcNow',
    '  $c=if($cpu){[math]::Round($cpu.NextValue(),1)}else{0}',
    '  $am=if($avail){$avail.NextValue()}else{0}',
    '  $r=[math]::Round($totalMb-$am,1)',
    '  $d=if($dt){[math]::Round($dt.NextValue(),1)}else{0}',
    '  $ds=@()',
    '  foreach($i in $insts){',
    '    $w=if($wc[$i]){[math]::Round($wc[$i].NextValue()/1000000,3)}else{0}',
    '    $rd=if($rc[$i]){[math]::Round($rc[$i].NextValue()/1000000,3)}else{0}',
    '    $nm=$i.Replace(\'"\',\'\')',
    '    $ds+=("{""name"":"""+$nm+""",""writeMBs"":"+$w+",""readMBs"":"+$rd+"}")',
    '  }',
    '  $ms=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    '  Add-Content -Path $out -Value ("{""ms"":"+$ms+",""cpuPct"":"+$c+",""ramMb"":"+$r+",""diskPct"":"+$d+",""disks"":["+($ds -join ",")+"]}")',
    '  $el=([DateTimeOffset]::UtcNow-$t0).TotalMilliseconds',
    '  $sl=100-$el; if($sl -gt 0){ Start-Sleep -Milliseconds ([int]$sl) }',
    '}',
  ].join('\n');
}

/** The CPU/RAM/disk sampler process for a capture: bash over /proc on Linux, PowerShell counters on Windows. */
export function resourceSamplerCommand(platform: NodeJS.Platform, outFile: string): { command: string; args: string[]; windowsHide: boolean } {
  if (platform === 'linux') return { command: 'bash', args: ['-c', linuxSamplerScript(outFile)], windowsHide: false };
  return { command: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', windowsSamplerScript(outFile)], windowsHide: true };
}

export const EXTENSION_ID = 'svelderrainruiz.labview-benchmark-actor';

/** The captures root the installed extension uses: VS Code's globalStorage for this extension + `captures`. */
export function defaultCapturesDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  let userDir: string;
  if (platform === 'win32') {
    const appData = String(env.APPDATA ?? '').trim();
    userDir = join(appData || join(home, 'AppData', 'Roaming'), 'Code', 'User');
  } else if (platform === 'darwin') {
    userDir = join(home, 'Library', 'Application Support', 'Code', 'User');
  } else {
    const config = String(env.XDG_CONFIG_HOME ?? '').trim();
    userDir = join(config || join(home, '.config'), 'Code', 'User');
  }
  return join(userDir, 'globalStorage', EXTENSION_ID, 'captures');
}
