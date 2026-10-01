using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

public class PassiveForm : Form {
 protected override bool ShowWithoutActivation { get { return true; } }
}
public static class OptimizeProbe {
 static JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4000000 };
 static Type Worker = typeof(DshComputerUse.Worker.Program);
 static Form form; static long hwnd; static Button exact; static int hits; static string lastHit;
 static Dictionary<string,object> Args(params object[] pairs) { var d=new Dictionary<string,object>();for(int i=0;i<pairs.Length;i+=2)d[(string)pairs[i]]=pairs[i+1];return d; }
 static Dictionary<string,object> Call(string method,Dictionary<string,object> args) {
  try {return (Dictionary<string,object>)Worker.GetMethod(method,BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,new object[]{args});}
  catch(TargetInvocationException e){throw e.InnerException;}
 }
 static void Query(string name,Dictionary<string,object> args) {
  Call("Uia",args);var times=new List<double>();Dictionary<string,object> r=null;
  int repeats=Environment.GetEnvironmentVariable("DSH_UIA_BENCH_QUICK")=="1"?1:3;
  for(int i=0;i<repeats;i++){var sw=Stopwatch.StartNew();r=Call("Uia",args);times.Add(sw.Elapsed.TotalMilliseconds);}
  var flat=(List<object>)r["flat"];
  var matching=flat.Cast<Dictionary<string,object>>().Where(e=>(!args.ContainsKey("nameContains")||((string)e["name"]).IndexOf((string)args["nameContains"],StringComparison.OrdinalIgnoreCase)>=0)&&(!args.ContainsKey("role")||(string)e["role"]==(string)args["role"])).Take(80).ToArray();
  Console.WriteLine(Json.Serialize(Args("case",name,"elapsedMs",times,"wireBytes",Encoding.UTF8.GetByteCount(Json.Serialize(r)),"serializedElements",flat.Count,"matchingNames",matching.Select(e=>(string)e["name"]).ToArray(),"scanned",r.ContainsKey("scanned")?r["scanned"]:flat.Count,"truncated",r.ContainsKey("truncated")?r["truncated"]:false)));
 }
 static void Run() {
  try {
   Query("select-one",Args("hwnd",hwnd,"query",true,"nameContains","Target unique","role","Button","depth",16,"maxNodes",1200,"limit",80));
   Query("missing",Args("hwnd",hwnd,"query",true,"nameContains","DOES-NOT-EXIST","role","Button","depth",16,"maxNodes",1200,"limit",80));
   Query("broad-80",Args("hwnd",hwnd,"query",true,"role","Button","depth",16,"maxNodes",1200,"limit",80));
   var times=new List<double>();for(int i=0;i<9;i++){var sw=Stopwatch.StartNew();Call("FrameSigOp",Args("hwnd",hwnd,"step",16,"insetPct",10));times.Add(sw.Elapsed.TotalMilliseconds);}
   Console.WriteLine(Json.Serialize(Args("case","frame-check","elapsedMs",times)));
   string id=AutomationElement.FromHandle(exact.Handle).Current.AutomationId;
   var swAct=Stopwatch.StartNew();var selected=Call("UiaAct",Args("hwnd",hwnd,"automationId",id,"role","Button","action","invoke","requireUnique",true,"settleMs",0,"maxNodes",1200,"depth",16));
   double actMs=swAct.Elapsed.TotalMilliseconds;Thread.Sleep(100);
   Console.WriteLine(Json.Serialize(Args("case","exact-id-act","elapsedMs",actMs,"automationId",id,"hits",hits,"lastHit",lastHit)));
   int before=hits;string refusal=null;swAct.Restart();
   try {Call("UiaAct",Args("hwnd",hwnd,"nameContains","Save duplicate","role","Button","action","invoke","requireUnique",true,"settleMs",0,"maxNodes",1200,"depth",16));}catch(Exception e){refusal=e.Message;}
   actMs=swAct.Elapsed.TotalMilliseconds;Thread.Sleep(100);
   Console.WriteLine(Json.Serialize(Args("case","ambiguous-act","elapsedMs",actMs,"extraHits",hits-before,"refusal",refusal)));
   var exactQuery=Call("Uia",Args("hwnd",hwnd,"query",true,"automationId",id,"depth",16,"maxNodes",1200,"limit",80));
   Console.WriteLine(Json.Serialize(Args("case","query-exact-id","count",((List<object>)exactQuery["flat"]).Count)));
   bool partial=(bool)Worker.GetMethod("ElementMatches",BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,new object[]{AutomationElement.FromHandle(exact.Handle),null,"button-8",null});
   Console.WriteLine(Json.Serialize(Args("case","id-prefix","matched",partial)));
   foreach(int budget in new int[]{0,20}) {
    before=hits;refusal=null;
    try {Call("UiaAct",Args("hwnd",hwnd,"automationId",id,"role","Button","action","invoke","requireUnique",true,"settleMs",0,"maxNodes",budget==0?1200:budget,"depth",budget==0?1:16));}catch(Exception e){refusal=e.Message;}
    Thread.Sleep(100);
    Console.WriteLine(Json.Serialize(Args("case",budget==0?"depth-truncated":"budget-truncated","extraHits",hits-before,"refusal",refusal)));
   }
   Console.WriteLine(Json.Serialize(Args("case","complete","fixtureOnly",true)));
  } catch(Exception e){Console.WriteLine(Json.Serialize(Args("case","error","error",e.ToString())));Environment.ExitCode=1;}
  finally{form.BeginInvoke(new Action(()=>form.Close()));}
 }
 [STAThread] public static void Main() {
  Worker.Assembly.GetType("DshComputerUse.Worker.Glow").GetProperty("Enabled").SetValue(null,false,null);
  form=new PassiveForm{Text="DSH isolated UIA benchmark",ShowInTaskbar=false,Width=640,Height=480,StartPosition=FormStartPosition.Manual,Left=30,Top=60,Opacity=0.01};
  for(int i=0;i<160;i++){
   int index=i;var b=new Button {Text=i==0||i==159?"Save duplicate":i==80?"Target unique":"Row "+i,Name="button-"+i,Width=66,Height=24,Left=(i%8)*75+8,Top=(i/8)*26+8};
   b.Click+=(sender,args)=>{hits++;lastHit="button-"+index;};form.Controls.Add(b);if(i==80)exact=b;
  }
  form.Shown+=(sender,args)=>{hwnd=form.Handle.ToInt64();foreach(Control c in form.Controls){var unused=c.Handle;}var t=new Thread(Run);t.SetApartmentState(ApartmentState.MTA);t.IsBackground=true;t.Start();};
  Application.Run(form);
 }
}
