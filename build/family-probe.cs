// family-probe.cs — verifies the SHIPPED SameInputFamily rule against real window handles.
// usage: family-probe.exe <hwndA> <hwndB>
// exit 0 = same family, 1 = different family.
using DshComputerUse.Worker;

static class FamilyProbe
{
    static int Main(string[] args)
    {
        long a = long.Parse(args[0]);
        long b = long.Parse(args[1]);
        bool same = Program.SameInputFamily(new System.IntPtr(a), new System.IntPtr(b));
        System.Console.WriteLine("{\"a\":" + a + ",\"b\":" + b + ",\"sameFamily\":" + (same ? "true" : "false") + "}");
        return same ? 0 : 1;
    }
}
