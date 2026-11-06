// Production helpers and input sender seams only. No worker Main, real input,
// hook registration, foreground change or visible renderer.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Web.Script.Serialization;
using DshComputerUse.Worker;

public static class NativeHardeningFixture {
    static readonly BindingFlags Flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;
    static int assertions; static readonly List<string> cases = new List<string>();
    static void Check(bool yes, string text) { assertions++; if (!yes) throw new Exception(text); }
    static object Call(Type type, string name, params object[] args) {
        try { return type.GetMethod(name, Flags).Invoke(null, args); }
        catch (TargetInvocationException e) { throw e.InnerException; }
    }
    static object Call(string name, params object[] args) { return Call(typeof(Program), name, args); }
    static void Set(Type type, string name, object value) { type.GetField(name, Flags).SetValue(null, value); }
    static Dictionary<string, object> Snapshot(HumanInputState s, long now) { return (Dictionary<string, object>)s.Snapshot(now); }
    static void Case(string name, Action action) { action(); cases.Add(name); }
    public static void Main(string[] args) {
        Set(typeof(Glow), "_thread", new Thread(delegate() { }));
        Case("phase transitions have independent monotonic sequence", delegate {
            var s = new HumanInputState(); s.Enable(true, 0); s.SetActing(true, 0); s.Record(0, false, false, 10);
            var before = Snapshot(s, 10); s.Tick(3010); var after = Snapshot(s, 3010);
            Check((long)after["stateSeq"] > (long)before["stateSeq"], "idle advances stateSeq");
            Check((long)after["revision"] == (long)before["revision"], "physical revision remains separate");
            long seq = (long)after["stateSeq"]; s.Enable(false, 4000); Check((long)Snapshot(s, 4000)["stateSeq"] > seq, "disable is versioned");
            var actual = (Dictionary<string, object>)Panic.CooperationState();
            Check((string)actual["workerGeneration"] == Program.WorkerGeneration, "generation attached to native cooperation");
        });
        Case("missing release recovers only from repeated verified up evidence", delegate {
            var s = new HumanInputState(); s.Enable(true, 0); s.SetActing(true, 0); s.Record(65, true, false, 10); s.Tick(2010);
            Check(s.ReconcileReleased(k => false, true, 2020) == 0, "one sample insufficient");
            Check(s.ReconcileReleased(k => false, true, 2060) == 0, "two samples insufficient");
            Check(s.ReconcileReleased(k => false, true, 2100) == 1 && !s.Held(65), "three verified up samples repair history");
            s.Tick(5099); Check(s.Active, "repair starts full new quiet interval"); s.Tick(5100); Check(!s.Active, "then handback");
            Check((int)Snapshot(s, 5100)["reconciledReleaseCount"] == 1, "repair is observable");
        });
        Case("no timeout, insecure reads or injected up can steal physical ownership", delegate {
            var s = new HumanInputState(); s.Enable(true, 0); s.SetActing(true, 0); s.Record(0xA2, true, false, 0);
            for (int i = 0; i < 5; i++) Check(s.ReconcileReleased(k => true, true, 1000000L + i) == 0, "actually held remains held");
            s.ReconcileReleased(k => false, true, 1000010); s.ReconcileReleased(k => false, false, 1000020);
            Check(s.ReconcileReleased(k => false, true, 1000030) == 0, "untrusted sample resets evidence");
            s.NoteInjected(0x11);
            for (int i = 0; i < 5; i++) Check(s.ReconcileReleased(k => false, true, 1000040L + i) == 0, "generic injected modifier up cannot prove physical side released");
            Check(s.Held(0xA2), "tainted hold preserved"); s.Record(0xA2, false, true, 1000100); s.Tick(1003100); Check(!s.Active, "real up remains authoritative");
            object[] healthy = { true, true, false, false, false, 300L, true };
            Check((bool)Call(typeof(Panic), "CanReconcileHeld", healthy), "healthy normal desktop permits verification");
            for (int i = 0; i < healthy.Length; i++) {
                var blocked = (object[])healthy.Clone(); blocked[i] = i == 5 ? (object)299L : !(bool)healthy[i];
                Check(!(bool)Call(typeof(Panic), "CanReconcileHeld", blocked), "every health/injection/desktop precondition required " + i);
            }
            Check((bool)Call("AsyncKeyIntegrityAllows", 0x2000, 0x2000), "known equal integrity permits observation");
            Check((bool)Call("AsyncKeyIntegrityAllows", 0x3000, 0x2000), "known lower foreground permits observation");
            foreach (int[] levels in new int[][] { new int[] { 0x2000, 0x3000 }, new int[] { 0x2000, -1 }, new int[] { -1, 0x2000 } }) {
                var blocked = new HumanInputState(); blocked.Enable(true, 0); blocked.SetActing(true, 0); blocked.Record(65, true, false, 0);
                bool trusted = (bool)Call("AsyncKeyIntegrityAllows", levels[0], levels[1]);
                for (int i = 0; i < 3; i++) blocked.ReconcileReleased(k => false, trusted, 300 + i * 40);
                blocked.Tick(1000000);
                Check(!trusted && blocked.Held(65) && blocked.Active, "UIPI/unknown zero cannot release physical key");
            }
            Check((int)Call("ProcessIntegrityLevel", (uint)System.Diagnostics.Process.GetCurrentProcess().Id) >= 0, "real read-only token query decodes self integrity");
            Check((int)Call("ProcessIntegrityLevel", 0U) == -1, "missing process is unknown");
            foreach (int physical in new int[] { 1, 2 }) foreach (int tracked in new int[] { 1, 2 }) {
                var mouse = new HumanInputState(); mouse.Enable(true, 0); mouse.SetActing(true, 0); mouse.Record(tracked, true, false, 0);
                for (int i = 0; i < 3; i++) mouse.ReconcileReleased(k => HumanInputState.AsyncButtonMayBeDown(k, true, p => p == physical), true, 100 + 40 * i);
                Check(mouse.Held(tracked), "swapped mapping cannot release either history while a physical button is held");
            }
            Check(!HumanInputState.AsyncButtonMayBeDown(1, true, p => false), "both physical buttons up is usable swapped evidence");
            Check(!HumanInputState.AsyncButtonMayBeDown(1, false, p => p == 2), "normal mapping retains per-button check");
            var injectedMouse = new HumanInputState(); injectedMouse.Record(1, true, false, 0); injectedMouse.NoteInjected(2);
            for (int i = 0; i < 3; i++) injectedMouse.ReconcileReleased(k => false, true, 100 + 40 * i);
            Check(injectedMouse.Held(1), "injected opposite mouse button taints swapped ambiguity");
        });
        Case("rendering shutdown cannot release scene authority", delegate {
            Panic.CycleLit = true; Panic.Arm(); SceneControl.SetHolding(true);
            Glow.Off(); Check(SceneControl.Holding && Glow.DeriveWant(false, 0) == 0, "Off hides renderer but preserves authority");
            Glow.Reveal(); Check(Glow.DeriveWant(false, 0) == 8, "reveal displays existing authoritative hold");
            Glow.Kill(); Check(SceneControl.Holding && Glow.DeriveWant(false, 0) == 0, "Kill hides renderer but preserves authority");
            SceneControl.BeginActuation(); Glow.Off(); Check(SceneControl.Acting && Glow.Acting, "acting truth survives hidden UI");
            SceneControl.EndActuation(); Check(!SceneControl.Acting && SceneControl.Holding, "input end preserves intended scene hold");
            SceneControl.Reset(); Check(!SceneControl.Holding && !SceneControl.Acting, "explicit domain reset releases");
            Panic.Disarm(); Panic.CycleLit = false;
        });
        var sent = new List<INPUT>(); IntPtr foreground = new IntPtr(42), point = new IntPtr(42);
        Program.InputSender = input => { sent.AddRange(input); return (uint)input.Length; };
        Program.InputForeground = () => foreground; Program.InputPointReceiver = () => point;
        Program.InputWindowExists = h => h == new IntPtr(42); Program.InputWindowPid = h => h == new IntPtr(42) ? 7U : 8U;
        Case("receiver change stops the next event and cleanup only releases accepted downs", delegate {
            using ((IDisposable)Call("GuardReceiver", new IntPtr(42), 7U, true)) {
                Call("SendKey", (ushort)65, false); foreground = new IntPtr(99);
                Exception error = null; try { Call("SendKey", (ushort)66, false); } catch (Exception e) { error = e; }
                Check(error != null && (string)error.Data["code"] == "INPUT_TARGET_CHANGED", "changed keyboard receiver refused");
                Check(sent.Count == 1, "no B delivered");
                Check(Program.ReleaseOwnedInputs() == 1 && sent.Count == 2 && sent[1].u.ki.wVk == 65, "only accepted A released through bypass");
            }
            Call("EndActuationForReadback"); foreground = new IntPtr(42); point = new IntPtr(99);
            Exception mismatch = null; try { using ((IDisposable)Call("GuardReceiver", new IntPtr(42), 7U, false)) { } } catch (Exception e) { mismatch = e; }
            Check(mismatch != null && sent.Count == 2, "point occlusion refused before button down");
            Check((string)Call("InputReceiverProblem", 42L, 7U, true, 8U, 42L) != null, "recycled HWND pid rejected");
        });
        Case("cancellation confirms only measured cleanup and is bounded when input lock is busy", delegate {
            sent.Clear(); Set(typeof(Program), "_activeRequestId", 500); Call("SendKey", (ushort)67, false);
            var ack = (Dictionary<string, object>)Call("CancelInputStatus", 500);
            Check((bool)ack["cancelled"] && (bool)ack["cleanupConfirmed"] && (int)ack["ownedInputCount"] == 0 && sent.Count == 2, "active accepted down cleaned before confirmation");
            Set(typeof(Program), "_activeRequestId", 600); Call("SendKey", (ushort)68, false);
            ack = (Dictionary<string, object>)Call("CancelInputStatus", 500);
            Check(!(bool)ack["cleanupConfirmed"] && (int)ack["ownedInputCount"] == 1 && sent.Count == 3, "older request cannot release newer input");
            Program.ReleaseOwnedInputs(); Call("EndActuationForReadback");
            var inputLock = typeof(Program).GetField("InputLock", Flags).GetValue(null); var done = new ManualResetEvent(false);
            Dictionary<string, object> busy = null;
            lock (inputLock) {
                var t = new Thread(delegate() { busy = (Dictionary<string, object>)Call("CancelInputStatus", 600); done.Set(); }); t.IsBackground = true; t.Start();
                Check(done.WaitOne(1000), "cancel reader returns despite busy input lock");
                Check(!(bool)busy["cleanupConfirmed"] && (string)busy["cleanupState"] == "input-lock-busy", "busy is uncertainty, never clean");
            }
            Set(typeof(Program), "_activeRequestId", 0);
        });
        Case("negative monitor sampling contains clicked point and stays within desktop", delegate {
            foreach (var desktop in new Rectangle[] { new Rectangle(-1920, -1080, 4480, 2680), new Rectangle(-700, -500, 200, 100) })
                foreach (var click in new Point[] { desktop.Location, new Point(desktop.Right - 1, desktop.Bottom - 1), new Point(desktop.Left + desktop.Width / 2, desktop.Top + desktop.Height / 2) }) {
                    var r = (Rectangle)Call("ClickSampleRegion", click.X, click.Y, desktop);
                    Check(desktop.Contains(r) && r.Contains(click), "origin-aware click region " + click);
                }
        });
        Case("ready identity and JS/native canonical key contract", delegate {
            var identity = (Dictionary<string, object>)Call("RuntimeIdentity");
            Check((int)identity["protocolVersion"] == 2 && (string)identity["workerGeneration"] == Program.WorkerGeneration, "native protocol and process identity");
            Check((string)identity["buildId"] == "fixture-build" && (string)identity["sourceHash"] == "fixture-source", "validated launcher identity passed through");
            var contract = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(args[0]));
            foreach (Dictionary<string, object> test in (IEnumerable)contract["valid"])
                Check((string)Call("NormalizeKeyCombo", (string)test["input"]) == (string)test["combo"], "key contract: " + test["input"]);
            foreach (string input in (IEnumerable)contract["invalid"]) {
                bool refused = false; try { Call("NormalizeKeyCombo", input); } catch { refused = true; }
                Check(refused, "bad key syntax refused: " + input);
            }
        });
        Console.WriteLine(new JavaScriptSerializer().Serialize(new { passed = cases.Count, assertions = assertions, cases = cases, nativeInput = false, visibleOverlay = false }));
    }
}
