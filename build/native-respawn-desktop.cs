using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

// Run the Node host on an isolated, never-switched-to Win32 desktop. The same
// helper verifies each worker's inherited desktop before the test issues input.
static class NativeRespawnDesktop
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public int cb;
        public string reserved, desktop, title;
        public int x, y, width, height, cols, rows, fill, flags;
        public short show, reservedBytes;
        public IntPtr reserved2, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcInfo { public IntPtr process, thread; public uint pid, tid; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, uint flags, uint access, IntPtr security);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetThreadDesktop(uint tid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder text, int bytes, out int needed);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string exe, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags,
        IntPtr env, string cwd, ref StartupInfo start, out ProcInfo child);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr proc, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr proc, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    static string DesktopName(uint tid)
    {
        var desktop = GetThreadDesktop(tid);
        var name = new StringBuilder(256);
        int bytes;
        if (desktop == IntPtr.Zero)
            throw new InvalidOperationException("No Win32 desktop is associated with thread " + tid);
        if (!GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out bytes))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not query desktop name for thread " + tid);
        return name.ToString();
    }

    static int Main(string[] args)
    {
        string name = Environment.GetEnvironmentVariable("DSH_RESPAWN_TEST_DESKTOP");
        if (String.IsNullOrWhiteSpace(name) || !name.StartsWith("DshRespawn-", StringComparison.Ordinal))
            throw new ArgumentException("Expected a private test desktop name");
        if (args[0] == "verify")
        {
            using (var worker = Process.GetProcessById(Int32.Parse(args[1])))
            {
                // The native worker's already-running primary thread owns its
                // assigned desktop. Fail before any window operation on mismatch.
                var primary = worker.Threads[0];
                foreach (ProcessThread thread in worker.Threads)
                    if (thread.StartTime < primary.StartTime) primary = thread;
                if (DesktopName((uint)primary.Id) != name)
                    throw new InvalidOperationException("Worker did not inherit the isolated desktop");
            }
            return 0;
        }
        if (args[0] != "run" || args.Length != 3) throw new ArgumentException("Missing Node executable or test script");
        var desktop = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, 0x01ff, IntPtr.Zero);
        if (desktop == IntPtr.Zero) throw new Win32Exception();
        try
        {
            var start = new StartupInfo();
            start.cb = Marshal.SizeOf(typeof(StartupInfo));
            start.desktop = "winsta0\\" + name;
            var command = new StringBuilder("\"" + args[1] + "\" \"" + args[2] + "\" --private-host");
            ProcInfo child;
            if (!CreateProcess(args[1], command, IntPtr.Zero, IntPtr.Zero, false, 0x08000000, IntPtr.Zero,
                    null, ref start, out child)) throw new Win32Exception();
            try
            {
                if (WaitForSingleObject(child.process, 60000) != 0)
                    throw new TimeoutException("Node host did not finish");
                uint code;
                if (!GetExitCodeProcess(child.process, out code)) throw new Win32Exception();
                return (int)code;
            }
            finally
            {
                if (WaitForSingleObject(child.process, 0) == 258) TerminateProcess(child.process, 1);
                CloseHandle(child.thread);
                CloseHandle(child.process);
            }
        }
        finally { CloseDesktop(desktop); }
    }
}
