// Production cursor classification and precondition receipts, with fake handles.
// No desktop input, cursor movement, windows, hooks or worker Main.
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Web.Script.Serialization;

public static class CursorFixture {
    static readonly Type Worker = typeof(DshComputerUse.Worker.Program);
    static readonly BindingFlags Flags = BindingFlags.NonPublic | BindingFlags.Static;
    static int checks;
    static void Check(bool yes, string name) { checks++; if (!yes) throw new Exception(name); }
    static string Shape(int handle) {
        return (string)Worker.GetMethod("StandardCursorShape", Flags).Invoke(null,
            new object[] { new IntPtr(handle), new Func<int, IntPtr>(id => new IntPtr(id + 100000)) });
    }
    static bool Matches(string expected, string actual, bool visible) {
        return (bool)Worker.GetMethod("CursorMatches", Flags).Invoke(null, new object[] { expected, actual, visible });
    }
    static Dictionary<string, object> Evidence(bool available, bool visible, int handle) {
        return (Dictionary<string, object>)Worker.GetMethod("CursorEvidence", Flags).Invoke(null,
            new object[] { available, visible, new IntPtr(handle), new Func<int, IntPtr>(id => {
                if (!available || !visible) throw new Exception("hidden/unavailable evidence must not inspect a stale handle");
                return new IntPtr(id + 100000);
            }) });
    }
    static Dictionary<string, object> Verify(string expected, Dictionary<string, object> actual) {
        return (Dictionary<string, object>)Worker.GetMethod("CheckDragCursor", Flags).Invoke(null, new object[] { expected, actual });
    }
    static Exception Refusal(string expected, Dictionary<string, object> actual) {
        try { Verify(expected, actual); } catch (TargetInvocationException error) { return error.InnerException; }
        throw new Exception("expected cursor refusal: " + expected);
    }
    static Dictionary<string, object> Receipt(Exception error) {
        return (Dictionary<string, object>)Worker.GetMethod("Err", Flags, null, new Type[] { typeof(Exception) }, null).Invoke(null, new object[] { error });
    }
    public static void Main() {
        int[] ids = { 32644, 32645, 32643, 32642, 32646, 32512, 32513, 32649, 32514, 32515, 32648, 32650, 32651 };
        string[] shapes = { "resize-ew", "resize-ns", "resize-nesw", "resize-nwse", "move", "arrow", "ibeam", "hand", "wait", "cross", "not-allowed", "app-starting", "help" };
        for (int i = 0; i < ids.Length; i++) Check(Shape(ids[i] + 100000) == shapes[i], shapes[i]);
        Check(Shape(0) == "unknown", "zero handle");
        Check(Shape(123456) == "unknown", "custom handles are not guessed");
        foreach (string shape in new string[] { "resize-ew", "resize-ns", "resize-nesw", "resize-nwse" })
            Check(Matches("resize", shape, true), "resize family " + shape);
        Check(Matches("resize-ew", "resize-ew", true), "exact expectation");
        Check(!Matches("resize-ew", "resize-ns", true), "wrong resize direction");
        Check(!Matches("resize", "arrow", true), "arrow fails resize");
        Check(!Matches("resize", "unknown", true), "custom/unknown fails closed");
        Check(!Matches("unknown", "unknown", true), "unknown cannot self-certify");
        Check(!Matches("resize-ew", "resize-ew", false), "hidden cursor cannot confirm handle");
        Check(Matches("", "unknown", false), "expectation remains optional");
        var standard = Evidence(true, true, 132644);
        var unrecognized = Evidence(true, true, 123456);
        var hidden = Evidence(true, false, 132644);
        var unavailable = Evidence(false, true, 132644);
        Check((string)standard["classification"] == "standard" && (string)standard["shape"] == "resize-ew", "standard handle evidence");
        Check((string)unrecognized["classification"] == "unrecognized" && (string)unrecognized["shape"] == "unknown", "unknown handle is not labelled custom or resize");
        Check(((string)unrecognized["note"]).Contains("does not prove a hit or a miss"), "unknown evidence does not imply a target miss");
        Check((string)hidden["classification"] == "not-visible" && (string)hidden["shape"] == "unknown", "hidden cached handle is not shape evidence");
        Check((string)unavailable["classification"] == "unavailable" && !(bool)unavailable["visible"], "API failure cannot retain a visible flag");
        var matched = Verify(" RESIZE-EW ", standard);
        Check((string)matched["status"] == "matched" && (string)matched["expected"] == "resize-ew", "standard shape verified and normalized");
        Check((string)Verify("resize", standard)["status"] == "matched", "standard resize family verified");
        foreach (var actual in new[] { standard, unrecognized, hidden, unavailable }) {
            var optional = Verify(null, actual);
            Check((string)optional["status"] == "not-requested" && optional["expected"] == null, "optional never masquerades as matched");
        }
        Worker.GetField("_operationDispatched", Flags).SetValue(null, true);
        var error = (Exception)Worker.GetMethod("DragPrecondition", Flags).Invoke(null,
            new object[] { "CURSOR_MISMATCH", "Expected resize-ew, observed arrow." });
        Check((string)error.Data["outcome"] == "unknown", "pointer already moved is not reported as no input");
        Check((bool)error.Data["dragStarted"] == false, "no button press receipt");
        error.Data["expectedCursor"] = "resize-ew";
        error.Data["actualCursor"] = new Dictionary<string, object> { { "shape", "arrow" } };
        var receipt = Receipt(error);
        Check((string)receipt["code"] == "CURSOR_MISMATCH" && !(bool)receipt["dragStarted"], "serialized error retains drag state");
        Check(receipt.ContainsKey("expectedCursor") && receipt.ContainsKey("actualCursor"), "serialized cursor evidence");
        var arrowError = Refusal("resize-ew", Evidence(true, true, 132512));
        var arrowReceipt = Receipt(arrowError);
        Check((string)((Dictionary<string, object>)arrowReceipt["cursorCheck"])["status"] == "mismatched", "recognized arrow is a genuine disagreement");
        Check(arrowError.Message.Contains("observed standard cursor arrow") && !arrowError.Message.Contains("Cannot verify"), "known mismatch explains actual disagreement");
        foreach (var actual in new[] { unrecognized, hidden, unavailable }) {
            var refused = Refusal("resize-ew", actual);
            var detail = Receipt(refused);
            Check((string)detail["code"] == "CURSOR_MISMATCH", "compatibility code retained");
            Check((string)((Dictionary<string, object>)detail["cursorCheck"])["status"] == "unverifiable", "missing shape evidence is unverifiable");
            Check(refused.Message.Contains("Cannot verify") && refused.Message.Contains("not proof of an incorrect target"), "unknown refusal does not misdiagnose target");
            Check(!(bool)detail["dragStarted"] && (string)detail["outcome"] == "unknown", "unverifiable prevents button press but admits prior movement");
            Check((string)((Dictionary<string, object>)detail["actualCursor"])["classification"] == (string)actual["classification"], "serialized classification retained");
        }
        Check((string)((Dictionary<string, object>)Refusal("unknown", unrecognized).Data["cursorCheck"])["status"] == "unverifiable", "unknown cannot self-certify through new contract");
        Check((string)((Dictionary<string, object>)Refusal("col-resize", standard).Data["cursorCheck"])["status"] == "mismatched", "CSS aliases are not invented from standard handles");
        Console.WriteLine(new JavaScriptSerializer().Serialize(new { ok = true, checks = checks }));
    }
}
