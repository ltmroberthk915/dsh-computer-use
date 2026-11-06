// Pure geometry plus GDI allocation with BitBlt forced false and the extracted
// production ShiftClick guard body with a fake sender. No capture, input or Main.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using DshComputerUse.Worker;

public static class VerificationRegionFixture
{
    static readonly Type Worker = typeof(DshComputerUse.Worker.Program);
    static readonly BindingFlags Flags = BindingFlags.NonPublic | BindingFlags.Static;
    static readonly MethodInfo RegionMethod = Worker.GetMethod("VerificationSampleRegion", Flags);
    static readonly MethodInfo VerifyMethod = Worker.GetMethod("AddPixelVerification", Flags);
    static readonly List<string> Failures = new List<string>();
    static int checks;
    static int failedPixelCopyCalls, physicalInputCalls;
    [DllImport("user32.dll")] static extern uint GetGuiResources(IntPtr process, uint flags);
    public static bool FailCopy() { failedPixelCopyCalls++; return false; }
    public static void ForbidNativeInput() { physicalInputCalls++; throw new InvalidOperationException("physical input forbidden in fixture"); }
    static void Check(bool value, string label) { checks++; if (!value) Failures.Add(label); }
    static Dictionary<string, object> D(params object[] pairs)
    {
        var result = new Dictionary<string, object>();
        for (int i = 0; i < pairs.Length; i += 2) result[(string)pairs[i]] = pairs[i + 1];
        return result;
    }
    static Dictionary<string, object> Box(object x, object y, object width, object height)
    { return D("x", x, "y", y, "width", width, "height", height); }
    static Rectangle Region(Dictionary<string, object> args, Rectangle desktop, int x = 100, int y = 100)
    { return (Rectangle)RegionMethod.Invoke(null, new object[] { args, x, y, desktop }); }
    static void Refused(object box, string label)
    {
        try { Region(D("verificationRegion", box), new Rectangle(-1920, -1000, 4480, 2600)); Check(false, label + " accepted"); }
        catch (TargetInvocationException error)
        {
            Exception inner = error.InnerException;
            Check((string)inner.Data["code"] == "INVALID_VERIFICATION_REGION", label + " code");
            Check((string)inner.Data["outcome"] == "not-dispatched", label + " no-input outcome");
        }
    }
    static Dictionary<string, object> Verified(byte[] before, byte[] after, bool requested = true, bool explicitVerify = false)
    {
        var result = D("receipt", "unchanged");
        var args = requested ? D("verificationRegion", Box(-20, 30, 100, 80)) : D();
        if (explicitVerify) args["verify"] = true;
        VerifyMethod.Invoke(null, new object[] { result, args, new Rectangle(-10, 30, 90, 80), before, after });
        Check((string)result["receipt"] == "unchanged", "helper preserves unrelated receipt");
        Check((bool)result["effectVerified"] == false, "pixels never certify business effect");
        return result;
    }
    static object Call(string name, params object[] args)
    {
        try { return Worker.GetMethod(name, BindingFlags.Public | Flags).Invoke(null, args); }
        catch (TargetInvocationException error) { throw error.InnerException; }
    }
    static void FailedCopy()
    {
        Check(Call("FrameSignatureRect", 0, 0, 40, 40, 8) == null, "BitBlt failure is unavailable sample");
        Check(failedPixelCopyCalls == 1, "failed copy reached stub, not an earlier allocation failure");
        using (var process = System.Diagnostics.Process.GetCurrentProcess())
        {
            uint before = GetGuiResources(process.Handle, 0);
            for (int i = 0; i < 12; i++) Check(Call("FrameSignatureRect", 0, 0, 40, 40, 8) == null, "every failed copy returns null");
            uint after = GetGuiResources(process.Handle, 0);
            Check(failedPixelCopyCalls == 13, "all samples used fake BitBlt and copied zero pixels");
            Check(after <= before + 1, "failed-copy GDI objects/DCs do not accumulate");
        }
    }
    static void ReceiverSequence()
    {
        // Same internal sender/receiver seams as native-hardening-fixture. A
        // non-running thread prevents any visible Glow renderer from starting.
        typeof(Glow).GetField("_thread", Flags).SetValue(null, new Thread(delegate() { }));
        IntPtr target = new IntPtr(42), current = target;
        uint currentPid = 7;
        bool exists = true;
        var sent = new List<INPUT>();
        Action afterAccepted = null;
        Program.InputSender = delegate(INPUT[] batch) { sent.AddRange(batch); if (afterAccepted != null) afterAccepted(); return (uint)batch.Length; };
        Program.InputForeground = delegate { return target; };
        Program.InputPointReceiver = delegate { return current; };
        Program.InputWindowExists = delegate(IntPtr h) { return exists && h == target; };
        Program.InputWindowPid = delegate(IntPtr h) { return currentPid; };
        Action reset = delegate {
            afterAccepted = null; Program.ReleaseOwnedInputs(); Call("EndActuationForReadback");
            sent.Clear(); current = target; currentPid = 7; exists = true;
            Worker.GetField("_operationDispatched", Flags).SetValue(null, false);
        };
        Func<Exception> run = delegate {
            try { Call("FixtureShiftClickSequence", target, 7U, 1); return null; }
            catch (Exception error) { return error; }
        };
        try {
            reset();
            Check(run() == null && sent.Count == 4, "guarded shift click delivers four balanced accepted events");
            Check(sent.Count == 4 && sent[0].type == Native.INPUT_KEYBOARD && sent[0].u.ki.wVk == 0x10 && (sent[0].u.ki.dwFlags & Native.KEYEVENTF_KEYUP) == 0, "production sequence starts with shift down");
            Check(sent.Count == 4 && sent[1].u.mi.dwFlags == Native.MOUSEEVENTF_LEFTDOWN && sent[2].u.mi.dwFlags == Native.MOUSEEVENTF_LEFTUP, "production sequence contains click down/up");
            Check(sent.Count == 4 && sent[3].type == Native.INPUT_KEYBOARD && sent[3].u.ki.wVk == 0x10 && (sent[3].u.ki.dwFlags & Native.KEYEVENTF_KEYUP) != 0, "production sequence ends with shift up");
            Check(Program.ReleaseOwnedInputs() == 0, "normal sequence leaves no owned downs");
            Check(Worker.GetField("_receiverCheck", Flags).GetValue(null) == null, "guard scope restores prior receiver check");

            reset(); current = new IntPtr(99);
            Exception blocked = run();
            Check(blocked != null && (string)blocked.Data["code"] == "INPUT_TARGET_CHANGED" && sent.Count == 0, "changed receiver refuses before shift down");

            reset(); afterAccepted = delegate { if (sent.Count == 1) current = new IntPtr(99); };
            blocked = run(); afterAccepted = null;
            Check(blocked != null && (string)blocked.Data["code"] == "INPUT_TARGET_CHANGED" && sent.Count == 1, "receiver change after shift down prevents click down");
            Check(Program.ReleaseOwnedInputs() == 1 && sent.Count == 2 && sent[1].u.ki.wVk == 0x10 && (sent[1].u.ki.dwFlags & Native.KEYEVENTF_KEYUP) != 0, "cleanup releases only accepted shift down");
            Check(Worker.GetField("_receiverCheck", Flags).GetValue(null) == null, "exception exits production guard scope");

            reset(); afterAccepted = delegate { if (sent.Count == 2) current = new IntPtr(99); };
            blocked = run(); afterAccepted = null;
            Check(blocked != null && sent.Count == 2, "receiver change after click down prevents remaining normal sequence");
            Check(Program.ReleaseOwnedInputs() == 2 && sent.Count == 4, "cleanup releases exactly accepted shift and mouse downs");
            bool shiftUp = false, mouseUp = false;
            for (int i = 2; i < sent.Count; i++) {
                if (sent[i].type == Native.INPUT_KEYBOARD && sent[i].u.ki.wVk == 0x10 && (sent[i].u.ki.dwFlags & Native.KEYEVENTF_KEYUP) != 0) shiftUp = true;
                if (sent[i].type == Native.INPUT_MOUSE && sent[i].u.mi.dwFlags == Native.MOUSEEVENTF_LEFTUP) mouseUp = true;
            }
            Check(shiftUp && mouseUp, "cleanup ups bypass stale receiver without invented extra input");

            reset(); afterAccepted = delegate { if (sent.Count == 1) currentPid = 8; };
            blocked = run(); afterAccepted = null;
            Check(blocked != null && (string)blocked.Data["code"] == "INPUT_TARGET_CHANGED" && sent.Count == 1, "recycled HWND identity stops click even when point matches");
            Program.ReleaseOwnedInputs();
            reset(); exists = false; blocked = run();
            Check(blocked != null && sent.Count == 0, "missing target refuses before any accepted event");
            Check(physicalInputCalls == 0, "all sequence and cleanup events stayed inside fake sender");
        } finally { afterAccepted = null; Program.ReleaseOwnedInputs(); Call("EndActuationForReadback"); }
    }
    public static void Main()
    {
        Rectangle desktop = new Rectangle(-1920, -1000, 4480, 2600);
        Check(Region(D("verificationRegion", Box(-100, 50, 80, 60)), desktop) == new Rectangle(-100, 50, 80, 60), "negative monitor coordinates retained");
        Check(Region(D("verificationRegion", Box(-40, 100, 80, 100)), desktop) == new Rectangle(-40, 100, 80, 100), "region crossing monitor origin retained");
        Check(Region(D("verificationRegion", Box(-2000, -1100, 200, 200)), desktop) == new Rectangle(-1920, -1000, 120, 100), "left/top partial intersection clipped");
        Check(Region(D("verificationRegion", Box(2500, 1550, 200, 200)), desktop) == new Rectangle(2500, 1550, 60, 50), "right/bottom partial intersection clipped");
        Check(Region(D("verificationRegion", Box(-10, -10, 1, 1)), desktop) == new Rectangle(-10, -10, 1, 1), "small valid geometry is not invented as sampled availability");
        Check(Region(D(), new Rectangle(-100, -20, 200, 100), -100, -20) == new Rectangle(-100, -20, 200, 100), "default neighborhood bounded by small desktop");
        Check(Region(D(), desktop, -1919, -999) == new Rectangle(-1920, -1000, 340, 340), "default neighborhood clamps negative edge");
        Check(Region(D("verificationRegion", Box(-4096, 0, 4096, 4096)), new Rectangle(-4096, 0, 8192, 8192)) == new Rectangle(-4096, 0, 4096, 4096), "exact 16M pixel boundary accepted");
        Refused(Box(2560, 0, 10, 10), "touching outside right edge");
        Refused(Box(-2100, 0, 100, 100), "wholly outside left edge");
        Refused(Box(0, 0, 0, 10), "zero width");
        Refused(Box(0, 0, 10, -1), "negative height");
        Refused(Box(0.5, 0, 10, 10), "fractional origin");
        Refused(Box(Double.NaN, 0, 10, 10), "NaN");
        Refused(Box(0, 0, Double.PositiveInfinity, 10), "infinite size");
        Refused(Box(Int32.MinValue, 0, 10, 10), "minimum sentinel");
        Refused(Box(Int32.MaxValue - 2, 0, 4, 10), "right edge overflow");
        Refused(Box(0, Int32.MaxValue - 2, 10, 4), "bottom edge overflow");
        Refused(Box(0, 0, 4097, 4096), "above area cap");
        Refused(Box(0, 0, Int32.MaxValue, Int32.MaxValue), "multiplication overflow cannot bypass area cap");
        Refused(Box("0", 0, 10, 10), "numeric string is not normalized native coordinate");
        Refused(Box(true, 0, 10, 10), "boolean coordinate");
        Refused(D("x", 1, "y", 2, "width", 3), "missing height");
        Refused(null, "null rectangle");
        Refused("1,2,3,4", "raw string cannot bypass JS normalization");

        var changed = Verified(new byte[] { 0, 0, 0, 0 }, new byte[] { 20, 0, 0, 0 });
        Check((bool)changed["verificationAvailable"] && Convert.ToDouble(changed["changedPct"]) == 25, "known sampled change percentage");
        Check((string)changed["verificationSource"] == "requested-region", "requested source reported");
        Check(changed.ContainsKey("requestedVerificationRegion"), "requested rectangle retained beside effective clipped rectangle");
        var effective = (Dictionary<string, object>)changed["verificationRegion"];
        Check((int)effective["x"] == -10 && (int)effective["width"] == 90, "effective clipped sample rectangle reported");
        Check(((string)changed["verificationNote"]).Contains("not semantic"), "change is not semantic success");
        var unchanged = Verified(new byte[] { 0, 5 }, new byte[] { 8, 5 }, false);
        Check(Convert.ToDouble(unchanged["changedPct"]) == 0 && (string)unchanged["verificationSource"] == "click-neighborhood", "threshold and default source honest");
        Check(unchanged.ContainsKey("warning") && ((string)unchanged["warning"]).Contains("before retrying"), "no-change warning does not demand replay");
        var explicitCheck = Verified(new byte[] { 0 }, new byte[] { 0 }, true, true);
        Check(!explicitCheck.ContainsKey("warning"), "explicit verify avoids unsolicited default warning");
        foreach (byte[][] samples in new byte[][][] {
            new byte[][] { null, new byte[] { 1 } }, new byte[][] { new byte[] { 1 }, null },
            new byte[][] { new byte[] { 1 }, new byte[] { 1, 2 } }, new byte[][] { new byte[0], new byte[0] } })
        {
            var unavailable = Verified(samples[0], samples[1]);
            Check(!(bool)unavailable["verificationAvailable"], "null/mismatched/empty samples unavailable");
            Check(!unavailable.ContainsKey("changedPct"), "unavailable samples never invent change percentage");
            Check(((string)unavailable["verificationNote"]).Contains("unavailable"), "unavailable sample explicitly explained");
        }
        FailedCopy();
        ReceiverSequence();
        Console.WriteLine(new JavaScriptSerializer().Serialize(new { ok = Failures.Count == 0, checks = checks, failures = Failures,
            failedPixelCopyCalls = failedPixelCopyCalls, physicalInputCalls = physicalInputCalls }));
    }
}
