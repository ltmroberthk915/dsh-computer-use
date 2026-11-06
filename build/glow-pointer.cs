using System;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using DshComputerUse.Worker;

static class GlowPointer
{
    const BindingFlags Flags = BindingFlags.Static | BindingFlags.NonPublic;
    public static bool SyntheticCursor;
    public static int CursorX = 300, CursorY = 300;
    public static int HideRequests, RestoreRequests, NativeInputCalls, GuardianAttempts, NativeVisibilityCalls;
    public static volatile bool ReplacementActive, ThrowSurface, FailPresent;
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    static IntPtr Pointer { get { return (IntPtr)typeof(AgentPointer).GetField("window", Flags).GetValue(null); } }
    static void Check(bool ok, string reason) { if (!ok) throw new Exception(reason); }
    // Test-only replacement backend. It never calls Magnification or starts a helper.
    // The production AgentPointer still creates/presents/positions its real surface.
    public static bool RequestReplacement(bool show)
    {
        if (show)
        {
            Check(Pointer != IntPtr.Zero && IsWindowVisible(Pointer), "hide requested before a visible replacement surface");
            Interlocked.Increment(ref HideRequests); ReplacementActive = true; return true;
        }
        Interlocked.Increment(ref RestoreRequests); ReplacementActive = false; return false;
    }
    public static void BeforeSurface()
    {
        if (ThrowSurface) throw new InvalidOperationException("fixture surface allocation failure");
    }
    public static IntPtr PresentHwnd(IntPtr hwnd) { return FailPresent ? IntPtr.Zero : hwnd; }
    public static void ForbidGuardian()
    { Interlocked.Increment(ref GuardianAttempts); throw new InvalidOperationException("guardian startup forbidden in private-desktop fixture"); }
    public static void ForbidMag()
    { Interlocked.Increment(ref NativeVisibilityCalls); throw new InvalidOperationException("native visibility API forbidden in private-desktop fixture"); }
    static void CheckIsolation()
    {
        Check(Volatile.Read(ref NativeInputCalls) == 0, "pointer attempted native input");
        Check(Volatile.Read(ref GuardianAttempts) == 0, "pointer attempted guardian startup");
        Check(Volatile.Read(ref NativeVisibilityCalls) == 0, "pointer attempted native visibility API");
    }
    static void Wait(bool visible)
    {
        var watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < 3000)
        {
            IntPtr p = Pointer;
            if ((p != IntPtr.Zero && IsWindowVisible(p)) == visible && ReplacementActive == visible) return;
            if (AgentPointer.Fault != null) throw new Exception("pointer: " + AgentPointer.Fault);
            Thread.Sleep(10);
        }
        throw new Exception("pointer visibility timeout: expected=" + visible);
    }
    public static void Run()
    {
        // Native visibility is always fake. Window creation, painting, styles,
        // foreground and hit tests still use Win32 on the undisplayed desktop.
        SyntheticCursor = true;
        IntPtr foreground = GetForegroundWindow();
        string failure = Environment.GetEnvironmentVariable("DSH_CU_POINTER_FAILURE") ?? "";
        ThrowSurface = failure == "surface"; FailPresent = failure == "present";
        int restoreBefore = Volatile.Read(ref RestoreRequests);
        Panic.CycleLit = true; Panic.Arm(); SceneControl.SetHolding(true); Glow.Reveal();
        if (failure.Length > 0)
        {
            var failedClock = Stopwatch.StartNew();
            while (AgentPointer.Fault == null && failedClock.ElapsedMilliseconds < 3000) Thread.Sleep(10);
            Check(AgentPointer.Fault != null, "injected surface failure was not observed");
            Wait(false);
            Check(Volatile.Read(ref HideRequests) == 0, "failed surface hid native cursor");
            Check(Volatile.Read(ref RestoreRequests) > restoreBefore, "failure cleanup omitted restore request");
            Check(GetForegroundWindow() == foreground, "failed pointer stole foreground");
            CheckIsolation();
            SceneControl.Reset(); Panic.TryEndCycle();
            Console.WriteLine("ok pointer-" + failure + ": real surface failure observed; zero hide requests, restore requested, no input or foreground change; fake visibility backend only");
            return;
        }
        Wait(true);
        IntPtr pointer = Pointer;
        long style = GetWindowLong(pointer, -16).ToInt64(), ex = GetWindowLong(pointer, -20).ToInt64();
        Check((style & 0x08000000) != 0, "replacement must be disabled for input");
        Check((ex & 0x08080020) == 0x08080020, "layered/transparent/noactivate flags missing");
        Check(GetForegroundWindow() == foreground, "showing pointer stole foreground");
        Rect rect; Check(GetWindowRect(pointer, out rect), "pointer rect unavailable");
        float scale = (float)typeof(AgentPointer).GetField("scale", Flags).GetValue(null);
        System.Drawing.Point hotspot = KitePointerPainter.Hotspot(scale);
        Check(rect.Left + hotspot.X == CursorX && rect.Top + hotspot.Y == CursorY, "surface hotspot is not the cursor position");
        Check(rect.Right - rect.Left == (int)Math.Ceiling(39 * scale) && rect.Bottom - rect.Top == (int)Math.Ceiling(44 * scale), "replacement canvas DPI dimensions differ");
        Point hit = new Point { X = (rect.Left + rect.Right) / 2, Y = (rect.Top + rect.Bottom) / 2 };
        IntPtr targetWithPointer = WindowFromPoint(hit);
        Check(targetWithPointer != pointer, "pointer intercepted WindowFromPoint");
        restoreBefore = Volatile.Read(ref RestoreRequests);
        SceneControl.SetHolding(false); Wait(false);
        Check(Volatile.Read(ref RestoreRequests) > restoreBefore, "free omitted native restore request");
        Check(WindowFromPoint(hit) == targetWithPointer, "pointer changed hit-test result at its opaque center");
        Check(GetForegroundWindow() == foreground, "free changed foreground");
        SceneControl.SetHolding(true); Wait(true);
        restoreBefore = Volatile.Read(ref RestoreRequests);
        Glow.Stopped(true); Wait(false);
        Check(Volatile.Read(ref RestoreRequests) > restoreBefore, "pause omitted native restore request");
        Check(Glow.Holding, "renderer pause changed scene authority");
        Glow.Stopped(false); SceneControl.BeginActuation(); Glow.ActuationBegin(); Wait(true);
        SceneControl.EndActuation(); Glow.ActuationEnd(); Check(Glow.Holding, "input end lost scene hold");
        restoreBefore = Volatile.Read(ref RestoreRequests);
        Glow.Kill(); Wait(false);
        Check(Volatile.Read(ref RestoreRequests) > restoreBefore, "kill omitted native restore request");
        Check(Glow.Holding && !Glow.Acting, "renderer kill changed scene authority");
        Thread.Sleep(80); Check(!IsWindowVisible(Pointer), "hidden renderer resurrected retained scene");
        SceneControl.Reset(); Check(!Glow.Holding, "domain lifecycle failed to release scene");
        Check(GetForegroundWindow() == foreground, "pointer lifecycle changed foreground");
        CheckIsolation();
        Panic.TryEndCycle();
        Console.WriteLine("ok pointer: real private-desktop surface uses fixed hotspot/DPI size; holding/acting request hide only after visible paint; free/pause/kill request restore; no foreground/hit-test/input change; visibility API and guardian are not exercised");
    }
}

static class GlowCapture
{
    public static void Run()
    {
        foreach (int maxWidth in new int[] { 128, 1280 })
        {
            var response = GlowPumpFixture.Request(120 + maxWidth, "capture", Program.Dict(
                "x", 17, "y", 23, "width", 256, "height", 161, "maxWidth", maxWidth,
                "format", "png", "wait", "none", "cursor", true, "flash", false, "__kickoff", false));
            if (!(bool)response["ok"]) throw new Exception("private capture refused");
            var data = (System.Collections.Generic.Dictionary<string, object>)response["data"];
            int expectedWidth = Math.Min(256, maxWidth), expectedHeight = (int)Math.Round(161.0 * expectedWidth / 256);
            int[] size = (int[])data["imageSize"];
            using (var bytes = new System.IO.MemoryStream(Convert.FromBase64String((string)data["image"])))
            using (var bitmap = new System.Drawing.Bitmap(bytes))
                if (bitmap.Width != expectedWidth || bitmap.Height != expectedHeight ||
                    size[0] != bitmap.Width || size[1] != bitmap.Height || (int)data["scaledTo"] != bitmap.Width)
                    throw new Exception("actual PNG dimensions disagree with image metadata");
            if ((long)data["capturedAt"] > (long)data["ts"] || (long)data["ts"] - (long)data["capturedAt"] > 3000)
                throw new Exception("capture timestamp not bounded by response encoding timestamp");
            var screen = (System.Collections.Generic.Dictionary<string, object>)data["cursorScreenPos"];
            var image = (System.Collections.Generic.Dictionary<string, object>)data["cursorInImage"];
            double expectedX = (Convert.ToDouble(screen["x"]) - 17) * expectedWidth / 256;
            double expectedY = (Convert.ToDouble(screen["y"]) - 23) * expectedHeight / 161;
            if (Math.Abs(Convert.ToDouble(image["x"]) - expectedX) > 0.0001 || Math.Abs(Convert.ToDouble(image["y"]) - expectedY) > 0.0001)
                throw new Exception("cursor image point did not use actual per-axis downscale");
        }
        Panic.TryEndCycle(); Program.ReleaseDesktopOwnership();
        Console.WriteLine("ok capture: real undisplayed-desktop PNG 256x161 -> 128x80 and no-upscale 256x161; decoded sizes/scaledTo/timestamps/per-axis cursor mapping agree; flash disabled; zero user-desktop capture");
    }
}
