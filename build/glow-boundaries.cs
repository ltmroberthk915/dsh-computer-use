using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Threading;
using DshComputerUse.Worker;

static class GlowBoundaries
{
    const BindingFlags Private = BindingFlags.NonPublic | BindingFlags.Static;
    public static bool GuardRefocus;

    public static void DryRuns(IntPtr target)
    {
        int sent = 0, id = 0;
        Program.InputSender = delegate(INPUT[] inputs) { sent += inputs.Length; return (uint)inputs.Length; };
        GuardRefocus = true;
        foreach (string op in new string[] { "key", "click", "move" })
        {
            foreach (bool signed in new bool[] { false, true })
            {
                var args = Program.Dict("dryRun", true, "expectHwnd", target.ToInt64());
                if (op == "key") args["combo"] = "a";
                if (op == "move") { args["x"] = 10; args["y"] = 10; }
                if (signed) args["__cycle"] = true;
                var result = GlowPumpFixture.Request(++id, op, args);
                if ((bool)result["ok"] || !(result["error"] as string).Contains("UNSUPPORTED_DRY_RUN") ||
                    sent != 0 || Panic.CycleLit || Program.DesktopOwned)
                    throw new Exception("unsafe dry run " + op + " signed=" + signed + ": accepted=" +
                        result["ok"] + " in-memory input records=" + sent);
            }
        }

        // The coordinate probe must stay read-only even if a previous action left
        // a different sticky target. A test hook refuses any attempted refocus.
        typeof(Program).GetField("_stickyHwnd", Private).SetValue(null, target);
        GlowPumpFixture.Target = IntPtr.Zero;
        var probe = GlowPumpFixture.Request(++id, "click", Program.Dict("dryRun", true, "x", 10, "y", 10));
        if (!(bool)probe["ok"] || !(bool)((Dictionary<string, object>)probe["data"])["dryRun"] || sent != 0)
            throw new Exception("coordinate probe failed or sent input");
        Console.WriteLine("ok signed and unsigned dry-run key, coordinate-less click and move refused; coordinate probe read-only; zero input");
    }

    public static void OneShotDrain()
    {
        MethodInfo drain = typeof(Panic).GetMethod("FinishOneShotControls");
        if (drain == null) throw new Exception("one-shot control finalization is missing");
        var pending = typeof(Panic).GetField("_pendingExits", Private);
        var entered = new ManualResetEvent(false);
        var finished = new ManualResetEvent(false);
        bool success = false;
        string marker = Environment.GetEnvironmentVariable("DSH_COMPUTER_USE_EXIT_FILE");
        // Stage the gap between marking a chord pending and enqueuing its work.
        pending.SetValue(null, 1);
        var thread = new Thread(delegate() {
            entered.Set();
            success = (bool)drain.Invoke(null, null) && File.Exists(marker);
            finished.Set();
        });
        thread.IsBackground = true; thread.Start();
        if (!entered.WaitOne(1000) || finished.WaitOne(200))
            throw new Exception("one-shot drain returned before pending work was even queued");
        Panic.QueueControl(delegate {
            try { Panic.Exit("one-shot test", "hook", "isolated fixture"); }
            finally { pending.SetValue(null, 0); }
        });
        if (!finished.WaitOne(2500) || !success || !Panic.Exited)
            throw new Exception("one-shot drain did not wait for durable EXITED");
        Console.WriteLine("ok drain waited across a 200ms registration-to-enqueue gap and returned only after durable EXITED");
    }
}
