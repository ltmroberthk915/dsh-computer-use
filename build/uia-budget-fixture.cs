using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Web.Script.Serialization;
using DshComputerUse.Worker;

// Production generic traversal and budgets with synthetic providers only.
// No UIA provider, Windows desktop, worker Main, hook or input is started.
static class UiaBudgetFixture
{
    static int checks;
    sealed class Clock { public long Now; }
    sealed class Node {
        public string Name; public List<Node> Children = new List<Node>(); public Node Sibling;
        public Node(string name) { Name = name; }
        public Node Add(params Node[] children) {
            for(int i=0;i<children.Length;i++) { Children.Add(children[i]); if(i+1<children.Length) children[i].Sibling=children[i+1]; }
            return this;
        }
    }
    static void Check(bool value, string message) { checks++; if(!value) throw new Exception(message); }
    static Node First(Node n) { return n.Children.Count == 0 ? null : n.Children[0]; }
    static Node Next(Node n) { return n.Sibling; }
    static Program.UiReadBudget Budget(Clock c, int ms = 1200) { return new Program.UiReadBudget(ms, () => c.Now); }
    static bool Reason(Program.UiReadBudget budget, string reason)
    { return ((string[])budget.Report(120,6)["truncatedReasons"]).Contains(reason); }
    static void Scope(bool scoped, bool filtered, bool anchored, int depth, int nodes, string expected)
    {
        string error = null;
        try { Program.ValidateUiQueryScope(scoped,filtered,anchored,depth,nodes); }
        catch(Exception e) { error=e.Message; }
        Check(expected == null ? error == null : error != null && error.StartsWith(expected+":"), "scope: "+expected);
    }
    static void Entry(Dictionary<string,object> args, string expected)
    {
        string error = null;
        try { typeof(Program).GetMethod("Uia",BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,new object[]{args}); }
        catch(TargetInvocationException e) { error=e.InnerException.Message; }
        Check(error != null && error.StartsWith(expected+":"), "actual Uia entry refuses before provider: "+expected);
    }
    static void Main()
    {
        Scope(false,true,false,6,120,"UIA_SCOPE_REQUIRED");
        Scope(false,true,true,6,120,"UIA_SCOPE_REQUIRED");
        Scope(true,true,false,6,120,null);
        Scope(true,true,false,6,300,null);
        Scope(true,true,false,7,120,"UIA_ANCHOR_REQUIRED");
        Scope(true,true,false,6,301,"UIA_ANCHOR_REQUIRED");
        Scope(true,true,true,24,1200,null);
        Scope(true,false,false,2,40,null);
        Entry(new Dictionary<string,object>{{"query",true},{"nameContains","missing"}},"UIA_SCOPE_REQUIRED");
        Entry(new Dictionary<string,object>{{"hwnd",123456},{"query",true},{"automationId","exact"},{"depth",7}},"UIA_ANCHOR_REQUIRED");
        Entry(new Dictionary<string,object>{{"hwnd",123456},{"query",true},{"nameContains","some"},{"maxNodes",301}},"UIA_ANCHOR_REQUIRED");
        Check(Program.UiAnchorOwned(100,42,100,42),"matching window and PID accepted");
        Check(!Program.UiAnchorOwned(100,42,200,42),"other window same PID rejected");
        Check(!Program.UiAnchorOwned(100,42,100,99),"same numeric HWND wrong process rejected");
        Check(!Program.UiAnchorOwned(0,42,0,42),"missing anchor window rejected");
        Check(!Program.UiAnchorOwned(100,0,100,0),"unknown PID rejected");

        var clock=new Clock(); var budget=Budget(clock);
        var root=new Node("root").Add(new Node("a").Add(new Node("c")),new Node("b"));
        var found=Program.UiWalkBounded(root,6,120,80,budget,n=>true,First,Next);
        Check(String.Join(",",found.Select(n=>n.Name))=="root,a,b,c","incremental walker preserves breadth-first ordering");
        Check(budget.Scanned==4&&!budget.Truncated,"complete small tree is complete evidence");
        Check(budget.BudgetMs==1200,"default soft budget is 1200 ms");
        clock=new Clock();budget=Budget(clock);
        found=Program.UiWalkBounded(root,6,120,80,budget,n=>false,First,Next);
        Check(found.Count==0&&!budget.Truncated&&budget.Scanned==4,"complete empty query is distinguished from partial absence");

        // Lazy effectively-infinite siblings: no collection can be built first.
        clock=new Clock(); budget=Budget(clock); int siblings=0, children=0, visited=0;
        var wide=new Node("wide");
        found=Program.UiWalkBounded(wide,6,120,80,budget,n=>{visited++;return false;},
            n=>{children++;return Object.ReferenceEquals(n,wide)?new Node("child"):null;},
            n=>{siblings++;return new Node("next");});
        Check(budget.Scanned==120&&visited==120,"node limit bounds visited nodes on unlimited provider");
        Check(siblings<=119&&children<=120,"node limit also bounds incremental child acquisition");
        Check(found.Count==0&&Reason(budget,"max-nodes"),"missing match in truncated tree never proves absence");

        clock=new Clock(); budget=Budget(clock);
        found=Program.UiWalkBounded(root,1,120,80,budget,n=>true,First,Next);
        Check(found.Count==3&&budget.Scanned==3&&Reason(budget,"depth"),"depth boundary refuses hidden descendant completeness");

        clock=new Clock(); budget=Budget(clock);
        found=Program.UiWalkBounded(root,6,120,2,budget,n=>true,First,Next);
        Check(found.Count==2&&Reason(budget,"match-limit"),"match limit is explicitly partial");

        clock=new Clock(); budget=Budget(clock,100); int callbacks=0;
        found=Program.UiWalkBounded(root,6,120,80,budget,n=>{clock.Now+=40;callbacks++;return false;},
            n=>{clock.Now+=40;callbacks++;return First(n);},n=>{clock.Now+=40;callbacks++;return Next(n);});
        Check(Reason(budget,"deadline")&&budget.ElapsedMs==120,"deadline stops between provider calls");
        Check(callbacks==3,"no extra provider call after deadline");

        // A single provider is allowed to return AFTER budget. No claim of
        // preemption: its measured duration and truthful soft limit are retained.
        clock=new Clock(); budget=Budget(clock,100); callbacks=0;
        found=Program.UiWalkBounded(root,6,120,80,budget,n=>false,
            n=>{callbacks++;clock.Now+=2000;return First(n);},Next);
        var report=budget.Report(120,6);
        Check(callbacks==1&&budget.Calls==1&&budget.MaxCallMs==2000,"one slow COM-shaped call may exceed deadline and is measured");
        Check((long)report["elapsedMs"]==2000&&!(bool)report["singleCallInterruptible"],"metadata never claims arbitrary COM cancellation");
        Check(Reason(budget,"deadline")&&found.Count==0,"overrun returns partial evidence without retry");

        clock=new Clock(); budget=Budget(clock,100); clock.Now=100; callbacks=0;
        Program.UiWalkBounded(root,6,120,80,budget,n=>{callbacks++;return true;},First,Next);
        Check(callbacks==0&&budget.Scanned==0&&Reason(budget,"deadline"),"exhausted shared budget starts no provider call");

        clock=new Clock(); budget=Budget(clock,100); callbacks=0;
        Program.UiWalkBounded(root,6,120,80,budget,n=>{
            for(int i=0;i<20;i++) budget.Read(()=>{callbacks++;clock.Now+=15;return i;});return false;
        },First,Next);
        Check(callbacks==7&&budget.Calls==7&&Reason(budget,"deadline"),"detail materialization shares per-property budget");

        clock=new Clock(); budget=Budget(clock); callbacks=0;
        found=Program.UiWalkBounded(root,6,120,80,budget,n=>true,n=>{callbacks++;throw new Exception("provider failure");},Next);
        Check(found.Count==1&&callbacks==1&&Reason(budget,"provider-error"),"provider failure is partial evidence without retry");

        clock=new Clock(); budget=Budget(clock);
        Program.UiWalkBounded(new Node("first"),6,3,80,budget,n=>true,First,Next);
        Program.UiWalkBounded(root,6,3,80,budget,n=>true,First,Next);
        Check(budget.Scanned==3&&Reason(budget,"max-nodes"),"rebind passes share total node limit");
        clock=new Clock();budget=Budget(clock,1);Check(budget.BudgetMs==100,"minimum soft budget clamped");
        budget=Budget(clock,100000);Check(budget.BudgetMs==5000,"maximum soft budget clamped");
        Console.WriteLine(new JavaScriptSerializer().Serialize(new{ok=true,checks=checks,provider="synthetic",desktopInput=false,realUiaCalls=false}));
    }
}
