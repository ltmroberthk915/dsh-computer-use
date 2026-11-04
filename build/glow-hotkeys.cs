using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using DshComputerUse.Worker;

static class GlowHotkeys
{
    const BindingFlags Private = BindingFlags.NonPublic | BindingFlags.Static;
    static readonly MethodInfo Hook = typeof(Panic).GetMethod("HookCallback", Private);
    static readonly short[] keys = new short[256];
    static int red, cyan;
    internal static bool StagePreparation;
    public static void AwaitFirstPreparation()
    {
        // Make the first frame purple in shortcut cases. This exercises an
        // invalidated, visible preparation even on versions that hang during cyan.
        if (StagePreparation) Until(delegate { return Glow.Preparing; }, "private warning did not begin");
    }
    static readonly ManualResetEvent Purple = new ManualResetEvent(false);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool InvalidateRect(IntPtr hwnd, IntPtr rect, bool erase);
    [DllImport("user32.dll")] static extern bool SetThreadDesktop(IntPtr desktop);

    public static void Presented(int state, IntPtr bits, int w, int h)
    {
        if (state != 3 && state != 4 && state != 7) return;
        // Inspect an opaque rail pixel on the actual DIB accepted by Win32.
        int pixel = Marshal.ReadInt32(bits, (h / 2 * w) * 4);
        int r = (pixel >> 16) & 255, g = (pixel >> 8) & 255, b = pixel & 255;
        if (state == 7 && b > r && r > g) Purple.Set();
        if (state == 4 && r > g && r > b) Interlocked.Increment(ref red);
        if (state == 3 && g > 2 * r && b > 2 * r) Interlocked.Increment(ref cyan);
    }

    // Emulate async physical state plus Windows' consumed-on-read edge bit.
    public static short ReadKey(int vk)
    {
        lock (keys)
        {
            short value = keys[vk];
            keys[vk] = unchecked((short)(value & 0x8000));
            return value;
        }
    }

    static IntPtr Key(int vk, bool down, bool hook)
    {
        lock (keys) keys[vk] = down ? unchecked((short)0x8001) : (short)(keys[vk] & 1);
        if (!hook) return IntPtr.Zero;
        var packet = new Native.KBDLLHOOKSTRUCT { vkCode = (uint)vk };
        IntPtr memory = Marshal.AllocHGlobal(Marshal.SizeOf(packet));
        try
        {
            Marshal.StructureToPtr(packet, memory, false);
            return (IntPtr)Hook.Invoke(null, new object[] { 0, new IntPtr(down ? 0x100 : 0x101), memory });
        }
        finally { Marshal.FreeHGlobal(memory); }
    }

    static void Chord(int key, bool alt)
    {
        Key(0x11, true, true);
        if (alt) Key(0x12, true, true);
        IntPtr down = Key(key, true, true);
        IntPtr up = Key(key, false, true);
        if (alt) Key(0x12, false, true);
        Key(0x11, false, true);
        if (key == 0x1b && (down.ToInt64() != 1 || up.ToInt64() != 1))
            throw new Exception("Ctrl+Esc was not consumed");
    }

    static void Until(Func<bool> condition, string message)
    {
        var clock = Stopwatch.StartNew();
        while (!condition())
        {
            if (clock.ElapsedMilliseconds > 1600)
                throw new Exception(message + " (want=" + Glow.Want + ", visible=" +
                    IsWindowVisible(GlowPumpFixture.Target) + ", redFrames=" + red + ", stopped=" +
                    Panic.Stopped + ", exited=" + Panic.Exited + ", owner=" + Program.DesktopOwned + ")");
            Thread.Sleep(10);
        }
    }

    public static void Run(string scenario, IntPtr desktop, IntPtr hwnd, List<string> events)
    {
        bool pause = scenario == "resume" || scenario == "pause-exit";
        bool poll = scenario == "poll-exit";
        bool blocked = scenario == "queued-exit";
        string stop = Environment.GetEnvironmentVariable("DSH_COMPUTER_USE_STOP_FILE");
        string exit = Environment.GetEnvironmentVariable("DSH_COMPUTER_USE_EXIT_FILE");
        if (scenario == "hook-unavailable")
        {
            Exception failure = null;
            try { GlowPumpFixture.KeyRequest(1); }
            catch (TargetInvocationException e) { failure = e.InnerException; }
            if (failure == null || (string)failure.Data["code"] != "CONTROL_HOOK_UNAVAILABLE" ||
                (string)failure.Data["outcome"] != "not-dispatched" ||
                Purple.WaitOne(0) || events.Count != 0)
                throw new Exception("missing hooks did not refuse input before showing preparation: " +
                    (failure == null ? "accepted" : failure.Message));
            Console.WriteLine("ok unavailable control hook refused before purple with zero input: " + failure.Message);
            return;
        }
        Exception driverError = null;
        var requestDone = new ManualResetEvent(false);
        var driver = new Thread(delegate() {
            try
            {
                if (!SetThreadDesktop(desktop)) throw new Exception("cannot select private control desktop");
                if (!Purple.WaitOne(4800)) throw new Exception("first purple frame never presented");
                if (!Panic.ControlListenersEnabled || !Panic.CycleLit || !Program.DesktopOwned)
                    throw new Exception("purple frame presented without controls: listeners=" + Panic.ControlListenersEnabled +
                        ", cycle=" + Panic.CycleLit + ", owner=" + Program.DesktopOwned);
                if (!InvalidateRect(hwnd, IntPtr.Zero, false)) throw new Exception("cannot invalidate purple overlay");
                if (blocked)
                {
                    var holding = new ManualResetEvent(false);
                    var release = new ManualResetEvent(false);
                    try
                    {
                        Panic.QueueControl(delegate { holding.Set(); release.WaitOne(3000); });
                        if (!holding.WaitOne(1000)) throw new Exception("could not hold control queue");
                        Chord(0x51, true);
                        if (!requestDone.WaitOne(750))
                            throw new Exception("Q did not interrupt before the blocked control queue was released");
                    }
                    finally { release.Set(); }
                }
                else if (pause) Chord(0x1b, false);
                else if (!poll) Chord(0x51, true);
                else
                {
                    // Only the modifiers reach HookCallback. The Q key-down is missed.
                    // PollThread must detect the async edge and report exitSource=poll.
                    var poller = new Thread(delegate() {
                        if (SetThreadDesktop(desktop)) typeof(Panic).GetMethod("PollThread", Private).Invoke(null, null);
                    });
                    poller.IsBackground = true; poller.Start();
                    Thread.Sleep(220);
                    Key(0x11, true, true); Key(0x12, true, true); Key(0x51, true, false);
                    Until(delegate { return Panic.Exited; }, "poll failed to exit");
                    Key(0x51, false, false); Key(0x12, false, true); Key(0x11, false, true);
                }
            }
            catch (Exception error) { driverError = error.GetBaseException(); }
        });
        driver.IsBackground = true; driver.Start();

        Exception refused = null;
        try { GlowPumpFixture.KeyRequest(1); }
        catch (TargetInvocationException error) { refused = error.InnerException; }
        finally { requestDone.Set(); }
        if (!driver.Join(5500)) throw new Exception("shortcut hook thread blocked");
        if (driverError != null) throw driverError;
        if (refused == null || events.Count != 0 ||
            !(pause ? refused.Message.Contains("ABORTED") : refused.Message.Contains("CYCLE-ENDED")))
            throw new Exception("shortcut did not interrupt preparation before dispatch: " +
                (refused == null ? "accepted" : refused.Message) + "; sent=" + events.Count);
        if (pause)
        {
            Until(delegate { return Panic.Stopped && File.Exists(stop) && Volatile.Read(ref red) > 0 && Glow.Want == 4 &&
                IsWindowVisible(hwnd); }, "pause did not display red and persist STOP");
            if (scenario == "resume")
            {
                int previousCyan = Volatile.Read(ref cyan);
                Chord(0x52, true);
                Until(delegate { return !Panic.Stopped && !File.Exists(stop); }, "resume left STOP active");
                bool resumedCyan = true;
                try { Until(delegate { return Volatile.Read(ref cyan) > previousCyan && Glow.Want == 3; },
                    "resume did not restore monitoring"); }
                catch { resumedCyan = false; }
                GlowPumpFixture.ResetPresentationClock();
                GlowPumpFixture.KeyRequest(2);
                if (String.Join(",", events) != "down,up") throw new Exception("retry after R failed");
                if (!resumedCyan) throw new Exception("R cleared STOP and retry dispatched down/up, but monitoring did not repaint cyan");
                Console.WriteLine("ok Ctrl+Esc cancelled before input, red visible, Ctrl+Alt+R restored cyan, fresh request sent down/up");
                return;
            }
            Chord(0x51, true);
        }
        Until(delegate { return Panic.Exited && !Panic.CycleLit && !Panic.Armed && !Program.DesktopOwned &&
            File.Exists(exit) && !File.Exists(stop) && Glow.Want == 0 && !IsWindowVisible(hwnd); },
            "exit did not hide the overlay and release ownership");
        string expected = poll ? "poll" : "hook";
        if (Panic.ExitSource != expected || events.Count != 0) throw new Exception("unexpected exit origin or input");
        Console.WriteLine("ok " + scenario + ": purple" + (pause ? " -> red" : "") +
            " -> hidden; source=" + expected + "; EXITED; lease released; zero key events");
    }
}
