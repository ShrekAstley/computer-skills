# computer-skills Windows bridge.
# Long-lived process: reads one JSON request per line on stdin ({"id":..,"op":..,"args":{..}})
# and writes one JSON response per line on stdout ({"id":..,"ok":true,"result":..} or {"id":..,"ok":false,"error":..,"message":..}).
# Runs under Windows PowerShell 5.1 (always present) so WinRT OCR and UI Automation are available.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$script:HasUia = $true
try { Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes } catch { $script:HasUia = $false }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class CsNative {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScan(char c);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  public class Win { public long hwnd; public string title; public string cls; public uint pid; public int x; public int y; public int w; public int h; public bool min; public bool max; public bool fg; }

  public static List<Win> Windows() {
    var list = new List<Win>();
    IntPtr fg = GetForegroundWindow();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true;            // owned (dialogs report via owner)
      int ex = GetWindowLong(h, -20);
      if ((ex & 0x80) != 0) return true;                            // WS_EX_TOOLWINDOW
      int cloaked = 0;
      try { DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch { }
      if (cloaked != 0) return true;                                // hidden UWP / other desktop
      var sb = new StringBuilder(len + 1); GetWindowText(h, sb, sb.Capacity);
      var cb = new StringBuilder(256); GetClassName(h, cb, cb.Capacity);
      uint pid; GetWindowThreadProcessId(h, out pid);
      RECT r; GetWindowRect(h, out r);
      list.Add(new Win { hwnd = h.ToInt64(), title = sb.ToString(), cls = cb.ToString(), pid = pid, x = r.Left, y = r.Top, w = r.Right - r.Left, h = r.Bottom - r.Top, min = IsIconic(h), max = IsZoomed(h), fg = (h == fg) });
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static List<Win> DialogsOf(uint pid) {
    var list = new List<Win>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || GetWindow(h, 4) == IntPtr.Zero) return true;
      int len = GetWindowTextLength(h);
      var sb = new StringBuilder(len + 1); GetWindowText(h, sb, sb.Capacity);
      var cb = new StringBuilder(256); GetClassName(h, cb, cb.Capacity);
      RECT r; GetWindowRect(h, out r);
      list.Add(new Win { hwnd = h.ToInt64(), title = sb.ToString(), cls = cb.ToString(), pid = p, x = r.Left, y = r.Top, w = r.Right - r.Left, h = r.Bottom - r.Top });
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static bool Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    IntPtr fg = GetForegroundWindow();
    uint dummy;
    uint fgThread = GetWindowThreadProcessId(fg, out dummy);
    uint me = GetCurrentThreadId();
    // The ALT tap lifts the foreground lock so SetForegroundWindow is honoured.
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    if (fgThread != me) AttachThreadInput(me, fgThread, true);
    BringWindowToTop(h);
    bool ok = SetForegroundWindow(h);
    if (fgThread != me) AttachThreadInput(me, fgThread, false);
    return ok || GetForegroundWindow() == h;
  }

  static INPUT Mouse(uint flags, uint data) {
    var i = new INPUT(); i.type = 0; i.U.mi = new MOUSEINPUT { dwFlags = flags, mouseData = data }; return i;
  }
  static INPUT Key(ushort vk, ushort scan, uint flags) {
    var i = new INPUT(); i.type = 1; i.U.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags }; return i;
  }
  static void Send(params INPUT[] inputs) { SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }

  public static void Button(string button, bool down) {
    uint f = button == "right" ? (down ? 0x0008u : 0x0010u) : button == "middle" ? (down ? 0x0020u : 0x0040u) : (down ? 0x0002u : 0x0004u);
    Send(Mouse(f, 0));
  }
  public static void Wheel(int dy, int dx) {
    if (dy != 0) Send(Mouse(0x0800, unchecked((uint)(-dy * 120))));
    if (dx != 0) Send(Mouse(0x1000, unchecked((uint)(dx * 120))));
  }
  static bool Extended(ushort vk) {
    return vk == 0x21 || vk == 0x22 || vk == 0x23 || vk == 0x24 || vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28 || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5D || vk == 0x90 || vk == 0x2C;
  }
  public static void KeyDown(ushort vk) { Send(Key(vk, 0, Extended(vk) ? 1u : 0u)); }
  public static void KeyUp(ushort vk) { Send(Key(vk, 0, (Extended(vk) ? 1u : 0u) | 2u)); }
  public static void Combo(ushort[] mods, ushort vk) {
    foreach (var m in mods) KeyDown(m);
    KeyDown(vk); KeyUp(vk);
    for (int i = mods.Length - 1; i >= 0; i--) KeyUp(mods[i]);
  }
  public static void TypeText(string text, int delayMs) {
    foreach (char c in text) {
      if (c == '\r') continue;
      if (c == '\n') { KeyDown(0x0D); KeyUp(0x0D); }
      else if (c == '\t') { KeyDown(0x09); KeyUp(0x09); }
      else Send(Key(0, c, 0x0004), Key(0, c, 0x0004 | 0x0002));
      if (delayMs > 0) System.Threading.Thread.Sleep(delayMs);
    }
  }
}
'@

[void][CsNative]::SetProcessDPIAware()

# ---------------------------------------------------------------- helpers
function New-Win($w) {
  @{ id = ('0x{0:x}' -f $w.hwnd); title = $w.title; className = $w.cls; pid = [int]$w.pid; x = $w.x; y = $w.y; width = $w.w; height = $w.h; minimized = $w.min; maximized = $w.max; focused = $w.fg }
}

function Get-Hwnd($id) { [IntPtr][Convert]::ToInt64((([string]$id) -replace '^0x', ''), 16) }

$script:ProcNames = @{}
function Get-ProcName([int]$procId) {
  if ($script:ProcNames.ContainsKey($procId)) { return $script:ProcNames[$procId] }
  $n = ''
  try { $n = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }
  $script:ProcNames[$procId] = $n
  return $n
}

# ------------------------------------------------------------- UI Automation
$script:Walker = $null
function Get-Walker { if (-not $script:Walker) { $script:Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker }; $script:Walker }

function Get-Patterns($el) {
  $names = New-Object System.Collections.ArrayList
  foreach ($p in $el.GetSupportedPatterns()) { [void]$names.Add(($p.ProgrammaticName -replace 'PatternIdentifiers\.Pattern$', '')) }
  return ,$names
}

function Describe-Element($el, $hwnd) {
  $c = $el.Current
  $r = $c.BoundingRectangle
  $node = @{ role = ($c.ControlType.ProgrammaticName -replace '^ControlType\.', ''); name = $c.Name; ref = @{ kind = 'uia'; hwnd = $hwnd; runtimeId = (($el.GetRuntimeId()) -join '.') } }
  if ($c.AutomationId) { $node.automationId = $c.AutomationId }
  if ($c.ClassName) { $node.className = $c.ClassName }
  if (-not $r.IsEmpty -and -not [double]::IsInfinity($r.X)) { $node.x = [int]$r.X; $node.y = [int]$r.Y; $node.width = [int]$r.Width; $node.height = [int]$r.Height }
  $node.enabled = $c.IsEnabled
  if ($c.HasKeyboardFocus) { $node.focused = $true }
  $pats = Get-Patterns $el
  if ($pats.Count) { $node.actions = $pats }
  if ($pats -contains 'Value') { try { $v = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value; if ($v) { $node.value = $v.Substring(0, [Math]::Min(500, $v.Length)) } } catch { } }
  if ($pats -contains 'Toggle') { try { $node.toggled = [string]$el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState } catch { } }
  return $node
}

function Walk-Element($el, $hwnd, [int]$depth, [int]$maxDepth, $budget) {
  $budget.n--
  $node = Describe-Element $el $hwnd
  if ($depth -ge $maxDepth -or $budget.n -le 0) { return $node }
  $children = New-Object System.Collections.ArrayList
  $w = Get-Walker
  $child = $w.GetFirstChild($el)
  $count = 0
  while ($child -ne $null -and $budget.n -gt 0 -and $count -lt 300) {
    try { if (-not $child.Current.IsOffscreen -or $depth -lt 1) { [void]$children.Add((Walk-Element $child $hwnd ($depth + 1) $maxDepth $budget)) } } catch { }
    $child = $w.GetNextSibling($child)
    $count++
  }
  if ($children.Count) { $node.children = $children }
  return $node
}

function Find-ByRuntimeId($hwnd, [string]$rid) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle((Get-Hwnd $hwnd))
  $ids = [int[]]($rid -split '\.' | ForEach-Object { [int]$_ })
  if ((($root.GetRuntimeId()) -join '.') -eq $rid) { return $root }
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::RuntimeIdProperty, $ids)
  $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if ($el -eq $null) {
    # Popups/menus live outside the window subtree.
    $el = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  }
  if ($el -eq $null) { throw 'NOTFOUND: element no longer exists' }
  return $el
}

function Invoke-UiaAction($el, [string]$action, $value) {
  $P = [System.Windows.Automation.AutomationElement]
  switch ($action) {
    { $_ -in 'press', 'invoke', 'click', 'activate' } {
      $o = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$o)) { $o.Invoke(); return 'Invoke' }
      if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$o)) { $o.Toggle(); return 'Toggle' }
      if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$o)) { $o.Select(); return 'Select' }
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$o)) { $o.Expand(); return 'Expand' }
      if ($el.TryGetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$o)) { $o.DoDefaultAction(); return 'LegacyDefault' }
      throw 'NOPATTERN: element supports no invoke-like pattern'
    }
    'toggle' { $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle(); return 'Toggle' }
    'select' { $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); return 'Select' }
    'expand' { $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand(); return 'Expand' }
    'collapse' { $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse(); return 'Collapse' }
    'focus' { $el.SetFocus(); return 'SetFocus' }
    'set_value' {
      $o = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$o)) { $o.SetValue([string]$value); return 'SetValue' }
      if ($el.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$o)) { $o.SetValue([double]$value); return 'RangeValue' }
      throw 'NOPATTERN: element is not editable'
    }
    default { throw "unknown action $action" }
  }
}

function Find-Named($scopeEl, [string]$name, $types) {
  $all = $scopeEl.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $want = ($name -replace '[&.…]', '').Trim().ToLower()
  $best = $null
  foreach ($e in $all) {
    try {
      $ct = $e.Current.ControlType.ProgrammaticName
      if ($types -and -not ($types | Where-Object { $ct -like "*$_" })) { continue }
      $n = ($e.Current.Name -replace '[&.…]', '' -replace '\t.*$', '').Trim().ToLower()
      if ($n -eq $want) { return $e }
      if (-not $best -and $n.StartsWith($want)) { $best = $e }
    } catch { }
  }
  return $best
}

# ------------------------------------------------------------------- OCR
$script:OcrReady = $false
function Init-Ocr {
  if ($script:OcrReady) { return }
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $script:AsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $script:OcrReady = $true
}
function Await($op, [Type]$type) {
  $t = $script:AsTask.MakeGenericMethod($type).Invoke($null, @($op))
  [void]$t.Wait(-1)
  return $t.Result
}
function Invoke-Ocr([string]$path) {
  Init-Ocr
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($engine -eq $null) { throw 'No OCR language pack installed' }
  $res = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = New-Object System.Collections.ArrayList
  foreach ($line in $res.Lines) {
    $words = New-Object System.Collections.ArrayList
    foreach ($w in $line.Words) { [void]$words.Add(@{ text = $w.Text; x = [int]$w.BoundingRect.X; y = [int]$w.BoundingRect.Y; width = [int]$w.BoundingRect.Width; height = [int]$w.BoundingRect.Height }) }
    [void]$lines.Add(@{ text = $line.Text; words = $words })
  }
  $stream.Dispose()
  return @{ lines = $lines }
}

# ------------------------------------------------------------------- ops
function Invoke-Op([string]$op, $a) {
  switch ($op) {
    'ping' { return @{ pong = $true; uia = $script:HasUia; ps = $PSVersionTable.PSVersion.ToString() } }
    'screens' {
      $list = New-Object System.Collections.ArrayList
      foreach ($s in [System.Windows.Forms.Screen]::AllScreens) { [void]$list.Add(@{ id = $s.DeviceName; primary = $s.Primary; x = $s.Bounds.X; y = $s.Bounds.Y; width = $s.Bounds.Width; height = $s.Bounds.Height; scale = 1 }) }
      return @{ screens = $list }
    }
    'capture' {
      $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size)
      $bmp.Save($a.path, [System.Drawing.Imaging.ImageFormat]::Png)
      $g.Dispose(); $bmp.Dispose()
      return @{ x = $vs.X; y = $vs.Y; width = $vs.Width; height = $vs.Height }
    }
    'windows' {
      $list = New-Object System.Collections.ArrayList
      foreach ($w in [CsNative]::Windows()) { $o = New-Win $w; $o.app = Get-ProcName $w.pid; [void]$list.Add($o) }
      return @{ windows = $list }
    }
    'dialogs' {
      $list = New-Object System.Collections.ArrayList
      foreach ($w in [CsNative]::DialogsOf([uint32]$a.pid)) { [void]$list.Add((New-Win $w)) }
      return @{ windows = $list }
    }
    'window_action' {
      $h = Get-Hwnd $a.id
      if (-not [CsNative]::IsWindow($h)) { throw 'NOTFOUND: window no longer exists' }
      switch ($a.action) {
        'focus' { $ok = [CsNative]::Focus($h); return @{ focused = $ok } }
        'minimize' { [void][CsNative]::ShowWindow($h, 6) }
        'maximize' { [void][CsNative]::ShowWindow($h, 3) }
        'restore' { [void][CsNative]::ShowWindow($h, 9); [void][CsNative]::Focus($h) }
        'close' { [void][CsNative]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
        { $_ -in 'move', 'resize' } {
          [void][CsNative]::ShowWindow($h, 9)
          $r = New-Object CsNative+RECT
          [void][CsNative]::GetWindowRect($h, [ref]$r)
          $x = if ($a.x -ne $null) { [int]$a.x } else { $r.Left }
          $y = if ($a.y -ne $null) { [int]$a.y } else { $r.Top }
          $w = if ($a.width -ne $null) { [int]$a.width } else { $r.Right - $r.Left }
          $hh = if ($a.height -ne $null) { [int]$a.height } else { $r.Bottom - $r.Top }
          [void][CsNative]::MoveWindow($h, $x, $y, $w, $hh, $true)
        }
        default { throw "unknown window action $($a.action)" }
      }
      return @{}
    }
    'mouse_move' { [void][CsNative]::SetCursorPos([int]$a.x, [int]$a.y); return @{} }
    'mouse_pos' { $p = New-Object CsNative+POINT; [void][CsNative]::GetCursorPos([ref]$p); return @{ x = $p.X; y = $p.Y } }
    'mouse_button' { [CsNative]::Button([string]$a.button, $a.state -eq 'down'); return @{} }
    'click' {
      if ($a.x -ne $null) { [void][CsNative]::SetCursorPos([int]$a.x, [int]$a.y); Start-Sleep -Milliseconds 20 }
      $n = if ($a.count) { [int]$a.count } else { 1 }
      for ($i = 0; $i -lt $n; $i++) { [CsNative]::Button([string]$a.button, $true); [CsNative]::Button([string]$a.button, $false); if ($i -lt $n - 1) { Start-Sleep -Milliseconds 40 } }
      return @{}
    }
    'scroll' {
      if ($a.x -ne $null) { [void][CsNative]::SetCursorPos([int]$a.x, [int]$a.y); Start-Sleep -Milliseconds 20 }
      [CsNative]::Wheel([int]$a.dy, [int]$a.dx); return @{}
    }
    'key' {
      $mods = [uint16[]]@($a.mods | ForEach-Object { [uint16]$_ })
      $vk = $a.key
      if ($vk -eq $null -and $a.char) {
        $scan = [CsNative]::VkKeyScan([char]([string]$a.char)[0])
        if ($scan -eq -1) { throw "Cannot map character '$($a.char)' to a key" }
        $vk = $scan -band 0xFF
        if ($scan -band 0x100) { $mods += [uint16]0x10 }
        if ($scan -band 0x200) { $mods += [uint16]0x11 }
        if ($scan -band 0x400) { $mods += [uint16]0x12 }
      }
      $rep = if ($a.repeat) { [int]$a.repeat } else { 1 }
      for ($i = 0; $i -lt $rep; $i++) { [CsNative]::Combo($mods, [uint16]$vk); if ($rep -gt 1) { Start-Sleep -Milliseconds 30 } }
      return @{}
    }
    'key_toggle' { if ($a.state -eq 'down') { [CsNative]::KeyDown([uint16]$a.key) } else { [CsNative]::KeyUp([uint16]$a.key) }; return @{} }
    'type' { [CsNative]::TypeText([string]$a.text, [int]$a.delay); return @{} }
    'clipboard_get' { return @{ text = [System.Windows.Forms.Clipboard]::GetText() } }
    'clipboard_set' { if ([string]$a.text -eq '') { [System.Windows.Forms.Clipboard]::Clear() } else { [System.Windows.Forms.Clipboard]::SetText([string]$a.text) }; return @{} }
    'list_apps' {
      $list = New-Object System.Collections.ArrayList
      try { foreach ($s in Get-StartApps) { [void]$list.Add(@{ name = $s.Name; appId = $s.AppID; source = 'start-menu' }) } } catch { }
      foreach ($root in 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths') {
        try {
          foreach ($k in Get-ChildItem $root -ErrorAction Stop) {
            $p = (Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue).'(default)'
            if ($p) { [void]$list.Add(@{ name = ($k.PSChildName -replace '\.exe$', ''); path = ($p.Trim('"')); source = 'app-paths' }) }
          }
        } catch { }
      }
      return @{ apps = $list }
    }
    'launch_appid' {
      Start-Process -FilePath 'explorer.exe' -ArgumentList ("shell:AppsFolder\" + $a.appId)
      return @{}
    }
    'uia_tree' {
      if (-not $script:HasUia) { throw 'UIA: UI Automation assemblies unavailable' }
      $budget = @{ n = if ($a.maxNodes) { [int]$a.maxNodes } else { 400 } }
      $root = [System.Windows.Automation.AutomationElement]::FromHandle((Get-Hwnd $a.hwnd))
      $node = Walk-Element $root $a.hwnd 0 ([int]$a.depth) $budget
      return @{ nodes = @($node); truncated = ($budget.n -le 0) }
    }
    'uia_find' {
      if (-not $script:HasUia) { throw 'UIA: UI Automation assemblies unavailable' }
      $root = [System.Windows.Automation.AutomationElement]::FromHandle((Get-Hwnd $a.hwnd))
      $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      $list = New-Object System.Collections.ArrayList
      $want = ([string]$a.name).ToLower(); $role = ([string]$a.role).ToLower()
      $limit = if ($a.limit) { [int]$a.limit } else { 20 }
      foreach ($e in $all) {
        if ($list.Count -ge $limit) { break }
        try {
          $c = $e.Current
          if ($c.IsOffscreen) { continue }
          $n = ([string]$c.Name).ToLower(); $t = ($c.ControlType.ProgrammaticName).ToLower()
          if ($want -and -not $n.Contains($want) -and -not ([string]$c.AutomationId).ToLower().Contains($want)) { continue }
          if ($role -and -not $t.Contains($role)) { continue }
          [void]$list.Add((Describe-Element $e $a.hwnd))
        } catch { }
      }
      return @{ nodes = $list }
    }
    'uia_action' {
      $el = Find-ByRuntimeId $a.hwnd $a.runtimeId
      $performed = Invoke-UiaAction $el ([string]$a.action) $a.value
      return @{ performed = $performed }
    }
    'menu_select' {
      $win = [System.Windows.Automation.AutomationElement]::FromHandle((Get-Hwnd $a.hwnd))
      [void][CsNative]::Focus((Get-Hwnd $a.hwnd))
      $names = @($a.path)
      for ($i = 0; $i -lt $names.Count; $i++) {
        $item = Find-Named $win $names[$i] @('MenuItem')
        if ($item -eq $null) {
          foreach ($top in [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
            try { if ($top.Current.ControlType.ProgrammaticName -like '*Menu' -or $top.Current.ClassName -eq '#32768') { $item = Find-Named $top $names[$i] @('MenuItem'); if ($item) { break } } } catch { }
          }
        }
        if ($item -eq $null) { throw "NOTFOUND: menu item '$($names[$i])'" }
        $o = $null
        if ($i -lt $names.Count - 1 -and $item.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$o)) { $o.Expand() }
        elseif ($item.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$o)) { $o.Invoke() }
        elseif ($item.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$o)) { $o.Expand() }
        else { throw "NOPATTERN: menu item '$($names[$i])' cannot be activated" }
        Start-Sleep -Milliseconds 250
      }
      return @{ method = 'uia' }
    }
    'ocr' { return (Invoke-Ocr ([string]$a.path)) }
    default { throw "unknown op $op" }
  }
}

# ------------------------------------------------------------------ loop
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $result = Invoke-Op ([string]$req.op) $req.args
    $resp = @{ id = $id; ok = $true; result = $result }
  } catch {
    $msg = $_.Exception.Message
    $code = 'failed'
    if ($msg -like 'NOTFOUND:*') { $code = 'notfound' } elseif ($msg -like 'NOPATTERN:*') { $code = 'nopattern' } elseif ($msg -like '*Access is denied*') { $code = 'permission' }
    $resp = @{ id = $id; ok = $false; error = $code; message = $msg }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $resp -Depth 40 -Compress))
  [Console]::Out.Flush()
}
