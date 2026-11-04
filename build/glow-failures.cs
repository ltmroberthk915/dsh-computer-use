using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using DshComputerUse.Worker;

static class GlowFailures
{
    const BindingFlags Private = BindingFlags.NonPublic | BindingFlags.Static;
    static readonly FieldInfo Serial = typeof(Glow).GetField("_preparationSerial", Private);
    static readonly Dictionary<int, HashSet<IntPtr>> surfaces = new Dictionary<int, HashSet<IntPtr>>();
    static long firstVisible;
    static int purpleFrames;
    static readonly ManualResetEvent frozen = new ManualResetEvent(false);
    static readonly ManualResetEvent thaw = new ManualResetEvent(false);
    public static string Mode;

    public static void RecordPurpleFrame()
    {
        if (Mode == null) return;
        Interlocked.CompareExchange(ref firstVisible, Stopwatch.GetTimestamp(), 0);
        Interlocked.Increment(ref purpleFrames);
    }

    public static void BeforePresent(int want)
    {
        if (Mode != "render-freeze" || want != 7) return;
        frozen.Set();
        thaw.WaitOne(10000);
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateWindowEx(int ex, string cls, string name, int style, int x, int y, int w, int h,
        IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);

    public static IntPtr CreateStableTarget()
    {
        // Keep the input target separate from the overlay HWND that the production
        // renderer will destroy and recreate. This private window is never shown.
        IntPtr hwnd = CreateWindowEx(0, "STATIC", "fixture input target", unchecked((int)0x80000000),
            0, 0, 10, 10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (hwnd == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        return hwnd;
    }

    public static IntPtr PresentHwnd(IntPtr hwnd, int want)
    {
        if (Mode == null || want != 7) return hwnd;
        int serial = (int)Serial.GetValue(null);
        lock (surfaces)
        {
            HashSet<IntPtr> windows;
            if (!surfaces.TryGetValue(serial, out windows))
                surfaces[serial] = windows = new HashSet<IntPtr>();
            windows.Add(hwnd);
            // Invoke the real Win32 API with an invalid HWND. Its return value and
            // last error reach the production handler without any simulated errno.
            if (Mode == "present-stall") return Volatile.Read(ref purpleFrames) == 0 ? hwnd : new IntPtr(-1);
            if (Mode == "present-timeout" || windows.Count == 1) return new IntPtr(-1);
        }
        return hwnd;
    }

    static void Check(bool ok, string message) { if (!ok) throw new Exception(message); }

    static Dictionary<string, object> Inspect(string op)
    {
        var result = GlowPumpFixture.Request(100, op, Program.Dict("what", "glow"));
        var data = (Dictionary<string, object>)result["data"];
        return (Dictionary<string, object>)data["glowHealth"];
    }

    static void Verify(Dictionary<string, object> health, int serial, bool recovered)
    {
        foreach (string field in new string[] { "stage", "fault", "want", "loopAgeMs", "lastSuccessAgeMs",
            "lastAttemptWant", "lastAttemptSerial", "presentSuccesses" })
            Check(health.ContainsKey(field), "missing renderer health field " + field);
        Check((int)health["workerPid"] == Process.GetCurrentProcess().Id && (bool)health["threadAlive"],
            "health does not describe the live private renderer");
        Check((int)health["lastWin32Error"] == 1400 && (int)health["lastFailedSerial"] == serial &&
            (int)health["rebuiltSerial"] == serial && (int)health["preparationSerial"] == serial,
            "real invalid HWND error or one-rebuild serial is missing");
        Check((int)health["presentAttempts"] >= 2 &&
            ((int)health["presentedSerial"] == serial) == recovered, "incorrect presentation acknowledgement");
        if (health.ContainsKey("completedSerial"))
            Check(((int)health["completedSerial"] == serial) == recovered, "incorrect completion acknowledgement");
        if (!recovered) Check((int)health["lastAttemptWant"] == 7 && (int)health["lastAttemptSerial"] == serial,
            "failure snapshot did not identify the waiting purple generation");
        lock (surfaces)
            Check(surfaces[serial].Count == 2, "expected exactly one native window rebuild for this request");
        var matching = File.ReadAllLines(Environment.GetEnvironmentVariable("DSH_COMPUTER_USE_AUDIT_LOG"))
            .Where(line => line.Contains("\tGLOW-PRESENT-FAILED\tserial=" + serial + ";")).ToArray();
        Check(matching.Length == 1 && matching[0].Contains("win32=1400"), "presentation audit must occur once per request");
    }

    public static void Run(List<string> events)
    {
        if (Mode == "present-recovery")
        {
            GlowPumpFixture.KeyRequest(1);
            Verify(Inspect("ping"), 1, true);
            Verify(Inspect("probe"), 1, true);
            Check(String.Join(",", events) == "down,up", "recovered warning must allow exactly one balanced key");
            Console.WriteLine("ok invalid HWND returned Win32 1400; one rebuild, real purple frame, full warning, down/up, one audit");
            return;
        }

        MethodInfo serializeError = typeof(Program).GetMethod("Err", Private, null, new Type[] { typeof(Exception) }, null);
        if (Mode == "render-freeze")
        {
            try
            {
                Exception failure = null;
                try { GlowPumpFixture.KeyRequest(1); }
                catch (TargetInvocationException e) { failure = e.InnerException; }
                Check(frozen.WaitOne(0) && failure != null && events.Count == 0, "frozen renderer dispatched input or never blocked");
                var reply = (Dictionary<string, object>)serializeError.Invoke(null, new object[] { failure });
                var health = (Dictionary<string, object>)reply["glowHealth"];
                Check((string)reply["code"] == "PREPARATION_UNAVAILABLE" && (string)reply["outcome"] == "not-dispatched" &&
                    (string)health["failurePhase"] == "first-frame" && (bool)health["threadAlive"] &&
                    (int)health["lastAttemptedPreparationSerial"] != (int)health["preparationSerial"] &&
                    health["lastWin32Error"] == null && Convert.ToInt64(health["loopAgeMs"]) >= 4500,
                    "health did not distinguish a stalled thread from a failed Win32 call");
                string audit = Environment.GetEnvironmentVariable("DSH_COMPUTER_USE_AUDIT_LOG");
                Check(!File.Exists(audit) || !File.ReadAllText(audit).Contains("\tGLOW-PRESENT-FAILED\t"),
                    "reported a Win32 failure when the call was never attempted");
                Console.WriteLine("ok frozen live renderer: no attempt for serial " + health["preparationSerial"] +
                    ", no Win32 error, loop age " + health["loopAgeMs"] + "ms, zero input");
            }
            finally { thaw.Set(); }
            return;
        }
        if (Mode == "present-stall")
        {
            Exception refused = null;
            try { GlowPumpFixture.KeyRequest(1); }
            catch (TargetInvocationException error) { refused = error.InnerException; }
            Check(refused != null && events.Count == 0, "initial purple frame froze but input was dispatched: " + events.Count);
            var response = (Dictionary<string, object>)serializeError.Invoke(null, new object[] { refused });
            var health = (Dictionary<string, object>)response["glowHealth"];
            long elapsed = (Stopwatch.GetTimestamp() - Interlocked.Read(ref firstVisible)) * 1000 / Stopwatch.Frequency;
            Check((bool)response["ok"] == false && (string)response["code"] == "PREPARATION_UNAVAILABLE" &&
                (string)response["outcome"] == "not-dispatched" && (string)health["failurePhase"] == "countdown-frame",
                "missing structured countdown refusal");
            Check(Volatile.Read(ref purpleFrames) == 1 && (int)health["preparationSerial"] == 1 &&
                (int)health["presentedSerial"] == 1 && (int)health["completedSerial"] != 1 &&
                (int)health["lastFailedSerial"] == 1 && (int)health["lastWin32Error"] == 1400 &&
                elapsed >= 5000 && elapsed < 7500, "incorrect timeout or acknowledgement after first visible frame");
            Console.WriteLine("ok first purple frame succeeded, all later presents returned Win32 1400, countdown-frame refused after " +
                elapsed + "ms; no completion acknowledgement or input");
            return;
        }
        for (int id = 1; id <= 2; id++)
        {
            var stopwatch = Stopwatch.StartNew();
            Exception refused = null;
            try { GlowPumpFixture.KeyRequest(id); }
            catch (TargetInvocationException error) { refused = error.InnerException; }
            Check(refused != null, "input was accepted with no visible preparation");
            var result = (Dictionary<string, object>)serializeError.Invoke(null, new object[] { refused });
            Check((bool)result["ok"] == false && (string)result["code"] == "PREPARATION_UNAVAILABLE" &&
                (string)result["outcome"] == "not-dispatched" && events.Count == 0, "wrong refusal or input outcome");
            Check(stopwatch.ElapsedMilliseconds >= 5000 && stopwatch.ElapsedMilliseconds < 7500, "unbounded preparation wait");
            var health = (Dictionary<string, object>)result["glowHealth"];
            Check((string)health["failurePhase"] == "first-frame", "missing structured first-frame refusal");
            Verify(health, id, false);
            Console.WriteLine("ok request " + id + " failed closed after " + stopwatch.ElapsedMilliseconds +
                "ms; Win32 1400, one rebuild, one audit, zero key events");
        }
    }
}
