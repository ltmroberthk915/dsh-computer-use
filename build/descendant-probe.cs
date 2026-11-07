// Probe for Program.ProcessDescendsFrom: compiles against the SHIPPED worker.cs (same as the
// test fixtures), so it verifies the deployed rule, not a re-implementation.
using DshComputerUse.Worker;

static class DescendantProbe
{
    static int Main(string[] args)
    {
        int child = int.Parse(args[0]);
        int ancestor = int.Parse(args[1]);
        bool related = Program.ProcessDescendsFrom(child, ancestor);
        System.Console.WriteLine("{\"child\":" + child + ",\"ancestor\":" + ancestor + ",\"descends\":" + (related ? "true" : "false") + "}");
        return related ? 0 : 1;
    }
}
