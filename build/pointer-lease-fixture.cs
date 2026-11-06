using System;
using System.Collections.Generic;
using System.IO.MemoryMappedFiles;
using System.Reflection;
using DshComputerUse.Worker;

// This executable never calls PointerVisibilityLease.TryHide or GuardianMain.
// Only the production RunLease path with a fake backend and MMF parser run.
class LeaseSimulation
{
    static int passed;
    static void Check(bool value, string text)
    { if (!value) throw new Exception(text); passed++; Console.WriteLine("PASS " + text); }
    class Fake : PointerVisibilityLease.Backend
    {
        public readonly List<string> Calls = new List<string>();
        public bool InitOk = true, HideOk = true, RestoreOk = true, ThrowHide;
        public Action OnHide;
        public bool Initialize() { Calls.Add("init"); return InitOk; }
        public bool Show(bool visible)
        {
            Calls.Add(visible ? "show" : "hide");
            if (!visible && OnHide != null) OnHide();
            if (!visible && ThrowHide) throw new InvalidOperationException("fake failure");
            return visible ? RestoreOk : HideOk;
        }
        public void Uninitialize() { Calls.Add("uninit"); }
    }
    static PointerVisibilityLease.Request R(long seq, long stamp, bool on, bool revoked = false)
    { return new PointerVisibilityLease.Request(seq, stamp, on, revoked); }
    static PointerVisibilityLease.Outcome Run(Fake api, Func<long, PointerVisibilityLease.Request> request,
        Func<long, bool> alive = null, Action<long> advance = null, int step = 20)
    {
        long clock = 0; int loops = 0;
        return PointerVisibilityLease.RunLease(api, () => request(clock), () => clock,
            () => alive == null || alive(clock), () => {
                clock += step; if (advance != null) advance(clock);
                if (++loops > 200) throw new Exception("nonterminating lease");
            }, () => api.Calls.Add("ready"));
    }
    static void Sequence(Fake api, string expected, string text)
    { Check(String.Join(",", api.Calls) == expected, text + ": " + String.Join(",", api.Calls)); }
    static int Main()
    {
        var api = new Fake();
        var result = Run(api, t => t < 100 ? R(2, 0, true) : R(4, 100, false, true));
        Sequence(api, "init,ready,hide,show,uninit", "normal release restores once");
        Check(result.Success && result.RestoreConfirmed && result.Reason == "released", "release receipt");

        api = new Fake(); result = Run(api, t => R(2, 0, true));
        Check(result.Reason == "lease-expired", "identical snapshot does not renew lease");
        Sequence(api, "init,ready,hide,show,uninit", "lease expiry restores");

        api = new Fake(); result = Run(api, t => t == 0 ? R(2, 0, true) : R(4, t, true), step: 600);
        Check(result.Reason == "lease-expired", "fresh delayed request cannot revive expired lease");
        Sequence(api, "init,ready,hide,show,uninit", "expired episode never re-hides");

        api = new Fake(); result = Run(api, t => R(2, 0, true), t => t < 60);
        Check(result.Reason == "owner-exited" && result.RestoreConfirmed, "owner death restores");

        api = new Fake(); result = Run(api, t => R(2, 0, false));
        Sequence(api, "init,ready,uninit", "unused guard never calls visibility API");
        Check(result.Reason == "unused", "unused guard exits");

        api = new Fake(); result = Run(api, t => R(2, 0, false, true));
        Sequence(api, "init,ready,uninit", "release before any hide does not show");

        api = new Fake { InitOk = false }; result = Run(api, t => R(2, 0, true));
        Sequence(api, "init", "failed initialization does not touch visibility");
        Check(!result.Success, "init failure not success");

        api = new Fake { HideOk = false }; result = Run(api, t => R(2, 0, true));
        Sequence(api, "init,ready,hide,show,uninit", "failed hide still requests restoration");
        Check(!result.Success && result.RestoreConfirmed, "hide failure receipt remains failure");

        api = new Fake { ThrowHide = true }; result = Run(api, t => R(2, 0, true));
        Sequence(api, "init,ready,hide,show,uninit", "exception during hide restores in finally");

        api = new Fake { RestoreOk = false }; result = Run(api, t => R(2, 0, true));
        Check(!result.Success && !result.RestoreConfirmed, "restore failure remains explicit");

        api = new Fake(); bool revokedInApi = false; api.OnHide = () => revokedInApi = true;
        result = Run(api, t => revokedInApi ? R(4, t, false, true) : R(2, 0, true));
        Sequence(api, "init,ready,hide,show,uninit", "concurrent release restores without another poll");
        Check(result.Reason == "released-during-hide", "late hide is immediately followed by restore");

        api = new Fake(); int reads = 0;
        result = Run(api, t => ++reads == 1 ? R(2, 0, true) : R(4, t, false, true));
        Sequence(api, "init,ready,uninit", "release before hide recheck prevents hide");

        api = new Fake(); result = Run(api, t => t < 100 ? R(2, 0, true) : R(2, t, true));
        Check(result.Reason == "lease-expired", "same sequence with forged newer timestamp does not renew");

        api = new Fake(); result = Run(api, t => t < 100 ? R(4, 0, true) : R(2, t, true));
        Check(result.Reason == "lease-expired", "older sequence cannot renew");

        api = new Fake(); result = Run(api, t => R(2, 10, true));
        Sequence(api, "init,ready,uninit", "future timestamp does not hide");

        api = new Fake(); result = Run(api, t => t < 100 ? R(2, 0, true) : null);
        Check(result.Reason == "lease-expired", "incomplete snapshots cannot keep hidden lease alive");

        using (var map = MemoryMappedFile.CreateNew("Local\\DSH-CursorLease-test-" + Guid.NewGuid().ToString("N"), 128))
        using (var view = map.CreateViewAccessor())
        {
            view.Write(16, 1L); view.Write(24, 1); view.Write(28, 0); view.Write(32, 123L);
            Check(PointerVisibilityLease.ReadRequest(view) == null, "odd sequence rejects partial write");
            view.Write(16, 2L); var request = PointerVisibilityLease.ReadRequest(view);
            Check(request != null && request.Sequence == 2 && request.Stamp == 123 && request.Desired, "complete MMF snapshot accepted");
            view.Write(24, 7); Check(PointerVisibilityLease.ReadRequest(view) == null, "invalid desired flag rejected");
        }
        // No current session exists. These calls must perform no native work.
        PointerVisibilityLease.Show(); PointerVisibilityLease.Dispose();
        Check(PointerVisibilityLease.Fault == null, "empty Show and Dispose preserve no-session state");
        int waitMs = 0, kills = 0;
        Check(PointerVisibilityLease.ConfirmExit(() => true, () => kills++, ms => { waitMs = ms; return false; }) && kills == 0 && waitMs == 0,
            "already-exited process needs no kill or wait");
        Check(PointerVisibilityLease.ConfirmExit(() => false, () => kills++, ms => { waitMs = ms; return true; }) && waitMs == 1000,
            "owned process confirmation waits at most configured 1000 ms");
        Check(!PointerVisibilityLease.ConfirmExit(() => false, () => { }, ms => { waitMs = ms; return false; }) && waitMs == 1000,
            "termination timeout remains unconfirmed");
        int aliveReads = 0;
        Check(PointerVisibilityLease.ConfirmExit(() => ++aliveReads > 1, () => { throw new InvalidOperationException(); }, ms => false),
            "kill exit race may confirm by process handle");
        Check(!PointerVisibilityLease.ConfirmExit(() => false, () => { throw new InvalidOperationException(); }, ms => true),
            "kill failure cannot authorize emergency show");
        Console.WriteLine("PASS " + passed + " pure/isolated-MMF assertions; no native visibility or input API executed.");
        return 0;
    }
}
