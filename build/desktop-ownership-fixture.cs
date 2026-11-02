using System;
using System.Reflection;
using DshComputerUse.Worker;
class DesktopOwnershipFixture
{
    static int Main(string[] args)
    {
        if (args.Length > 2 && args[2] == "boundary")
        {
            Environment.SetEnvironmentVariable("DSH_COMPUTER_USE_OWNER_FILE", args[0]);
            Environment.SetEnvironmentVariable("DSH_COMPUTER_USE_STOP_FILE", args[0] + ".STOP");
            Environment.SetEnvironmentVariable("DSH_COMPUTER_USE_EXIT_FILE", args[0] + ".EXITED");
            Environment.SetEnvironmentVariable("DSH_COMPUTER_USE_AUDIT_LOG", args[0] + ".audit");
            Program.InputSender = delegate(INPUT[] inputs) { throw new Exception("native input is forbidden in this test"); };
            var handle = typeof(Program).GetMethod("Handle", BindingFlags.Static | BindingFlags.NonPublic);
            int refused = 0;
            foreach (string op in new string[] { "key", "type", "capture", "resume", "calm", "abort", "indicator", "recover" })
            {
                try { handle.Invoke(null, new object[] { "{\"id\":1,\"op\":\"" + op + "\",\"args\":{}}" }); }
                catch (TargetInvocationException error)
                {
                    var inner = error.InnerException;
                    if ((string)inner.Data["code"] == "MACHINE_OWNED" && (string)inner.Data["outcome"] == "not-dispatched")
                    { refused++; continue; }
                    throw;
                }
                throw new Exception("foreign request reached worker body: " + op);
            }
            Console.WriteLine("boundaries:" + refused);
            return 0;
        }
        using (var lease = new DesktopOwnershipLease(args[0]))
        {
            string owner;
            bool accepted = lease.TryAcquire(args[1], out owner);
            Console.WriteLine(accepted ? "owned" : "busy:" + owner.Replace("\n", "|"));
            Console.Out.Flush();
            if (!accepted) return 2;
            if (args.Length > 2 && args[2] == "hold") Console.ReadLine();
            return 0;
        }
    }
}
