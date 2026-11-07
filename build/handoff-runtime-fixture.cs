using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Threading;
using DshComputerUse.Worker;

// Runtime regression fixture for issues #3 and #4 on the production worker:
// idle physical input must stay free, and an actuation-time handoff must publish
// handoff:yielding and handoff:idle on its own. No OS input is generated.
static class HandoffRuntimeFixture
{
    static Type T(string name) { return typeof(Program).Assembly.GetType("DshComputerUse.Worker." + name); }
    static object Invoke2(Type t, string name, params object[] args)
    {
        MethodInfo m = null;
        foreach (var c in t.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
            if (c.Name == name && c.GetParameters().Length == args.Length) { m = c; break; }
        if (m == null) throw new Exception("no method " + t.Name + "." + name);
        return m.Invoke(null, args);
    }
    static void SetField(Type t, string name, object value)
    {
        var f = t.GetField(name, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        if (f != null) f.SetValue(null, value);
    }
    static object Coop() { return Invoke2(T("Panic"), "CooperationState"); }
    static string Phase(object state) { return (string)((Dictionary<string, object>)state)["phase"]; }
    static long Revision(object state) { return Convert.ToInt64(((Dictionary<string, object>)state)["revision"]); }
    static string Json(object o) { return new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(o); }
    static bool WaitIdle(int ms)
    {
        var watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < ms)
        {
            if (Phase(Coop()) == "idle") return true;
            Thread.Sleep(80);
        }
        return Phase(Coop()) == "idle";
    }
    static readonly List<string> Events = new List<string>();
    static int Main()
    {
        var glowThread = typeof(Glow).GetField("_thread", BindingFlags.Static | BindingFlags.NonPublic);
        if (glowThread != null) glowThread.SetValue(null, new Thread(delegate() { }));
        var panic = T("Panic");
        // Keep notifications observable: Notify() is what carries handoff:yielding/idle
        // to the JS core. The collector replaces stdout so this fixture stays quiet.
        Invoke2(panic, "SetQuiet", false);
        Panic.Changed = delegate(string kind, string why)
        {
            if (kind == "handoff") lock (Events) Events.Add(why);
        };
        SetField(panic, "_armed", true);
        SetField(panic, "CycleLit", true);
        SetField(panic, "_exited", false);
        SetField(panic, "_controlsReleased", false);

        var poll = new Thread(delegate() { try { Invoke2(panic, "PollThread"); } catch { } });
        poll.IsBackground = true;
        poll.Start();
        Thread.Sleep(200);

        // #3: an idle physical click (the approval card) and idle typing must not
        // start a handoff or bump the takeover revision.
        Invoke2(panic, "RecordHumanInput", 1, true, false);
        Invoke2(panic, "RecordHumanInput", 1, false, true);
        Invoke2(panic, "RecordHumanInput", 0x41, true, false);
        Invoke2(panic, "RecordHumanInput", 0x41, false, true);
        Thread.Sleep(300);
        var idleInput = Coop();

        // #4: physical keyboard input during actuation starts a handoff; after the
        // keys are released and three quiet seconds pass, the worker itself must
        // publish idle and the JS-visible event stream must contain it.
        lock (Events) Events.Clear();
        Invoke2(panic, "BeginActuation");
        Invoke2(panic, "RecordHumanInput", 0x41, true, false);
        Invoke2(panic, "RecordHumanInput", 0x41, false, true);
        Thread.Sleep(120);
        var typed = Coop();
        Invoke2(panic, "EndActuation");
        bool normalIdle = WaitIdle(4500);
        Thread.Sleep(150);
        var normal = Coop();
        string[] events;
        lock (Events) events = Events.ToArray();

        Console.WriteLine(Json(new Dictionary<string, object> {
            { "idleInput", idleInput }, { "typed", typed },
            { "normalIdle", normalIdle }, { "normal", normal }, { "events", events }
        }));
        return 0;
    }
}
