// Full production helper + owned-input ledger with a fake sender and fake HWNDs.
// Never calls worker Main, registers hooks, changes foreground or sends real input.
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Threading;
using System.Web.Script.Serialization;
using DshComputerUse.Worker;

public static class WindowManagementKeyFixture
{
    const BindingFlags Flags = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
    static int assertions;
    static readonly List<string> cases = new List<string>();
    static readonly List<INPUT> sent = new List<INPUT>();
    static IntPtr foreground = new IntPtr(42);
    static void Check(bool value, string name) { assertions++; if (!value) throw new Exception(name); }
    static object Call(string name, params object[] args) {
        try { return typeof(Program).GetMethod(name, Flags).Invoke(null, args); }
        catch (TargetInvocationException e) { throw e.InnerException; }
    }
    static void Set(Type t, string name, object value) { t.GetField(name, Flags).SetValue(null, value); }
    static object Get(string name) { return typeof(Program).GetField(name, Flags).GetValue(null); }
    static void Reset() {
        Set(typeof(Panic), "_pendingPauses", 0); Set(typeof(Panic), "_pendingExits", 0);
        Set(typeof(Panic), "_engaged", false); Set(typeof(Panic), "_exited", false);
        Set(typeof(Program), "_operationLive", false); Set(typeof(Program), "_operationDispatched", false);
        Program.ReleaseOwnedInputs(); Call("EndActuationForReadback");
        sent.Clear(); foreground = new IntPtr(42);
        Set(typeof(Program), "_keyboardReobserveRequired", false);
        Set(typeof(Program), "_stickyHwnd", new IntPtr(42));
    }
    static void Case(string name, Action body) { Reset(); body(); cases.Add(name); }
    static Exception Capture(Action action) { try { action(); return null; } catch (Exception e) { return e; } }
    static void Run(int switchAfter, Action hold, Action continuation, Func<ushort, bool> down) {
        int accepted = 0;
        using ((IDisposable)Call("GuardReceiver", new IntPtr(42), 7U, true))
            WindowManagementChord.Run(new ushort[] { 18, 9 }, delegate(ushort vk, bool up) {
                Call("SendKey", vk, up);
                if (!up && ++accepted == switchAfter) foreground = new IntPtr(99);
            }, vk => Call("ReleaseKeyForCleanup", vk), down, hold, continuation,
                () => Call("InvalidateKeyboardTarget"));
    }
    static void Continue() { Call("WaitForKeyHold", 0); }
    static void ExpectGate() {
        Check((bool)Get("_keyboardReobserveRequired"), "requires reobservation");
        Check((IntPtr)Get("_stickyHwnd") == IntPtr.Zero, "old sticky target invalidated");
        var error = Capture(() => Call("FocusReport", new Dictionary<string, object> { { "expectHwnd", 42 } }, true));
        Check(error != null && (string)error.Data["code"] == "INPUT_REOBSERVE_REQUIRED", "even explicit stale HWND cannot refocus");
        Check((string)error.Data["outcome"] == "not-dispatched", "next keyboard operation did not dispatch");
    }
    public static void Main() {
        Set(typeof(Glow), "_thread", new Thread(delegate() {}));
        Program.InputSender = inputs => { sent.AddRange(inputs); return (uint)inputs.Length; };
        Program.InputForeground = () => foreground;
        Program.InputWindowExists = h => h == new IntPtr(42);
        Program.InputWindowPid = h => h == new IntPtr(42) ? 7U : 8U;
        Case("exact canonical chords only", delegate {
            foreach (string combo in new[] { "alt+tab", "alt+shift+tab", "alt+esc", "alt+shift+esc", "win+d", "win+tab", "win+left", "win+right", "win+up", "win+down", "rwin+d", "rwin+tab", "rwin+left", "rwin+right", "rwin+up", "rwin+down" })
                Check(WindowManagementChord.IsExact(combo), "allowed exact chord " + combo);
            foreach (string combo in new[] { "ctrl+alt+tab", "alt+tab+a", "alt", "tab", "alt+f4", "win+r", "win+shift+left", "rwin+shift+d", "alt+tab, a", "alt+tab enter" })
                Check(!WindowManagementChord.IsExact(combo), "no extra key or segment exemption " + combo);
            Check(WindowManagementChord.IsExact((string)Call("NormalizeKeyCombo", " SHIFT + ALT + TAB ")), "existing normalization precedes classification");
        });
        Case("foreground changes after final down; owned releases complete", delegate {
            Run(2, () => {}, Continue, vk => false);
            Check(sent.Count == 4, "exactly two downs and two releases");
            Check(sent[0].u.ki.wVk == 18 && sent[1].u.ki.wVk == 9 && sent[2].u.ki.wVk == 9 && sent[3].u.ki.wVk == 18, "chord order");
            Check(sent[2].u.ki.dwFlags == Native.KEYEVENTF_KEYUP && sent[3].u.ki.dwFlags == Native.KEYEVENTF_KEYUP, "no down into new foreground");
            Check(Program.ReleaseOwnedInputs() == 0, "owned ledger empty"); ExpectGate();
        });
        Case("foreground changes before final down; remaining down refused", delegate {
            var error = Capture(() => Run(1, () => {}, Continue, vk => false));
            Check(error != null && (string)error.Data["code"] == "INPUT_TARGET_CHANGED", "strict downs preserved");
            Check(sent.Count == 2 && sent[0].u.ki.wVk == 18 && sent[1].u.ki.wVk == 18, "only accepted modifier released");
            Check((string)error.Data["keyCleanup"] == "completed", "failure cleanup reported"); ExpectGate();
        });
        Case("ordinary chords still reject changed foreground on release", delegate {
            using ((IDisposable)Call("GuardReceiver", new IntPtr(42), 7U, true)) {
                var error = Capture(() => KeyboardChord.Run(new ushort[] { 17, 65 }, (vk, up) => Call("SendKey", vk, up),
                    vk => Call("ReleaseKeyForCleanup", vk), vk => false, () => { foreground = new IntPtr(99); }));
                Check(error != null && (string)error.Data["code"] == "INPUT_TARGET_CHANGED", "ordinary contract unchanged");
                Check(sent.Count == 4 && Program.ReleaseOwnedInputs() == 0, "ordinary failure cleans only owned downs");
            }
        });
        foreach (string stop in new[] { "pause", "exit", "cancel", "brake", "human" }) {
            string reason = stop;
            Case("human and cancellation win after window change: " + reason, delegate {
                var error = Capture(() => Run(2, delegate {
                    if (reason == "pause") Set(typeof(Panic), "_pendingPauses", 1);
                    else if (reason == "exit") Set(typeof(Panic), "_pendingExits", 1);
                    else if (reason == "brake") Set(typeof(Panic), "_engaged", true);
                    else if (reason == "human") {
                        Set(typeof(Program), "_operationLive", true);
                        Set(typeof(Program), "_operationCancelGeneration", Get("_cancelGeneration"));
                        Set(typeof(Program), "_operationHumanRevision", -1L);
                    }
                    else { Set(typeof(Program), "_operationLive", true); Set(typeof(Program), "_operationCancelGeneration", -1L); }
                }, Continue, vk => false));
                Check(error != null, "continuation interrupted " + reason);
                Check(sent.Count == 4 && (string)error.Data["keyCleanup"] == "completed", "interruption still cleans own downs");
                if (reason == "brake") Check(Panic.Engaged, "invalidation never clears manual brake");
                Check((bool)Get("_keyboardReobserveRequired"), "interrupted partial chord invalidates target");
            });
        }
        Case("already held key is never released and does not invalidate unmodified target", delegate {
            var error = Capture(() => Run(2, () => {}, Continue, vk => vk == 9));
            Check(error != null && (string)error.Data["code"] == "KEY_ALREADY_DOWN", "preflight refusal");
            Check(sent.Count == 0 && !(bool)Get("_keyboardReobserveRequired"), "no dispatch and no target mutation");
        });
        Case("unrelated owned key remains held", delegate {
            Call("SendKey", (ushort)66, false);
            Run(2, () => {}, Continue, vk => false);
            Check(sent.Count == 5, "window chord released only its two keys");
            Check(Program.ReleaseOwnedInputs() == 1 && sent[sent.Count - 1].u.ki.wVk == 66, "unrelated ledger entry remains until its cleanup");
        });
        Case("failed owned release is reported, never silently claimed clean", delegate {
            Program.InputSender = inputs => {
                sent.AddRange(inputs);
                return (inputs[0].u.ki.dwFlags & Native.KEYEVENTF_KEYUP) != 0 ? 0U : (uint)inputs.Length;
            };
            var error = Capture(() => Run(2, () => {}, Continue, vk => false));
            Check(error != null && (string)error.Data["keyCleanup"] == "failed", "cleanup uncertainty retained");
            Check(error.Message.Contains("KEY_CLEANUP_FAILED"), "visible release failure");
            Check((bool)Get("_keyboardReobserveRequired"), "failed releases still invalidate target");
            Program.InputSender = inputs => { sent.AddRange(inputs); return (uint)inputs.Length; };
            Check(Program.ReleaseOwnedInputs() == 2, "failed releases remain owned until actually accepted");
        });
        Case("same receiver still requires reobservation; chord dispatch proves no switch", delegate {
            Run(0, () => {}, Continue, vk => false); ExpectGate();
            Check(foreground == new IntPtr(42), "no fabricated switch");
            int count = sent.Count;
            Check(Capture(() => Call("FocusReport", new Dictionary<string, object>(), true)) != null && sent.Count == count, "next sequence segment cannot silently reuse target");
        });
        Reset();
        Console.WriteLine(new JavaScriptSerializer().Serialize(new { ok = true, assertions, cases, realInput = false, realForegroundChange = false }));
    }
}
