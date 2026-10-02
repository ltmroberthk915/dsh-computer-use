using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Web.Script.Serialization;
using DshComputerUse.Worker;

public static class CoactiveFixture
{
    static List<object> rows = new List<object>();
    static int assertions;
    static void Check(bool pass, string name) { assertions++; if (!pass) throw new Exception(name); }
    static void Case(string name, Action body) { body(); rows.Add(new { name = name, pass = true }); }
    sealed class Keys
    {
        public HashSet<ushort> down = new HashSet<ushort>();
        public List<string> events = new List<string>();
        public int sends, failAt, failCleanup;
        public void Send(ushort key, bool up)
        {
            if (++sends == failAt) throw new Exception("injected send failure");
            events.Add((up ? "up:" : "down:") + key);
            if (up) down.Remove(key); else down.Add(key);
        }
        public void Release(ushort key)
        {
            events.Add("cleanup:" + key);
            if (key == failCleanup) throw new Exception("injected cleanup failure");
            down.Remove(key);
        }
        public void Run(Action hold) { KeyboardChord.Run(new ushort[] { 17, 65 }, Send, Release, down.Contains, hold); }
    }
    sealed class MemoryClipboard : IClipboardAccess
    {
        public List<ClipboardBytes> value = Text("old-text");
        public uint version = 1;
        public bool locked, rejectSnapshot, failWriteOnce, failRestore, copyOnRestore;
        public int writes;
        List<ClipboardBytes> queued;
        public static List<ClipboardBytes> Text(string text) { return new List<ClipboardBytes> { new ClipboardBytes(13, Encoding.Unicode.GetBytes(text + "\0")) }; }
        public string ReadText() { return Encoding.Unicode.GetString(value[0].Bytes).TrimEnd('\0'); }
        public void HumanCopy(string text)
        {
            if (locked) queued = Text(text);
            else { value = Text(text); version++; }
        }
        public IClipboardSession Open()
        {
            if (locked) throw new Exception("already locked");
            locked = true; return new Session(this);
        }
        sealed class Session : IClipboardSession
        {
            MemoryClipboard m;
            public Session(MemoryClipboard m) { this.m = m; }
            public uint Sequence { get { Check(m.locked, "sequence under lock"); return m.version; } }
            public List<ClipboardBytes> Snapshot()
            {
                Check(m.locked, "snapshot under lock");
                if (m.rejectSnapshot) throw new Exception("unsupported clipboard format");
                return m.value.Select(f => new ClipboardBytes(f.Format, (byte[])f.Bytes.Clone())).ToList();
            }
            public void Replace(List<ClipboardBytes> formats)
            {
                Check(m.locked, "replace under lock");
                m.writes++;
                if (m.failWriteOnce) { m.failWriteOnce = false; throw new Exception("injected write failure"); }
                if (m.failRestore && m.writes > 1) throw new Exception("injected restoration failure");
                if (m.copyOnRestore && m.writes > 1) m.HumanCopy("human-during-restore");
                m.value = formats.Select(f => new ClipboardBytes(f.Format, (byte[])f.Bytes.Clone())).ToList(); m.version++;
            }
            public void Dispose()
            {
                m.locked = false;
                if (m.queued != null) { m.value = m.queued; m.queued = null; m.version++; }
            }
        }
    }
    public static void Main()
    {
        for (int failure = 1; failure <= 4; failure++)
        {
            int point = failure;
            Case("key-send-failure-" + point, delegate {
                var keys = new Keys { failAt = point }; bool threw = false;
                try { keys.Run(delegate { }); } catch (Exception e) { threw = e.Message.Contains("injected send failure"); }
                Check(threw, "original failure remains"); Check(keys.down.Count == 0, "accepted keys released");
                Check(!keys.events.Contains("cleanup:65") || point >= 3, "never release a key not pressed");
            });
        }
        Case("key-normal-order", delegate {
            var keys = new Keys(); keys.Run(delegate { });
            Check(string.Join(",", keys.events.ToArray()) == "down:17,down:65,up:65,up:17", "chord order retained");
        });
        Case("key-cancel-during-hold", delegate {
            var keys = new Keys(); bool threw = false;
            try { keys.Run(delegate { throw new Exception("INTERRUPTED"); }); } catch (Exception e) { threw = e.Message == "INTERRUPTED"; }
            Check(threw && keys.down.Count == 0, "cancellation releases all scope keys");
            Check(keys.events[2] == "cleanup:65" && keys.events[3] == "cleanup:17", "cleanup reverse order");
        });
        Case("key-cleanup-failure-visible", delegate {
            var keys = new Keys { failAt = 3, failCleanup = 65 }; string error = "";
            try { keys.Run(delegate { }); } catch (Exception e) { error = e.Message; }
            Check(error.Contains("KEY_CLEANUP_FAILED") && error.Contains("injected send failure"), "both errors retained");
            Check(keys.down.SetEquals(new ushort[] { 65 }), "later cleanup still attempted");
        });
        Case("human-held-key-untouched", delegate {
            var keys = new Keys(); keys.down.Add(17); string outcome = "";
            try { keys.Run(delegate { }); } catch (Exception e) { outcome = (string)e.Data["outcome"]; }
            Check(outcome == "not-dispatched" && keys.events.Count == 0 && keys.down.Contains(17), "preheld refusal");
        });
        Case("empty-clipboard-restored", delegate {
            var m = new MemoryClipboard { value = new List<ClipboardBytes>() };
            var lease = ClipboardLease.Begin(m, "agent-paste"); Check(lease.StillOwned(), "agent owns clip");
            Check(lease.Restore() == "restored" && m.value.Count == 0, "empty state restored");
        });
        Case("text-clipboard-restored", delegate {
            var m = new MemoryClipboard(); var lease = ClipboardLease.Begin(m, "agent-paste");
            Check(m.ReadText() == "agent-paste", "paste payload available");
            Check(lease.Restore() == "restored" && m.ReadText() == "old-text", "old text restored");
            Check(lease.Restore() == "already-finished" && m.writes == 2, "restore once only");
        });
        Case("rich-format-bytes-retained", delegate {
            var m = new MemoryClipboard(); var rich = Encoding.UTF8.GetBytes("{\\rtf1 \\b rich\\b0 }");
            m.value.Add(new ClipboardBytes(0xC123, rich));
            var lease = ClipboardLease.Begin(m, "agent-paste"); lease.Restore();
            Check(m.value.Count == 2 && m.value[1].Bytes.SequenceEqual(rich), "RTF bytes retained exactly");
        });
        Case("concurrent-copy-wins", delegate {
            var m = new MemoryClipboard(); var lease = ClipboardLease.Begin(m, "agent-paste");
            m.HumanCopy("human-new"); Check(!lease.StillOwned(), "ownership loss seen before paste");
            Check(lease.Restore() == "skipped-changed" && m.ReadText() == "human-new" && m.writes == 1, "new copy not overwritten");
        });
        Case("identical-text-new-version-wins", delegate {
            var m = new MemoryClipboard(); var lease = ClipboardLease.Begin(m, "agent-paste");
            m.HumanCopy("agent-paste"); Check(lease.Restore() == "skipped-changed", "sequence not string equality");
        });
        Case("copy-during-restore-waits-for-lock", delegate {
            var m = new MemoryClipboard { copyOnRestore = true }; var lease = ClipboardLease.Begin(m, "agent-paste");
            lease.Restore(); Check(m.ReadText() == "human-during-restore", "exclusive restore cannot overwrite later copy");
        });
        Case("unsupported-snapshot-no-mutation", delegate {
            var m = new MemoryClipboard { rejectSnapshot = true }; bool threw = false;
            try { ClipboardLease.Begin(m, "agent-paste"); } catch { threw = true; }
            Check(threw && m.writes == 0 && m.ReadText() == "old-text" && !m.locked, "snapshot failure before mutation");
        });
        Case("initial-write-failure-rollback", delegate {
            var m = new MemoryClipboard { failWriteOnce = true }; bool threw = false;
            try { ClipboardLease.Begin(m, "agent-paste"); } catch { threw = true; }
            Check(threw && m.ReadText() == "old-text" && !m.locked, "write failure restores old bytes");
        });
        Case("restore-failure-not-success", delegate {
            var m = new MemoryClipboard { failRestore = true }; var lease = ClipboardLease.Begin(m, "agent-paste"); bool threw = false;
            try { lease.Restore(); } catch { threw = true; }
            Check(threw && !m.locked, "restoration failure explicit and lock released");
        });
        Case("unavailable-sequence-no-mutation", delegate {
            var m = new MemoryClipboard { version = 0 }; bool threw = false;
            try { ClipboardLease.Begin(m, "agent-paste"); } catch { threw = true; }
            Check(threw && m.writes == 0 && !m.locked, "zero sequence does not grant ownership");
        });
        Case("native-format-allowlist", delegate {
            Check(NativeClipboardAccess.Supported(13, ""), "unicode");
            Check(NativeClipboardAccess.Supported(0xC001, "Rich Text Format"), "RTF");
            Check(NativeClipboardAccess.Supported(0xC002, "HTML Format"), "HTML");
            Check(!NativeClipboardAccess.Supported(2, ""), "GDI bitmap refused");
            Check(!NativeClipboardAccess.Supported(0xC003, "private-opaque"), "unknown registered format refused");
        });
        Case("production-hold-observes-cancel", delegate {
            var assembly = typeof(KeyboardChord).Assembly;
            var program = assembly.GetType("DshComputerUse.Worker.Program");
            var panic = assembly.GetType("DshComputerUse.Worker.Panic");
            var flag = panic.GetField("_stopped", BindingFlags.NonPublic | BindingFlags.Static);
            var hold = program.GetMethod("WaitForKeyHold", BindingFlags.NonPublic | BindingFlags.Static);
            var thread = new Thread(delegate() { Thread.Sleep(35); flag.SetValue(null, true); });
            bool interrupted = false; var timer = Stopwatch.StartNew(); thread.Start();
            try { hold.Invoke(null, new object[] { 2000 }); }
            catch (TargetInvocationException e) { interrupted = e.InnerException.Message.Contains("INTERRUPTED"); }
            finally { thread.Join(); flag.SetValue(null, false); }
            Check(interrupted && timer.ElapsedMilliseconds < 1000, "hold ends on stop instead of waiting full duration");
            rows.Add(new { name = "hold-cancel-timing", milliseconds = timer.ElapsedMilliseconds, scope = "compiled loop and injected flag; no OS input" });
        });
        Console.WriteLine(new JavaScriptSerializer().Serialize(new { cases = rows, assertions = assertions,
            scope = "Compiled production C# scopes and hold loop, injected keyboard/clipboard devices. No native input, clipboard access, worker Main or hooks." }));
    }
}
