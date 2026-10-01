using System;
using System.Collections.Generic;
using System.Reflection;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public class TargetPassiveForm : Form { protected override bool ShowWithoutActivation { get { return true; } } }
public static class UiTargetProbe {
 static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
 static readonly Type Worker = typeof(DshComputerUse.Worker.Program);
 static TargetPassiveForm form; static Panel panel, other; static Button button; static long hwnd; static int hits;
 static Dictionary<string,object> Args(params object[] pairs) { var d=new Dictionary<string,object>(); for(int i=0;i<pairs.Length;i+=2)d[(string)pairs[i]]=pairs[i+1]; return d; }
 static object Call(string method, params object[] args) {
  try { return Worker.GetMethod(method, BindingFlags.NonPublic|BindingFlags.Static).Invoke(null,args); }
  catch(TargetInvocationException e) { throw e.InnerException; }
 }
 static void Ui(Action action) { form.Invoke(action); }
 static Button Add(Panel parent, string id, string text) {
  var b=new Button {Name=id,Text=text,Left=10,Top=10,Width=150,Height=25};
  b.Click+=(s,e)=>hits++; parent.Controls.Add(b); var handle=b.Handle; return b;
 }
 static void Replace(string id,string text,Panel parent) { Ui(()=>{var next=Add(parent,id,text);button.Dispose();button=next;}); }
 static string Observe() {
  var r=(Dictionary<string,object>)Call("Uia",Args("hwnd",hwnd,"query",true,"targets",true,"role","Button","nameContains","Save intended","depth",16,"maxNodes",1200,"limit",80));
  var rows=(List<object>)r["flat"]; if(rows.Count!=1)throw new Exception("expected one target, got "+rows.Count);
  var row=(Dictionary<string,object>)rows[0]; if(!row.ContainsKey("target"))throw new Exception("target not issued: "+Json.Serialize(row));
  return (string)row["target"];
 }
 static void Emit(string name,bool ok,object detail) { Console.WriteLine(Json.Serialize(Args("case",name,"ok",ok,"detail",detail))); if(!ok)throw new Exception(name); }
 static void Act(string name,string token,bool rebind,string expectedMode) {
  int before=hits;var r=(Dictionary<string,object>)Call("UiaAct",Args("target",token,"allowRebind",rebind,"action","invoke","settleMs",0,"depth",16,"maxNodes",1200));
  Thread.Sleep(60);var resolution=(Dictionary<string,object>)r["resolution"];
  Emit(name,hits==before+1 && (string)resolution["mode"]==expectedMode,Args("extraHits",hits-before,"resolution",resolution));
 }
 static void Refuse(string name,string token,string pattern,int depth=16) {
  int before=hits;string message="";
  try { Call("UiaAct",Args("target",token,"allowRebind",name!="explicit-rebind-required","action","invoke","settleMs",0,"depth",depth,"maxNodes",1200)); }
  catch(Exception e){message=e.Message;}
  Thread.Sleep(40);Emit(name,hits==before && message.Contains(pattern),Args("extraHits",hits-before,"refusal",message));
 }
 static void Run() {
  try {
   string original=Observe(); Emit("stable-observed-handle",original==Observe(),null);
   Act("same-native-control",original,false,"runtime-id");
   Replace("save-alpha","Save intended",panel);
   Refuse("explicit-rebind-required",original,"TARGET_STALE");
   Act("unique-native-replacement",original,true,"native-identifier");
   string semantic=Observe();Replace("save-new-id","Save intended",panel);
   Act("unique-semantic-replacement",semantic,true,"semantic");
   string duplicate=Observe();Replace("save-new-id","Save intended",panel);
   Button extra=null;Ui(()=>extra=Add(panel,"save-new-id","Save intended"));
   Refuse("duplicate-native-id",duplicate,"AMBIGUOUS_UIA_TARGET");Ui(()=>extra.Dispose());
   string changed=Observe();Replace("save-new-id","Delete instead",panel);
   Refuse("same-id-changed-meaning",changed,"TARGET_SEMANTICS_CHANGED");
   Replace("save-normal","Save intended",panel);string moved=Observe();Replace("save-normal","Save intended",other);
   Refuse("changed-parent-context",moved,"TARGET_SEMANTICS_CHANGED");
   string incomplete=Observe();Replace("save-normal","Save intended",other);
   Refuse("incomplete-recovery-scan",incomplete,"INCOMPLETE_UIA_SEARCH",1);
   string ambiguous=Observe();Replace("another-1","Save intended",other);Ui(()=>extra=Add(other,"another-2","Save intended"));
   Refuse("ambiguous-semantic-replacement",ambiguous,"AMBIGUOUS_UIA_TARGET");Ui(()=>extra.Dispose());
   string window=Observe();Ui(()=>form.Left+=20);Refuse("window-moved",window,"TARGET_STALE");
   Emit("fixture-complete",true,Args("totalInvocations",hits,"fixtureOnly",true));
  }catch(Exception e){Console.WriteLine(Json.Serialize(Args("case","error","error",e.ToString())));Environment.ExitCode=1;}
  finally { form.BeginInvoke(new Action(()=>form.Close())); }
 }
 [STAThread] public static void Main() {
  Worker.Assembly.GetType("DshComputerUse.Worker.Glow").GetProperty("Enabled").SetValue(null,false,null);
  form=new TargetPassiveForm {Text="DSH owned target recovery fixture",ShowInTaskbar=false,Width=600,Height=300,Left=40,Top=80,StartPosition=FormStartPosition.Manual,Opacity=0.01};
  panel=new Panel{Name="stable-context",AccessibleName="Record Alpha",Width=270,Height=200,Left=5,Top=5};
  other=new Panel{Name="other-context",AccessibleName="Record Beta",Width=270,Height=200,Left=285,Top=5};
  form.Controls.Add(panel);form.Controls.Add(other);
  form.Shown+=(s,e)=> { hwnd=form.Handle.ToInt64();button=Add(panel,"save-alpha","Save intended");var t=new Thread(Run);t.SetApartmentState(ApartmentState.MTA);t.IsBackground=true;t.Start(); };
  Application.Run(form);
 }
}
