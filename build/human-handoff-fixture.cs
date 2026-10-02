using System;
using System.Collections.Generic;
using System.Reflection;
using System.Threading;
using System.Web.Script.Serialization;
using DshComputerUse.Worker;

static class HumanHandoffFixture
{
    static int assertions;
    static readonly List<string> cases = new List<string>();
    static void Check(bool value, string label) { assertions++; if (!value) throw new Exception(label); }
    static void Case(string label, Action action) { action(); cases.Add(label); }
    static void Invoke(string name, params object[] args)
    {
        try { typeof(Program).GetMethod(name, BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, args); }
        catch (TargetInvocationException e) { throw e.InnerException; }
    }
    static void Main()
    {
        Case("brief touch immediately yields; exact 3-second idle boundary", delegate {
            var s = new HumanInputState(); s.Enable(true, 0); s.Record(0, false, false, 10);
            Check(s.Phase == "yielding", "first movement yields immediately");
            s.Tick(2010); Check(s.Phase == "yielding", "a solitary touch does not fabricate sustained input");
            s.Tick(3009); Check(s.Active, "2999ms does not release");
            s.Tick(3010); Check(!s.Active, "3000ms releases");
        });
        Case("continuous input reaches waiting at exactly 2 seconds", delegate {
            var s = new HumanInputState(); s.Enable(true, 0);
            s.Record(0, false, false, 100); s.Record(0, false, false, 2099);
            Check(s.Phase == "yielding", "1999ms remains initial yield");
            s.Record(0, false, false, 2100); Check(s.Phase == "waiting", "2000ms enters waiting");
            s.Tick(5099); Check(s.Active, "wait from LAST event");
            s.Record(0, false, false, 5099); s.Tick(8098); Check(s.Active, "new input restarts idle timer");
            s.Tick(8099); Check(!s.Active, "full fresh quiet interval releases");
        });
        Case("held key and mouse button never count as quiet", delegate {
            foreach (int key in new int[] { 1, 2, 4, 5, 6, 0x41, 0xA2, 0xA3, 0x5B }) {
                var s = new HumanInputState(); s.Enable(true, 0); s.Record(key, true, false, 0);
                s.Tick(1999); Check(s.Phase == "yielding", "hold under 2s");
                s.Tick(2000); Check(s.Phase == "waiting", "held input at 2s");
                s.Tick(3600000); Check(s.Active, "held input has no idle timeout");
                s.Record(key, false, true, 3600000); s.Tick(3602999); Check(s.Active, "keyup starts quiet interval");
                s.Tick(3603000); Check(!s.Active, "released and quiet returns control");
            }
        });
        Case("auto repeat and both sides of modifiers retain physical ownership", delegate {
            var s = new HumanInputState(); s.Enable(true, 0);
            s.Record(0xA2, true, false, 0); s.Record(0xA2, true, false, 10); s.Record(0xA3, true, false, 20);
            s.Record(0xA2, false, true, 30); Check(s.Held(0x11), "right Ctrl remains held");
            s.Tick(10000); Check(s.Active, "autorepeat is not a separate release obligation");
            s.Record(0xA3, false, true, 10001); s.Tick(13001); Check(!s.Active, "both released");
        });
        Case("no cycle stays idle; opening during a held key yields", delegate {
            var s = new HumanInputState(); s.Record(0x41, true, false, 0); Check(!s.Active, "no cycle no overlay");
            s.Enable(true, 4000); Check(s.Active, "held key is respected on cycle open");
            s.Enable(false, 5000); Check(!s.Active, "cycle end closes wait");
            s.Record(0x41, false, true, 6000); s.Enable(true, 7000); Check(s.Active, "recent user event respected");
            s.Tick(9000); Check(!s.Active, "quiet calculation uses release event");
        });
        Case("timestamps survive signed Windows tick rollover", delegate {
            long t = (long)int.MaxValue - 2; var s = new HumanInputState(); s.Enable(true, t);
            s.Record(0, false, false, t); s.Tick(t + 2999); Check(s.Active, "64-bit monotonic clock");
            s.Tick(t + 3000); Check(!s.Active, "rollover does not wedge");
        });
        Case("separate touches do not merge when the polling tick arrives late", delegate {
            var s = new HumanInputState(); s.Enable(true, 0);
            s.Record(0, false, false, 10); s.Record(0, false, false, 3010);
            Check(s.Phase == "yielding", "a 3-second gap starts a fresh burst without a poll tick");
            s.Record(0, false, false, 5009); Check(s.Phase == "yielding", "new burst under 2s");
            s.Record(0, false, false, 5010); Check(s.Phase == "waiting", "new burst reaches 2s");
        });
        Case("manual control callbacks preserve event order even when one is slow", delegate {
            var entered = new ManualResetEvent(false); var release = new ManualResetEvent(false);
            var done = new ManualResetEvent(false); var order = new List<int>();
            Panic.QueueControl(delegate { entered.Set(); release.WaitOne(); order.Add(1); });
            Check(entered.WaitOne(2000), "first callback started");
            Panic.QueueControl(delegate { order.Add(2); });
            Panic.QueueControl(delegate { order.Add(3); done.Set(); });
            release.Set(); Check(done.WaitOne(2000), "queue drained");
            Check(string.Join(",", order) == "1,2,3", "pause/resume/exit cannot reorder");
        });
        Case("only physical exact Ctrl+Esc activates manual keyboard pause", delegate {
            Check(Panic.ControlHotkey(0x1B, true, true, true, false, false, false, true) == "pause", "Ctrl+Esc");
            Check(Panic.ControlHotkey(0x1B, true, true, false, false, false, false, true) == "", "plain Esc is not pause");
            Check(Panic.ControlHotkey(0x1B, true, false, true, false, false, false, true) == "", "injected chord ignored");
            Check(Panic.ControlHotkey(0x1B, true, true, true, false, true, false, true) == "", "Task Manager chord unchanged");
            Check(Panic.ControlHotkey(0x1B, true, true, true, true, false, false, true) == "", "extra Alt is not Ctrl+Esc");
            Check(Panic.ControlHotkey(0x1B, true, true, true, false, false, true, true) == "", "extra Win ignored");
            Check(Panic.ControlHotkey(0x1B, false, true, true, false, false, false, true) == "", "keyup ignored");
            Check(Panic.ControlHotkey(0x1B, true, true, true, false, false, false, false) == "", "no live cycle");
            Check(Panic.ControlHotkey(0x52, true, true, true, true, false, false, true) == "resume", "manual resume retained");
            Check(Panic.ControlHotkey(0x51, true, true, true, true, false, false, true) == "exit", "explicit exit retained");
        });
        Case("physical classification excludes own and third-party injected events", delegate {
            Check(Panic.PhysicalEvent(IntPtr.Zero, 0, 3), "physical mouse");
            Check(!Panic.PhysicalEvent(Panic.OwnMagic, 0, 3), "own signature without injected flag");
            Check(!Panic.PhysicalEvent(IntPtr.Zero, 1, 3), "other mouse injection");
            Check(!Panic.PhysicalEvent(IntPtr.Zero, 2, 3), "lower-integrity injection");
            Check(!Panic.PhysicalEvent(IntPtr.Zero, 0x10, 0x12), "keyboard injection");
        });
        Case("hotkey modifiers retain the other physical side after one is released", delegate {
            Panic.ResetHumanTrack();
            Panic.ClassifyAndTrackKey(0xA2, true, false, IntPtr.Zero, 0);
            Panic.ClassifyAndTrackKey(0xA3, true, false, IntPtr.Zero, 0);
            Panic.ClassifyAndTrackKey(0xA2, false, true, IntPtr.Zero, 0);
            Check(Panic.HumanCtrlDown, "right Ctrl remains a valid hotkey modifier");
            Panic.ClassifyAndTrackKey(0xA3, false, true, IntPtr.Zero, 0);
            Check(!Panic.HumanCtrlDown, "all physical Ctrl keys released");
            Panic.ResetHumanTrack();
        });
        Case("gentle yellow gradient stays bounded and smooth", delegate {
            int last = Glow.HumanYieldAlpha(0);
            for (int t = 16; t < 8400; t += 16) {
                int a = Glow.HumanYieldAlpha(t); Check(a >= 48 && a <= 108, "bounded alpha");
                Check(Math.Abs(a - last) <= 2, "no abrupt flicker"); last = a;
            }
        });
        var state = (HumanInputState)typeof(Panic).GetField("Handoff", BindingFlags.Static | BindingFlags.NonPublic).GetValue(null);
        var sent = new List<INPUT>();
        Program.InputSender = delegate(INPUT[] inputs) { sent.AddRange(inputs); return (uint)inputs.Length; };
        Case("extended key cleanup preserves the accepted down flags", delegate {
            sent.Clear(); Invoke("SendKey", (ushort)0xA3, false);
            Check(Program.ReleaseOwnedInputs() == 1, "right Ctrl released");
            Check((sent[0].u.ki.dwFlags & 1) != 0 && (sent[1].u.ki.dwFlags & 3) == 3,
                "right Ctrl down/up both carry extended flag");
        });
        Case("release accepted owned keys once; never synthesize unrelated releases", delegate {
            sent.Clear(); Invoke("SendKey", (ushort)0x11, false); Invoke("SendKey", (ushort)0x41, false);
            Check(Program.ReleaseOwnedInputs() == 2, "two accepted downs released");
            Check(sent.Count == 4, "exactly two ups");
            Check(Program.ReleaseOwnedInputs() == 0 && sent.Count == 4, "cleanup idempotent");
            foreach (var input in sent) Check(input.u.ki.dwExtraInfo == Panic.OwnMagic, "cleanup retains own signature");
        });
        Case("physical takeover retains user's key while releasing other owned input", delegate {
            sent.Clear(); Invoke("SendKey", (ushort)0x11, false); Invoke("SendKey", (ushort)0x41, false);
            state.Record(0xA2, true, false, 0);
            Check(Program.ReleaseOwnedInputs() == 1, "only A released");
            Check(sent.Count == 3 && sent[2].u.ki.wVk == 0x41, "physical Ctrl preserved");
            state.Record(0xA2, false, true, 1);
            Check(Program.ReleaseOwnedInputs() == 0, "ownership transfer is final");
        });
        Case("human input between accepted down and next event stops dispatch and releases down", delegate {
            sent.Clear(); state.Enable(false, 5000); Invoke("SendKey", (ushort)0x42, false);
            state.Enable(true, 5000); state.Record(0, false, false, 5001);
            bool refused = false;
            try { Invoke("SendKey", (ushort)0x43, false); } catch (Exception e) { refused = (string)e.Data["code"] == "HUMAN_YIELD"; }
            Check(refused, "next event refused immediately"); Check(sent.Count == 1, "no C accepted");
            Check(Program.ReleaseOwnedInputs() == 1 && sent.Count == 2, "B released despite yielding");
            state.Enable(false, 9000);
        });
        Case("failed cleanup remains owned for a later retry", delegate {
            sent.Clear(); Invoke("SendKey", (ushort)0x44, false);
            Program.InputSender = delegate(INPUT[] inputs) { return 0; };
            Check(Program.ReleaseOwnedInputs() == 0, "refused cleanup not declared successful");
            Program.InputSender = delegate(INPUT[] inputs) { sent.AddRange(inputs); return (uint)inputs.Length; };
            Check(Program.ReleaseOwnedInputs() == 1, "later retry releases retained key");
        });
        Case("input boundary refuses a pause without waiting for the cross-process stop lock", delegate {
            var flags = BindingFlags.Static | BindingFlags.NonPublic;
            var stopLock = typeof(Panic).GetField("SyncLock", flags).GetValue(null);
            var engaged = typeof(Panic).GetField("_engaged", flags);
            var stopped = typeof(Panic).GetField("_stopped", flags);
            var done = new ManualResetEvent(false); Exception caught = null;
            var thread = new Thread(delegate() {
                try { Invoke("SendTrackedInput", new INPUT[] { new INPUT() }); }
                catch (Exception e) { caught = e; }
                finally { done.Set(); }
            });
            thread.IsBackground = true;
            try {
                lock (stopLock) {
                    engaged.SetValue(null, true); stopped.SetValue(null, true);
                    thread.Start();
                    Check(done.WaitOne(1000), "input refusal must finish while another thread holds the stop lock");
                    Check(caught != null && (string)caught.Data["code"] == "ABORTED", "manual brake remains authoritative");
                }
            } finally { engaged.SetValue(null, false); stopped.SetValue(null, false); thread.Join(2000); }
        });
        Console.WriteLine(new JavaScriptSerializer().Serialize(new { passed = cases.Count, assertions, cases,
            nativeInput = false, scope = "production state machine and input ledger with deterministic clock and injected input-sender seam" }));
    }
}
