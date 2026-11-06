// Deterministically recreates the two production lock orders without input,
// hooks, a renderer or worker Main. Legacy mode reproduces the original cycle.
using System;
using System.Reflection;
using System.Threading;
using System.Web.Script.Serialization;

public static class HandoffLockFixture {
    public static void Main(string[] args) {
        bool legacy = args.Length > 0 && args[0] == "legacy";
        var panic = typeof(DshComputerUse.Worker.Program).Assembly.GetType("DshComputerUse.Worker.Panic");
        var flags = BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Static;
        var sync = panic.GetField("SyncLock", flags).GetValue(null);
        panic.GetField("CycleLit", flags).SetValue(null, true);
        panic.GetField("_controlsReleased", flags).SetValue(null, false);
        panic.GetField("_publishedHandoff", flags).SetValue(null, "waiting");
        var ownsSync = new ManualResetEvent(false);
        var inCallback = new ManualResetEvent(false);
        var enteringDisarm = new ManualResetEvent(false);
        bool emptyHandoffCredential = false;
        Action<string, string> callback = delegate(string kind, string why) {
            inCallback.Set(); enteringDisarm.WaitOne(3000);
            string pauseId = legacy ? (string)panic.GetProperty("TemporaryPauseId", flags).GetValue(null, null)
                : (string)panic.GetMethod("EventPauseId", flags).Invoke(null, new object[] { kind });
            emptyHandoffCredential = pauseId == "";
        };
        panic.GetField("Changed", flags).SetValue(null, callback);
        var a = new Thread(delegate() {
            lock (sync) {
                ownsSync.Set(); inCallback.WaitOne(3000); enteringDisarm.Set();
                panic.GetMethod("Disarm", flags).Invoke(null, null);
            }
        }); a.IsBackground = true;
        var b = new Thread(delegate() {
            ownsSync.WaitOne(); panic.GetMethod("PublishHandoff", flags).Invoke(null, null);
        }); b.IsBackground = true;
        a.Start(); b.Start();
        bool entered = enteringDisarm.WaitOne(3000), aDone = a.Join(500), bDone = b.Join(500);
        bool secureCompleted = false;
        if (!legacy) {
            lock (sync) {
                var secure = new Thread(delegate() {
                    secureCompleted = (string)panic.GetMethod("EventPauseId", flags).Invoke(null, new object[] { "secure" }) == "";
                }); secure.IsBackground = true; secure.Start(); secure.Join(500);
            }
        }
        Console.WriteLine(new JavaScriptSerializer().Serialize(new {
            legacy = legacy, entered = entered, bothCompleted = aDone && bDone,
            confirmedLegacyDeadlock = legacy && entered && !aDone && !bDone,
            emptyHandoffCredential = emptyHandoffCredential, secureCompleted = secureCompleted,
            desktopInput = false
        }));
    }
}
