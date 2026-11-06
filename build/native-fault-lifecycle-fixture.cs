// Alternate entry point: real process/OS handles, fake accepted input. No hooks,
// Native.SendInput or changes to the interactive desktop are made by this probe.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using DshComputerUse.Worker;
static class NativeFaultLifecycleFixture {
 const BindingFlags Flags=BindingFlags.Static|BindingFlags.NonPublic;
 static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
 static int sends;
 static object Call(string name,params object[] args){try{return typeof(Program).GetMethod(name,Flags).Invoke(null,args);}catch(TargetInvocationException e){throw e.InnerException;}}
 static int Owned {get{return ((IDictionary)typeof(Program).GetField("OwnedUps",Flags).GetValue(null)).Count;}}
 static void Emit(string name,object data){Console.WriteLine(Json.Serialize(new {name=name,data=data}));Console.Out.Flush();}
 static void Check(bool ok,string why){if(!ok)throw new Exception(why);}
 [DllImport("user32.dll")]static extern IntPtr SetCapture(IntPtr hwnd);
 [DllImport("user32.dll")]static extern IntPtr GetCapture();
 [DllImport("user32.dll")]static extern bool ReleaseCapture();
 [DllImport("user32.dll")]static extern IntPtr SetFocus(IntPtr hwnd);
 [DllImport("user32.dll")]static extern IntPtr GetFocus();
 [DllImport("user32.dll")]static extern IntPtr SetActiveWindow(IntPtr hwnd);
 [STAThread]static void Main(string[] args){
  Glow.Enabled=false;
  Program.InputSender=inputs=>{sends+=inputs.Length;return (uint)inputs.Length;};
  if(args[0]=="hold" || args[0]=="fresh"){
   bool acquired=Program.TryClaimDesktop("isolated lifecycle fixture");
   if(args[0]=="hold" && acquired)Call("SendKey",(ushort)65,false);
   Emit("ready",new {acquired=acquired,owned=Owned,sends=sends,generation=Program.WorkerGeneration});
   if(args[0]=="hold"){
    string command=Console.ReadLine();
    if(command=="release"){
     Program.ReleaseDesktopOwnership();Check(Program.DesktopOwned,"lease cannot release while accepted down remains");
     uint released=Program.ReleaseOwnedInputs();Program.ReleaseDesktopOwnership();
     Emit("released",new {released=released,owned=Owned,lease=Program.DesktopOwned,sends=sends});
    }
   }
   Program.ReleaseDesktopOwnership();return;
  }
  using(var form=new Form())using(var first=new TextBox())using(var second=new TextBox()){
   form.ShowInTaskbar=false;form.Controls.Add(first);form.Controls.Add(second);second.Top=40;form.Show();
   var hwnd=form.Handle;var a=first.Handle;var b=second.Handle;
   Program.InputForeground=()=>hwnd;Program.InputPointReceiver=()=>hwnd;
   Program.InputWindowExists=h=>h==hwnd;Program.InputWindowPid=h=>1U;
   SetCapture(a);Check(GetCapture()==a,"fixture capture acquired");
   ReleaseCapture();Check(GetCapture()==IntPtr.Zero,"fixture capture actually lost");
   using((IDisposable)Call("GuardReceiver",hwnd,1U,false))Call("SendKey",(ushort)65,false);
   Program.ReleaseOwnedInputs();Call("EndActuationForReadback");
   Emit("capture-boundary",new {captureLost=true,topLevelGuardPermits=true,nativeInput=false,meaning="capture loss is not a generic top-level receiver refusal"});
   SetActiveWindow(hwnd);SetFocus(a);Check(GetFocus()==a,"first child focus");
   using((IDisposable)Call("GuardReceiver",hwnd,1U,true)){
    SetFocus(b);Check(GetFocus()==b,"real child focus changed within same top-level");
    Call("SendKey",(ushort)66,false);
   }
   Program.ReleaseOwnedInputs();Call("EndActuationForReadback");
   Emit("focus-boundary",new {childFocusChanged=true,topLevelUnchanged=true,guardPermits=true,nativeInput=false});
   Check(Owned==0,"all fake accepted input released");form.Close();
  }
 }
}
