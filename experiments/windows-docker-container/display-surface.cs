using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public sealed class LbaRect {
  public int left { get; set; }
  public int top { get; set; }
  public int right { get; set; }
  public int bottom { get; set; }
}

public sealed class LbaWindowInfo {
  public long handle { get; set; }
  public uint processId { get; set; }
  public string title { get; set; }
  public string className { get; set; }
  public bool visible { get; set; }
  public bool minimized { get; set; }
  public string desktop { get; set; }
  public LbaRect bounds { get; set; }
}

public sealed class LbaDesktopContext {
  public string mode { get; set; }
  public string windowStation { get; set; }
  public string desktop { get; set; }
  public string qualifiedDesktop { get; set; }
  public string explicitStartupDesktop { get; set; }
  public bool processWindowStationChanged { get; set; }
  public bool threadDesktopSet { get; set; }
  public int threadDesktopError { get; set; }
}

public sealed class LbaDisplayDevice {
  public string deviceName { get; set; }
  public string deviceString { get; set; }
  public string deviceId { get; set; }
  public string deviceKey { get; set; }
  public uint stateFlags { get; set; }
  public bool attachedToDesktop { get; set; }
  public bool primary { get; set; }
  public bool currentModeAvailable { get; set; }
  public int currentModeError { get; set; }
  public int positionX { get; set; }
  public int positionY { get; set; }
  public int width { get; set; }
  public int height { get; set; }
  public int bitsPerPixel { get; set; }
  public int frequency { get; set; }
}

public sealed class LbaDisplayDiagnostics {
  public int processId { get; set; }
  public int sessionId { get; set; }
  public LbaDesktopContext context { get; set; }
  public int smCmonitors { get; set; }
  public int primaryWidth { get; set; }
  public int primaryHeight { get; set; }
  public int virtualLeft { get; set; }
  public int virtualTop { get; set; }
  public int virtualWidth { get; set; }
  public int virtualHeight { get; set; }
  public bool getDcSucceeded { get; set; }
  public int getDcError { get; set; }
  public int enumDisplayMonitorsError { get; set; }
  public LbaRect[] monitorRectangles { get; set; }
  public int screenBitsPixel { get; set; }
  public int screenPlanes { get; set; }
  public int screenColorDepth { get; set; }
  public int screenHorzRes { get; set; }
  public int screenVertRes { get; set; }
  public LbaDisplayDevice[] displayDevices { get; set; }
  public int queryDisplayConfigBufferResult { get; set; }
  public int queryDisplayConfigResult { get; set; }
  public uint activePathCount { get; set; }
  public uint activeModeCount { get; set; }
}

public sealed class LbaCaptureAnalysis {
  public bool passed { get; set; }
  public string reason { get; set; }
  public int width { get; set; }
  public int height { get; set; }
  public int originX { get; set; }
  public int originY { get; set; }
  public long pixels { get; set; }
  public int meaningfulThreshold { get; set; }
  public int meaningfulLumaPopulations { get; set; }
  public double blackFraction { get; set; }
  public double transparentFraction { get; set; }
  public long[] lumaBins { get; set; }
}

public static class LbaDesktop {
  const uint MAXIMUM_ALLOWED = 0x02000000;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  const int UOI_NAME = 2;
  const int SM_CXSCREEN = 0;
  const int SM_CYSCREEN = 1;
  const int SM_XVIRTUALSCREEN = 76;
  const int SM_YVIRTUALSCREEN = 77;
  const int SM_CXVIRTUALSCREEN = 78;
  const int SM_CYVIRTUALSCREEN = 79;
  const int SM_CMONITORS = 80;
  const int BITSPIXEL = 12;
  const int PLANES = 14;
  const int HORZRES = 8;
  const int VERTRES = 10;
  const uint DISPLAY_DEVICE_ATTACHED_TO_DESKTOP = 0x1;
  const uint DISPLAY_DEVICE_PRIMARY_DEVICE = 0x4;
  const uint ENUM_CURRENT_SETTINGS = 0xffffffff;
  const uint QDC_ONLY_ACTIVE_PATHS = 0x2;
  const uint SRCCOPY = 0x00CC0020;
  const uint CAPTUREBLT = 0x40000000;
  const uint DIB_RGB_COLORS = 0;
  static IntPtr selectedWindowStation = IntPtr.Zero;
  static IntPtr selectedDesktop = IntPtr.Zero;
  static LbaDesktopContext context;

  [StructLayout(LayoutKind.Sequential)]
  struct RECT { public int Left, Top, Right, Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  struct POINTL { public int x, y; }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread;
    public uint dwProcessId, dwThreadId;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct DISPLAY_DEVICE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public uint StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
    public int dmFields;
    public POINTL dmPosition;
    public int dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct BITMAPINFOHEADER {
    public uint biSize;
    public int biWidth, biHeight;
    public ushort biPlanes, biBitCount;
    public uint biCompression, biSizeImage;
    public int biXPelsPerMeter, biYPelsPerMeter;
    public uint biClrUsed, biClrImportant;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct BITMAPINFO { public BITMAPINFOHEADER bmiHeader; }

  delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lparam);
  delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, ref RECT rect, IntPtr data);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr OpenWindowStation(string name, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool SetProcessWindowStation(IntPtr handle);
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr OpenDesktop(string name, uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr handle);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint threadId);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes,
    IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory,
    ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int length, out int needed);
  [DllImport("user32.dll", SetLastError = true)] static extern bool EnumDesktopWindows(IntPtr desktop, EnumWindowsProc callback, IntPtr lparam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder value, int length);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder value, int length);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetDC(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
  [DllImport("user32.dll", SetLastError = true)] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool EnumDisplayDevices(string device, uint index, ref DISPLAY_DEVICE displayDevice, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool EnumDisplaySettings(string deviceName, uint modeNum, ref DEVMODE devMode);
  [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, ref uint paths, ref uint modes);
  [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint paths, IntPtr pathInfo, ref uint modes, IntPtr modeInfo, IntPtr topologyId);
  [DllImport("gdi32.dll")] static extern int GetDeviceCaps(IntPtr hdc, int index);
  [DllImport("gdi32.dll", SetLastError = true)] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll", SetLastError = true)] static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int width, int height);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
  [DllImport("gdi32.dll", SetLastError = true)] static extern bool BitBlt(IntPtr dst, int x, int y, int width, int height, IntPtr src, int srcX, int srcY, uint rop);
  [DllImport("gdi32.dll", SetLastError = true)] static extern int GetDIBits(IntPtr hdc, IntPtr bitmap, uint start, uint lines, byte[] bits, ref BITMAPINFO info, uint usage);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);

  static string ObjectName(IntPtr handle) {
    var value = new StringBuilder(512);
    int needed;
    if (!GetUserObjectInformation(handle, UOI_NAME, value, value.Capacity * 2, out needed))
      throw new InvalidOperationException("GetUserObjectInformation failed: " + Marshal.GetLastWin32Error());
    return value.ToString();
  }

  public static LbaDesktopContext Configure(string mode) {
    if (mode != "Inherited" && mode != "WinSta0") throw new ArgumentException("Unsupported desktop target: " + mode);
    bool changed = false, threadSet = false;
    int threadError = 0;
    if (mode == "WinSta0") {
      selectedWindowStation = OpenWindowStation("WinSta0", false, MAXIMUM_ALLOWED);
      if (selectedWindowStation == IntPtr.Zero) throw new InvalidOperationException("OpenWindowStation failed: " + Marshal.GetLastWin32Error());
      if (!SetProcessWindowStation(selectedWindowStation)) throw new InvalidOperationException("SetProcessWindowStation failed: " + Marshal.GetLastWin32Error());
      changed = true;
      selectedDesktop = OpenDesktop("Default", 0, false, MAXIMUM_ALLOWED);
      if (selectedDesktop == IntPtr.Zero) throw new InvalidOperationException("OpenDesktop failed: " + Marshal.GetLastWin32Error());
      threadSet = SetThreadDesktop(selectedDesktop);
      threadError = threadSet ? 0 : Marshal.GetLastWin32Error();
      if (!threadSet && threadError != 170) throw new InvalidOperationException("SetThreadDesktop failed: " + threadError);
    } else {
      selectedWindowStation = GetProcessWindowStation();
      selectedDesktop = GetThreadDesktop(GetCurrentThreadId());
      if (selectedWindowStation == IntPtr.Zero || selectedDesktop == IntPtr.Zero)
        throw new InvalidOperationException("Inherited GUI handles are unavailable");
    }
    string stationName = ObjectName(GetProcessWindowStation());
    string desktopName = ObjectName(selectedDesktop);
    context = new LbaDesktopContext {
      mode = mode,
      windowStation = stationName,
      desktop = desktopName,
      qualifiedDesktop = stationName + "\\" + desktopName,
      explicitStartupDesktop = mode == "WinSta0" ? "WinSta0\\Default" : null,
      processWindowStationChanged = changed,
      threadDesktopSet = threadSet,
      threadDesktopError = threadError
    };
    return context;
  }

  public static LbaDesktopContext CurrentContext() {
    if (context == null) throw new InvalidOperationException("Desktop target has not been configured");
    return context;
  }

  public static int StartOnSelectedDesktop(string application, string arguments, string workingDirectory) {
    if (context == null) throw new InvalidOperationException("Desktop target has not been configured");
    var startup = new STARTUPINFO();
    startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    startup.lpDesktop = context.explicitStartupDesktop;
    var process = new PROCESS_INFORMATION();
    string command = "\"" + application + "\"";
    if (!String.IsNullOrWhiteSpace(arguments)) command += " " + arguments;
    var commandLine = new StringBuilder(command);
    if (!CreateProcess(application, commandLine, IntPtr.Zero, IntPtr.Zero, false, CREATE_UNICODE_ENVIRONMENT,
      IntPtr.Zero, workingDirectory, ref startup, out process))
      throw new InvalidOperationException("CreateProcess failed: " + Marshal.GetLastWin32Error());
    try { return checked((int)process.dwProcessId); }
    finally { CloseHandle(process.hThread); CloseHandle(process.hProcess); }
  }

  public static LbaWindowInfo[] WindowsOnSelectedDesktop() {
    if (selectedDesktop == IntPtr.Zero || context == null) throw new InvalidOperationException("Desktop target has not been configured");
    var result = new List<LbaWindowInfo>();
    if (!EnumDesktopWindows(selectedDesktop, delegate(IntPtr hwnd, IntPtr ignored) {
      uint processId;
      GetWindowThreadProcessId(hwnd, out processId);
      var title = new StringBuilder(1024);
      var className = new StringBuilder(512);
      RECT rect;
      GetWindowText(hwnd, title, title.Capacity);
      GetClassName(hwnd, className, className.Capacity);
      GetWindowRect(hwnd, out rect);
      result.Add(new LbaWindowInfo {
        handle = hwnd.ToInt64(), processId = processId, title = title.ToString(), className = className.ToString(),
        visible = IsWindowVisible(hwnd), minimized = IsIconic(hwnd), desktop = context.qualifiedDesktop,
        bounds = new LbaRect { left = rect.Left, top = rect.Top, right = rect.Right, bottom = rect.Bottom }
      });
      return true;
    }, IntPtr.Zero)) throw new InvalidOperationException("EnumDesktopWindows failed: " + Marshal.GetLastWin32Error());
    return result.ToArray();
  }

  public static LbaDisplayDiagnostics DiagnoseDisplay(int processId, int sessionId) {
    if (context == null) throw new InvalidOperationException("Desktop target has not been configured");
    var monitorRects = new List<LbaRect>();
    var devices = new List<LbaDisplayDevice>();
    int dcError = 0, monitorError = 0;
    IntPtr hdc = GetDC(IntPtr.Zero);
    if (hdc == IntPtr.Zero) dcError = Marshal.GetLastWin32Error();
    else {
      if (!EnumDisplayMonitors(hdc, IntPtr.Zero, delegate(IntPtr monitor, IntPtr dc, ref RECT rect, IntPtr data) {
        monitorRects.Add(new LbaRect { left = rect.Left, top = rect.Top, right = rect.Right, bottom = rect.Bottom });
        return true;
      }, IntPtr.Zero)) monitorError = Marshal.GetLastWin32Error();
    }
    for (uint i = 0; ; i++) {
      var device = new DISPLAY_DEVICE { cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE)) };
      if (!EnumDisplayDevices(null, i, ref device, 0)) break;
      var mode = new DEVMODE { dmSize = (short)Marshal.SizeOf(typeof(DEVMODE)) };
      bool modeOk = EnumDisplaySettings(device.DeviceName, ENUM_CURRENT_SETTINGS, ref mode);
      devices.Add(new LbaDisplayDevice {
        deviceName = device.DeviceName, deviceString = device.DeviceString, deviceId = device.DeviceID,
        deviceKey = device.DeviceKey, stateFlags = device.StateFlags,
        attachedToDesktop = (device.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP) != 0,
        primary = (device.StateFlags & DISPLAY_DEVICE_PRIMARY_DEVICE) != 0,
        currentModeAvailable = modeOk, currentModeError = modeOk ? 0 : Marshal.GetLastWin32Error(),
        positionX = mode.dmPosition.x, positionY = mode.dmPosition.y, width = mode.dmPelsWidth,
        height = mode.dmPelsHeight, bitsPerPixel = mode.dmBitsPerPel, frequency = mode.dmDisplayFrequency
      });
    }
    uint pathCount = 0, modeCount = 0;
    int bufferResult = GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, ref pathCount, ref modeCount);
    int queryResult = bufferResult;
    if (bufferResult == 0) {
      IntPtr paths = Marshal.AllocHGlobal(checked((int)Math.Max(1, pathCount) * 256));
      IntPtr modes = Marshal.AllocHGlobal(checked((int)Math.Max(1, modeCount) * 256));
      try { queryResult = QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, ref pathCount, paths, ref modeCount, modes, IntPtr.Zero); }
      finally { Marshal.FreeHGlobal(paths); Marshal.FreeHGlobal(modes); }
    }
    var diagnostics = new LbaDisplayDiagnostics {
      processId = processId, sessionId = sessionId, context = context,
      smCmonitors = GetSystemMetrics(SM_CMONITORS), primaryWidth = GetSystemMetrics(SM_CXSCREEN),
      primaryHeight = GetSystemMetrics(SM_CYSCREEN), virtualLeft = GetSystemMetrics(SM_XVIRTUALSCREEN),
      virtualTop = GetSystemMetrics(SM_YVIRTUALSCREEN), virtualWidth = GetSystemMetrics(SM_CXVIRTUALSCREEN),
      virtualHeight = GetSystemMetrics(SM_CYVIRTUALSCREEN), getDcSucceeded = hdc != IntPtr.Zero, getDcError = dcError,
      enumDisplayMonitorsError = monitorError, monitorRectangles = monitorRects.ToArray(),
      screenBitsPixel = hdc == IntPtr.Zero ? 0 : GetDeviceCaps(hdc, BITSPIXEL),
      screenPlanes = hdc == IntPtr.Zero ? 0 : GetDeviceCaps(hdc, PLANES),
      screenHorzRes = hdc == IntPtr.Zero ? 0 : GetDeviceCaps(hdc, HORZRES),
      screenVertRes = hdc == IntPtr.Zero ? 0 : GetDeviceCaps(hdc, VERTRES),
      displayDevices = devices.ToArray(), queryDisplayConfigBufferResult = bufferResult,
      queryDisplayConfigResult = queryResult, activePathCount = pathCount, activeModeCount = modeCount
    };
    diagnostics.screenColorDepth = diagnostics.screenBitsPixel * diagnostics.screenPlanes;
    if (hdc != IntPtr.Zero) ReleaseDC(IntPtr.Zero, hdc);
    return diagnostics;
  }

  public static LbaCaptureAnalysis CaptureScreen(string pngPath) {
    int left = GetSystemMetrics(SM_XVIRTUALSCREEN), top = GetSystemMetrics(SM_YVIRTUALSCREEN);
    int width = GetSystemMetrics(SM_CXVIRTUALSCREEN), height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if (width <= 0 || height <= 0) throw new InvalidOperationException("Virtual screen dimensions are degenerate");
    IntPtr screen = GetDC(IntPtr.Zero);
    if (screen == IntPtr.Zero) throw new InvalidOperationException("GetDC(NULL) failed: " + Marshal.GetLastWin32Error());
    IntPtr memory = IntPtr.Zero, bitmap = IntPtr.Zero, old = IntPtr.Zero;
    try {
      memory = CreateCompatibleDC(screen);
      bitmap = CreateCompatibleBitmap(screen, width, height);
      if (memory == IntPtr.Zero || bitmap == IntPtr.Zero) throw new InvalidOperationException("GDI capture allocation failed");
      old = SelectObject(memory, bitmap);
      if (!BitBlt(memory, 0, 0, width, height, screen, left, top, SRCCOPY | CAPTUREBLT))
        throw new InvalidOperationException("BitBlt failed: " + Marshal.GetLastWin32Error());
      var info = new BITMAPINFO();
      info.bmiHeader.biSize = (uint)Marshal.SizeOf(typeof(BITMAPINFOHEADER));
      info.bmiHeader.biWidth = width;
      info.bmiHeader.biHeight = -height;
      info.bmiHeader.biPlanes = 1;
      info.bmiHeader.biBitCount = 32;
      byte[] bgra = new byte[checked(width * height * 4)];
      if (GetDIBits(memory, bitmap, 0, (uint)height, bgra, ref info, DIB_RGB_COLORS) != height)
        throw new InvalidOperationException("GetDIBits failed: " + Marshal.GetLastWin32Error());
      long[] bins = new long[16];
      long black = 0, transparent = 0, pixels = (long)width * height;
      for (int i = 0; i < bgra.Length; i += 4) {
        // A screen DC is opaque; its unused fourth byte is not an alpha channel. Normalize it before
        // applying the same RGBA proof that the host applies to the resulting PNG.
        int b = bgra[i], g = bgra[i + 1], r = bgra[i + 2], a = 255;
        bgra[i + 3] = 255;
        int luma = (77 * r + 150 * g + 29 * b) >> 8;
        bins[Math.Min(15, luma >> 4)]++;
        if (luma <= 8) black++;
        if (a <= 8) transparent++;
      }
      int threshold = Math.Max(4, checked((int)Math.Ceiling(pixels * 0.001)));
      int populations = 0;
      foreach (long count in bins) if (count >= threshold) populations++;
      double blackFraction = (double)black / pixels, transparentFraction = (double)transparent / pixels;
      bool passed = populations > 1 && blackFraction < 0.99 && transparentFraction < 0.99;
      using (var output = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
        var locked = output.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        try { Marshal.Copy(bgra, 0, locked.Scan0, bgra.Length); }
        finally { output.UnlockBits(locked); }
        output.Save(pngPath, ImageFormat.Png);
      }
      return new LbaCaptureAnalysis {
        passed = passed, reason = passed ? null : populations <= 1 ? "single-color-or-single-luminance-population" :
          blackFraction >= 0.99 ? "uniformly-black" : "uniformly-transparent",
        width = width, height = height, originX = left, originY = top, pixels = pixels,
        meaningfulThreshold = threshold, meaningfulLumaPopulations = populations,
        blackFraction = blackFraction, transparentFraction = transparentFraction, lumaBins = bins
      };
    } finally {
      if (old != IntPtr.Zero && memory != IntPtr.Zero) SelectObject(memory, old);
      if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
      if (memory != IntPtr.Zero) DeleteDC(memory);
      ReleaseDC(IntPtr.Zero, screen);
    }
  }
}
