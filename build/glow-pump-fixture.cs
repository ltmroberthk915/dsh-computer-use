using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using DshComputerUse.Worker;

static class GlowPumpFixture
{
    const BindingFlags Flags = BindingFlags.NonPublic | BindingFlags.Static;
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, uint flags, uint access, IntPtr security);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)] static extern bool InvalidateRect(IntPtr hwnd, IntPtr rect, bool erase);
    [DllImport("user32.dll")] static extern bool GetUpdateRect(IntPtr hwnd, IntPtr rect, bool erase);

    static int frames, lastBarHash, changedFrames;
    static bool signedRequest;
    static long firstPresentation, lastPurplePresentation, firstDown, lastUp;
    internal static void ResetPresentationClock()
    { Interlocked.Exchange(ref firstPresentation, 0); Interlocked.Exchange(ref lastPurplePresentation, 0); firstDown = lastUp = 0; }
    static long Ms(long ticks) { return ticks * 1000 / Stopwatch.Frequency; }
    public static IntPtr Target;
    static readonly MethodInfo Display = typeof(Glow).GetMethod("OverlayDisplay", Flags);

    // The test build taps the result of the real UpdateLayeredWindow. Its return
    // value is passed through unchanged, including failures. Sample only the bar
    // inside the exact presented DIB, since the private desktop is never shown.
    public static bool SamplePresentedFrame(bool success, int state, IntPtr bits, int w, int h)
    {
        if (success) GlowHotkeys.Presented(state, bits, w, h);
        if (!success || state != 7) return success;
        GlowFailures.RecordPurpleFrame();
        Interlocked.CompareExchange(ref firstPresentation, Stopwatch.GetTimestamp(), 0);
        Interlocked.Exchange(ref lastPurplePresentation, Stopwatch.GetTimestamp());
        Rectangle display = (Rectangle)Display.Invoke(null, new object[] { w, h });
        float scale = Math.Max(1f, Math.Min(1.25f, display.Width / 1920f));
        float cardWidth = Math.Min(408 * scale, display.Width - 24);
        float left = display.Left + (display.Width - cardWidth) / 2 + 48 * scale;
        int y = (int)(display.Top + 67 * scale);
        int hash = 17;
        for (int x = (int)left + 1; x < left + cardWidth - 64 * scale; x += 8)
            hash = unchecked(hash * 31 + Marshal.ReadInt32(bits, (y * w + x) * 4));
        if (frames > 0 && hash != lastBarHash) Interlocked.Increment(ref changedFrames);
        lastBarHash = hash;
        Interlocked.Increment(ref frames);
        return success;
    }

    static void RequireWin32(bool success, string operation)
    {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    internal static void KeyRequest(int id)
    {
        var args = Program.Dict("combo", "a", "expectHwnd", Target.ToInt64(), "__inputSeries", "private-desktop-test-" + id);
        if (signedRequest) args["__cycle"] = true;
        var response = Request(id, "key", args);
        if (!(bool)response["ok"]) throw new Exception("key request refused");
    }

    internal static Dictionary<string, object> Request(int id, string op, Dictionary<string, object> args)
    {
        var request = Program.Dict("id", id, "op", op, "args", args);
        return (Dictionary<string, object>)typeof(Program).GetMethod("Handle", Flags).Invoke(
            null, new object[] { new JavaScriptSerializer().Serialize(request) });
    }

    static void Run(string scenario)
    {
        // No SwitchDesktop or input hooks. Both the caller and the real render loop run
        // on a newly created, undisplayed desktop. Process exit releases all its handles.
        IntPtr desktop = CreateDesktop("dsh-glow-test-" + Guid.NewGuid().ToString("N"),
            IntPtr.Zero, IntPtr.Zero, 0, 0x01ff, IntPtr.Zero);
        RequireWin32(desktop != IntPtr.Zero, "create private desktop");
        RequireWin32(SetThreadDesktop(desktop), "select private desktop for test thread");
        signedRequest = !scenario.StartsWith("unsigned-", StringComparison.Ordinal);
        bool normal = scenario == "normal" || scenario == "unsigned-normal";
        bool boundary = scenario == "dry-run" || scenario == "one-shot-drain";
        bool presentFault = scenario == "present-recovery" || scenario == "present-timeout" ||
            scenario == "present-stall" || scenario == "render-freeze";
        GlowFailures.Mode = presentFault ? scenario : null;
        GlowHotkeys.StagePreparation = !normal && !boundary && !presentFault && scenario != "hook-unavailable" && scenario != "pointer" && scenario != "capture";
        var hooksReady = typeof(Panic).GetField("_hooksReady", Flags);
        if (hooksReady != null)
        {
            hooksReady.SetValue(null, scenario != "hook-unavailable" && scenario != "dry-run");
            ((EventWaitHandle)typeof(Panic).GetField("_hooksInitialized", Flags).GetValue(null)).Set();
        }
        Exception renderError = null;
        var renderer = new Thread(delegate() {
            try
            {
                RequireWin32(SetThreadDesktop(desktop), "select private desktop for render thread");
                typeof(Glow).GetMethod("Run", Flags).Invoke(null, null);
            }
            catch (Exception error) { renderError = error.GetBaseException(); }
        });
        renderer.IsBackground = true;
        typeof(Glow).GetField("_thread", Flags).SetValue(null, renderer);
        if (normal) Glow.Thinking(0);
        renderer.Start();
        var clock = Stopwatch.StartNew();
        var hwndField = typeof(Glow).GetField("_hwnd", Flags);
        IntPtr hwnd;
        do
        {
            hwnd = (IntPtr)hwndField.GetValue(null);
            if (!renderer.IsAlive || clock.ElapsedMilliseconds >= 5000)
                throw new Exception("private overlay did not appear", renderError);
            Thread.Sleep(10);
        } while (hwnd == IntPtr.Zero || (normal && !IsWindowVisible(hwnd)));

        // A removed but undispatched WM_PAINT regenerates while the update region is invalid.
        if (normal) RequireWin32(InvalidateRect(hwnd, IntPtr.Zero, false), "invalidate private overlay");
        Target = hwnd;
        if (presentFault) Target = GlowFailures.CreateStableTarget();
        var events = new List<string>();
        Program.InputSender = delegate(INPUT[] inputs) {
            foreach (INPUT input in inputs)
            {
                long presented = Interlocked.Read(ref firstPresentation);
                if (input.type != Native.INPUT_KEYBOARD || input.u.ki.wVk != 0x41 ||
                    !Glow.Acting || Glow.Preparing || !Panic.ControlListenersEnabled || !Panic.CycleLit ||
                    !Program.DesktopOwned || presented == 0 ||
                    (Stopwatch.GetTimestamp() - presented) * 1000 / Stopwatch.Frequency < Glow.PreparationMs)
                    throw new Exception("unexpected input or premature dispatch");
                bool down = (input.u.ki.dwFlags & Native.KEYEVENTF_KEYUP) == 0;
                if (down) firstDown = Stopwatch.GetTimestamp(); else lastUp = Stopwatch.GetTimestamp();
                events.Add(down ? "down" : "up");
            }
            return (uint)inputs.Length;
        };
        clock.Restart();
        TimeSpan cpuStart = Process.GetCurrentProcess().TotalProcessorTime;
        if (scenario == "pointer") { GlowPointer.Run(); return; }
        if (scenario == "capture") { GlowCapture.Run(); return; }
        if (presentFault)
        {
            GlowFailures.Run(events);
            return;
        }
        if (boundary)
        {
            if (scenario == "dry-run") GlowBoundaries.DryRuns(hwnd);
            else GlowBoundaries.OneShotDrain();
            if (Volatile.Read(ref frames) != 0 || events.Count != 0)
                throw new Exception("unexpected purple frame or dispatched input in boundary test");
            return;
        }
        if (!normal)
        {
            GlowHotkeys.Run(scenario, desktop, hwnd, events);
            return;
        }
        try
        {
            KeyRequest(1);
        }
        catch (TargetInvocationException error)
        {
            throw new Exception(error.InnerException.Message + " (updatePending=" +
                GetUpdateRect(hwnd, IntPtr.Zero, false) + ", elapsedMs=" + clock.ElapsedMilliseconds +
                ", processCpuMs=" + (long)(Process.GetCurrentProcess().TotalProcessorTime - cpuStart).TotalMilliseconds +
                ")", error.InnerException);
        }
        if (clock.ElapsedMilliseconds < Glow.PreparationMs || Glow.Preparing || Glow.Acting ||
            GetUpdateRect(hwnd, IntPtr.Zero, false))
            throw new Exception("expected full warning, validated window and a closed input scope");
        if (Volatile.Read(ref changedFrames) == 0)
            throw new Exception("progress bar pixels never changed across " + frames + " presented frames");
        if (String.Join(",", events) != "down,up")
            throw new Exception("expected exactly one balanced key stroke at the input boundary");
        if (!signedRequest && (Panic.CycleLit || Panic.ControlListenersEnabled || Program.DesktopOwned))
            throw new Exception("unsigned call retained its private cycle, listeners or desktop lease");
        if (signedRequest)
        {
            if (!Glow.Holding || Glow.DeriveWant(true, 3) != 8)
                throw new Exception("completed input failed to preserve the scene ahead of screenshot flash");
            long firstMs = clock.ElapsedMilliseconds;
            ResetPresentationClock(); events.Clear(); clock.Restart();
            long repeatStarted = Stopwatch.GetTimestamp();
            KeyRequest(2);
            long repeatEnded = Stopwatch.GetTimestamp();
            Console.WriteLine("timing repeat: firstFrameWaitMs=" + Ms(firstPresentation - repeatStarted) +
                "; presentedCountdownMs=" + Ms(lastPurplePresentation - firstPresentation) +
                "; frameToKeyMs=" + Ms(firstDown - lastPurplePresentation) +
                "; keyHoldMs=" + Ms(lastUp - firstDown) + "; postKeyMs=" + Ms(repeatEnded - lastUp));
            if (Glow.PreparationMs != 100 || clock.ElapsedMilliseconds < 100 || clock.ElapsedMilliseconds >= 1000 ||
                String.Join(",", events) != "down,up")
                throw new Exception("repeat warning failed the presented 100ms input boundary");
            Request(3, "indicator", Program.Dict("hold", false));
            if (Glow.Holding || Glow.DeriveWant(false, 3) != 3 || !Panic.CycleLit)
                throw new Exception("free did not relinquish scene while retaining cycle");
            Console.WriteLine("ok adaptive warning: first=" + firstMs + "ms, repeated=" + clock.ElapsedMilliseconds +
                "ms; real progress presents gate both inputs; holding then free preserves cycle");
        }
        Console.WriteLine("ok " + scenario + ": private overlay and keyboard request completed in " +
            clock.ElapsedMilliseconds + " ms; progress changed on " + changedFrames + "/" + frames +
            " presented frames; in-memory key down/up; processCpuMs=" +
            (long)(Process.GetCurrentProcess().TotalProcessorTime - cpuStart).TotalMilliseconds);
    }

    static int Main(string[] args)
    {
        try { Run(args[0]); return 0; }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}
