using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using DshComputerUse.Worker;

static class PreparationFixture
{
    const BindingFlags Flags = BindingFlags.Static | BindingFlags.NonPublic;
    static readonly List<string> cases = new List<string>();
    static object Get(Type t, string name) { return t.GetField(name, Flags).GetValue(null); }
    static void Set(Type t, string name, object value) { t.GetField(name, Flags).SetValue(null, value); }
    static void Check(bool ok, string label) { if (!ok) throw new Exception(label); }
    static void Invoke(string name, params object[] args)
    {
        try { typeof(Program).GetMethod(name, Flags).Invoke(null, args); }
        catch (TargetInvocationException error) { throw error.InnerException; }
    }
    static Dictionary<string, object> Request(string series)
    { return Program.Dict("args", Program.Dict("__inputSeries", series)); }
    static Thread Present(int delay, Action after)
    {
        var thread = new Thread(delegate() {
            var timeout = Stopwatch.StartNew();
            while (!Glow.Preparing && timeout.ElapsedMilliseconds < 5000) Thread.Sleep(1);
            Thread.Sleep(delay);
            Glow.PreparationPresented((int)Get(typeof(Glow), "_preparationSerial"));
            // The logic fixture stubs both renderer acknowledgements. The private
            // desktop guard exercises their ordering with actual presented pixels.
            Set(typeof(Glow), "_completedPreparation", Get(typeof(Glow), "_preparationSerial"));
            if (after != null) after();
        });
        thread.IsBackground = true; thread.Start(); return thread;
    }
    static void Preview(string file, int width, int height, int elapsed)
    {
        IntPtr bits = Marshal.AllocHGlobal(width * height * 4);
        try
        {
            typeof(Glow).GetMethod("PaintPreparation", Flags).Invoke(null, new object[] { bits, width, height, elapsed });
            using (var layer = new Bitmap(width, height, width * 4, PixelFormat.Format32bppPArgb, bits))
            using (var preview = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            using (var g = Graphics.FromImage(preview))
            {
                g.Clear(Color.FromArgb(30, 35, 45)); g.DrawImageUnscaled(layer, 0, 0);
                preview.Save(file, ImageFormat.Png);
            }
        }
        finally { Marshal.FreeHGlobal(bits); }
    }
    static void Main(string[] args)
    {
        // The real renderer never starts; simulate only its successful-present signal.
        Set(typeof(Glow), "_thread", new Thread(delegate() { }));
        Program.PreparationForeground = delegate { return new IntPtr(123); };
        SceneControl.Reset();
        var cadence = new PreparationCadence();
        Check(cadence.Duration(0) == 1000 && cadence.Duration(500) == 1000, "unseen/failed cue does not consume full warning");
        cadence.Presented(500);
        Check(cadence.Duration(501) == 100 && cadence.Duration(180499) == 100, "repeat before three minutes is short");
        Check(cadence.Duration(180500) == 1000, "exact three-minute boundary restores full cue");
        cadence.Presented(180499);
        Check(cadence.Duration(180500) == 100 && cadence.Duration(360498) == 100, "every displayed cue renews sliding window");
        Check(cadence.Duration(360499) == 1000, "three minutes since latest cue restores full warning");
        cadence.Presented((long)int.MaxValue - 50);
        Check(cadence.Duration((long)int.MaxValue + 50) == 100, "64-bit monotonic time survives Windows tick rollover");
        Check(cadence.Duration(0) == 1000, "clock reset fails safely to full warning");
        cases.Add("first, repeated, sliding-window, exact-boundary and monotonic cadence");
        long duration;
        var present = Present(120, null); var watch = Stopwatch.StartNew();
        Invoke("PrepareActuation", "key", Request("one")); duration = watch.ElapsedMilliseconds;
        present.Join();
        Check(duration >= 1100 && duration < 4000, "cold presentation does not consume the 1000ms warning");
        Check(!Glow.Preparing && !Glow.Acting, "preparation never claims input and is cleared");
        cases.Add("full 1000ms starts after first visible frame; preparation is not actuation");

        watch.Restart(); Invoke("PrepareActuation", "key", Request("one"));
        Check(watch.ElapsedMilliseconds < 200, "same batch does not announce each primitive");
        cases.Add("one completed warning per coherent input series");

        present = Present(20, null); watch.Restart();
        Invoke("PrepareActuation", "key", Request("repeat")); present.Join();
        Check(Glow.PreparationMs == 100 && watch.ElapsedMilliseconds >= 120 && watch.ElapsedMilliseconds < 900,
            "independent call within three minutes uses fully presented 100ms warning");
        Glow.Off();
        present = Present(20, null); watch.Restart();
        Invoke("PrepareActuation", "key", Request("one")); present.Join();
        Check(Glow.PreparationMs == 100, "releasing a cycle does not erase in-process warning history");
        cases.Add("repeated and later-cycle warnings use 100ms after visible first frame");

        Panic.RecordHumanInput(0x41, true, false); Panic.RecordHumanInput(0x41, false, true);
        Exception caught = null;
        try { Invoke("PrepareActuation", "key", Request("one")); } catch (Exception error) { caught = error; }
        Check(caught != null && (string)caught.Data["code"] == "HUMAN_REOBSERVE" &&
            (string)caught.Data["outcome"] == "not-dispatched", "new user input invalidates batch continuation");
        cases.Add("passive input between primitives requires readback without replay");

        present = Present(40, delegate { Panic.RecordHumanInput(0x42, true, false); Panic.RecordHumanInput(0x42, false, true); });
        caught = null;
        try { Invoke("PrepareActuation", "key", Request("two")); } catch (Exception error) { caught = error; }
        present.Join();
        Check(caught != null && (string)caught.Data["code"] == "HUMAN_REOBSERVE" && !Glow.Acting && !Glow.Preparing,
            "input during countdown is free and invalidates stale target");
        cases.Add("typing during warning requires fresh target evidence with no dispatch");

        Set(typeof(Program), "_operationLive", true);
        Set(typeof(Program), "_operationHumanRevision", Panic.HumanRevision);
        Set(typeof(Program), "_operationCancelGeneration", Get(typeof(Program), "_cancelGeneration"));
        present = Present(30, delegate { Program.InvalidateActiveInput(); });
        watch.Restart(); caught = null;
        try { Invoke("PrepareActuation", "key", Request("cancelled")); } catch (Exception error) { caught = error; }
        present.Join(); Set(typeof(Program), "_operationLive", false);
        Check(caught != null && (string)caught.Data["code"] == "INPUT_CANCELLED" && watch.ElapsedMilliseconds < 500 && !Glow.Preparing,
            "cancel immediately closes warning without any input");
        cases.Add("owning turn cancellation interrupts countdown promptly");

        SceneControl.BeginActuation(); Glow.ActuationBegin(); Check(Glow.DeriveWant(false, 3) == 1, "real actuation wins thinking");
        SceneControl.EndActuation(); Glow.ActuationEnd(); Check(Glow.DeriveWant(false, 3) == 3, "no acting tail after scope ends");
        Check(Glow.DeriveWant(false, 0) == 0, "no stale acting cue when idle");
        cases.Add("deep blue follows real scope with no timed tail");

        Program.InputSender = delegate(INPUT[] input) { return (uint)input.Length; };
        Panic.CycleLit = true; Panic.Arm();
        Invoke("SendKey", (ushort)0x10, false);
        Invoke("EndActuationForReadback");
        Check(Glow.Acting, "held modifier keeps a nested sequence protected");
        Invoke("ReleaseKeyForCleanup", (ushort)0x10);
        Invoke("EndActuationForReadback");
        Check(!Glow.Acting && Glow.Holding && Glow.DeriveWant(true, 3) == 8,
            "finished input retains scene with breathing blue, ahead of capture flash");
        SceneControl.SetHolding(false);
        Check(!Glow.Holding && Glow.DeriveWant(false, 3) == 3, "explicit free restores cyan");
        long revision = Panic.HumanRevision;
        Panic.RecordHumanInput(0, false, false, true);
        Check(!Glow.Acting && !Panic.HumanActive && Panic.HumanRevision == revision,
            "explicit free permits user input without handoff");
        Panic.TryEndCycle();
        cases.Add("readback ends injection but holds scene; explicit free releases scene; modifiers retain sequence");

        bool called = false; var done = new ManualResetEvent(false);
        typeof(Panic).GetMethod("QueueDesktopControl", Flags).Invoke(null, new object[] {
            new Action(delegate { called = true; }), new Action(delegate { done.Set(); }) });
        Check(done.WaitOne(2000) && !called && !Program.DesktopOwned && !Panic.ControlListenersEnabled,
            "closed-cycle physical controls cannot acquire a lease or execute callbacks");
        done.Reset(); Panic.CycleLit = true;
        Set(typeof(Panic), "_controlsReleased", false);
        Set(typeof(Panic), "_engaged", true); Set(typeof(Panic), "_stopped", true);
        typeof(Panic).GetMethod("QueueDesktopControl", Flags).Invoke(null, new object[] {
            new Action(delegate { Panic.Clear(); done.Set(); }), null });
        Check(done.WaitOne(2000) && !Panic.Stopped && Panic.ControlListenersEnabled && Program.DesktopOwned,
            "live manual recovery still executes and preserves cycle ownership");
        Check(Panic.TryEndCycle() && !Panic.ControlListenersEnabled && !Program.DesktopOwned,
            "normal release turns off controls and frees the lease again");
        cases.Add("closed physical controls stay silent and live manual recovery remains available");

        SceneControl.SetHolding(true); Check(!Glow.Holding, "hold cannot open a released cycle");
        Panic.CycleLit = true; Panic.Arm(); SceneControl.SetHolding(true); Glow.Reveal();
        Check(Glow.Holding && Glow.DeriveWant(false, 3) == 8, "explicit hold protects a live cycle");
        Panic.RecordHumanInput(0x45, true, false); Panic.RecordHumanInput(0x45, false, true);
        Check(Panic.HumanActive && Glow.DeriveWant(false, 3) == 6, "human keyboard takes over a held scene");
        Glow.Stopped(true); Check(Glow.Holding && Glow.DeriveWant(false, 3) == 4, "pause rendering wins without mutating scene authority");
        SceneControl.Reset(); Check(!Glow.Holding, "domain lifecycle explicitly releases hold");
        Glow.Stopped(false); Panic.TryEndCycle(); Glow.Kill();
        Check(!Glow.Holding, "release/kill leaves no retained scene");
        for (int t = 0; t <= 5000; t += 16)
            Check(Glow.HoldingAlpha(t) >= 120 && Glow.HoldingAlpha(t) <= 204, "holding breath remains visible");
        cases.Add("holding state precedence, free release, human takeover and lifecycle cleanup");

        Directory.CreateDirectory(args[0]);
        Set(typeof(Glow), "_preparationMs", 1000);
        Preview(Path.Combine(args[0], "preparation-1280.png"), 1280, 720, 750);
        Preview(Path.Combine(args[0], "preparation-2560.png"), 2560, 1600, 0);
        Console.WriteLine(new JavaScriptSerializer().Serialize(new { passed = cases.Count, cases,
            startupMs = duration, nativeInput = false, visibleOverlay = false, previews = args[0] }));
    }
}
