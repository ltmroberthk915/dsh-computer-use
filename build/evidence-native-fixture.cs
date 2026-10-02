// Exercises production code only against controls owned by this test process.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Reflection;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

public class EvidenceBoard : Control {
 public bool Stripe;
 protected override void OnPaint(PaintEventArgs e) { e.Graphics.Clear(Color.White); if(Stripe)e.Graphics.FillRectangle(Brushes.Black,0,32,33,1); }
}
public class EvidencePassiveForm : Form {protected override bool ShowWithoutActivation {get{return true;}}}
public class EvidenceCustomEditor : Control {
 public EvidenceCustomEditor(){SetStyle(ControlStyles.Selectable,true);TabStop=true;AccessibleRole=AccessibleRole.Pane;}
 protected override void OnKeyPress(KeyPressEventArgs e){Text+=e.KeyChar;base.OnKeyPress(e);}
}
public static class EvidenceProbe {
 static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
 static readonly Type Worker=typeof(DshComputerUse.Worker.Program);
 static Form form; static Button button; static TextBox editor; static EvidenceBoard board; static Panel animation;
 static Form noise; static System.Windows.Forms.Timer timer;
 static EvidenceCustomEditor custom;
 static long hwnd; static int keys; static bool baseline;
 static Dictionary<string,object> Args(params object[] pairs) {var d=new Dictionary<string,object>();for(int i=0;i<pairs.Length;i+=2)d[(string)pairs[i]]=pairs[i+1];return d;}
 static object Call(string name,params object[] args) {try{return Worker.GetMethod(name,BindingFlags.NonPublic|BindingFlags.Static).Invoke(null,args);}catch(TargetInvocationException e){throw e.InnerException;}}
 static void Ui(Action a){form.Invoke(a);}
 static void Emit(string name,bool ok,object detail){Console.WriteLine(Json.Serialize(Args("case",name,"ok",ok,"detail",detail)));if(!ok)throw new Exception(name);}
 static string TextValue(){string v="";Ui(()=>v=editor.Text);return v;}
 static byte[] Rect(){Point p=Point.Empty;Ui(()=>p=board.PointToScreen(Point.Empty));return (byte[])Call("FrameSignatureRect",p.X,p.Y,33,33,16);}
 static void Run(){try{
  Thread.Sleep(300);
  Emit("screen-bounds",true,Args("virtual",SystemInformation.VirtualScreen.ToString(),"primary",Screen.PrimaryScreen.Bounds.ToString()));
  string error=null;int samples=0;
  try{samples=((byte[])Call("FrameSignature",7)).Length;}catch(Exception e){error=e.GetType().Name;}
  var v=SystemInformation.VirtualScreen;int expected=((v.Width+6)/7)*((v.Height+6)/7);
  Emit("nondivisible-screen-sampling",baseline ? error=="IndexOutOfRangeException" : error==null&&samples==expected,Args("error",error,"samples",samples,"expected",expected));
  byte[] before=Rect();Ui(()=>{board.Stripe=true;board.Refresh();});Thread.Sleep(150);byte[] after=Rect();
  double diff=(double)Call("SigDiffPct",before,after,8);
  Emit("bottom-row-sampling",baseline ? diff==0 : diff>0,Args("samples",after.Length,"diffPct",diff));
  Ui(()=>{form.Activate();button.Focus();});Thread.Sleep(150);
  Emit("button-focused",AutomationElement.FocusedElement.Current.ControlType==ControlType.Button,null);
  object receipt=null;Exception refusal=null;int initial=keys;
  try{receipt=Call("Type",Args("text","Probe77","expectHwnd",hwnd,"charDelayMs",10));}catch(Exception e){refusal=e;}
  Thread.Sleep(150);
  Emit("button-type",baseline ? refusal==null&&keys-initial==7&&TextValue()=="" : refusal!=null&&(string)refusal.Data["code"]=="TYPE_FOCUS_NOT_EDITABLE"&&(string)refusal.Data["outcome"]=="not-dispatched"&&keys==initial&&TextValue()=="",Args("keys",keys-initial,"editor",TextValue(),"receipt",receipt,"error",refusal==null?null:refusal.Message,"outcome",refusal==null?null:refusal.Data["outcome"]));
  if(!baseline){
   refusal=null;try{Call("Type",Args("text","Probe77","mode","paste","expectHwnd",hwnd));}catch(Exception e){refusal=e;}
   Emit("button-paste-refused",refusal!=null&&(string)refusal.Data["outcome"]=="not-dispatched",null);
  }
  Call("UiaAct",Args("hwnd",hwnd,"automationId","owned-editor","action","focus","requireUnique",true,"settleMs",0));
  receipt=Call("Type",Args("text","Probe77","expectHwnd",hwnd,"charDelayMs",10));Thread.Sleep(150);
  Emit("focus-then-type",TextValue()=="Probe77",Args("value",TextValue(),"receipt",receipt));
  Ui(()=>custom.Focus());Thread.Sleep(100);
  receipt=Call("Type",Args("text","Custom7","expectHwnd",hwnd,"charDelayMs",10));Thread.Sleep(100);
  string customText="";Ui(()=>customText=custom.Text);
  Emit("custom-editor-remains-compatible",customText=="Custom7",Args("value",customText,"receipt",receipt));
  Ui(()=>button.Focus());
  var pairs=new List<object>();
  for(int i=0;i<4;i++){
   Ui(()=>{animation.BackColor=Color.Black;animation.Refresh();});Thread.Sleep(100);byte[] g0=(byte[])Call("FrameSignature",8),r0=Rect();
   Ui(()=>{animation.BackColor=Color.White;animation.Refresh();});Thread.Sleep(100);byte[] g1=(byte[])Call("FrameSignature",8),r1=Rect();
   pairs.Add(Args("globalDiffPct",Call("SigDiffPct",g0,g1,8),"targetDiffPct",Call("SigDiffPct",r0,r1,8)));
  }
  bool all=true;foreach(Dictionary<string,object> pair in pairs)all &= (double)pair["globalDiffPct"]>0.30&&(double)pair["targetDiffPct"]==0;
  Emit("outside-animation-scope",all,pairs);
  if(!baseline){
   Ui(()=>{
    noise=new EvidencePassiveForm{Text="Owned animation",Left=850,Top=150,Width=340,Height=300,TopMost=true,ShowInTaskbar=false,StartPosition=FormStartPosition.Manual,BackColor=Color.Black};noise.Show();
    int color=0;timer=new System.Windows.Forms.Timer{Interval=70};timer.Tick+=(s,e)=>{color=(color+71)%256;noise.BackColor=Color.FromArgb(color,color,color);noise.Refresh();};timer.Start();
   });
   var global=(Dictionary<string,object>)Call("WaitStable",Args("timeoutMs",1600));
   var scoped=(Dictionary<string,object>)Call("WaitStable",Args("hwnd",hwnd,"timeoutMs",1600));
   Emit("window-wait-excludes-outside-animation",!(bool)global["stable"]&&(bool)scoped["stable"],Args("global",global,"window",scoped));
   var unchanged=(Dictionary<string,object>)Call("WaitChange",Args("hwnd",hwnd,"timeoutMs",400));
   Emit("window-change-excludes-outside-animation",!(bool)unchanged["changed"],unchanged);
   Ui(()=>{timer.Stop();noise.Close();timer.Dispose();});
   object[] samplerArgs={Args("hwnd",hwnd),8,null};var sampler=(Func<byte[]>)Call("WaitSampler",samplerArgs);
   Ui(()=>form.Left+=15);error=null;try{sampler();}catch(Exception e){error=e.Message;}
   Emit("moved-wait-target-refused",error!=null&&error.Contains("WAIT_TARGET_CHANGED"),error);
   Ui(()=>form.WindowState=FormWindowState.Minimized);error=null;try{Call("WaitStable",Args("hwnd",hwnd));}catch(Exception e){error=e.Message;}
   Emit("minimized-wait-target-refused",error!=null&&error.Contains("WAIT_TARGET_UNAVAILABLE"),error);
  }
 }catch(Exception e){Console.WriteLine(Json.Serialize(Args("case","error","error",e.ToString())));Environment.ExitCode=1;}
 finally{form.BeginInvoke(new Action(()=>{if(timer!=null)timer.Stop();if(noise!=null)noise.Close();form.Close();}));}}
 [STAThread]public static void Main(string[] args){
  Console.OutputEncoding=new System.Text.UTF8Encoding(false);
  DshComputerUse.Worker.Native.SetProcessDpiAwarenessContext(new IntPtr(-4));
  baseline=args.Length>0&&args[0]=="baseline";
  Worker.Assembly.GetType("DshComputerUse.Worker.Glow").GetProperty("Enabled").SetValue(null,false,null);
  form=new Form{Text="DSH isolated evidence test",Width=740,Height=380,Left=60,Top=120,StartPosition=FormStartPosition.Manual,TopMost=true,ShowInTaskbar=false};
  button=new Button{Name="owned-button",Text="Owned test button",Left=15,Top=15,Width=190,Height=35};button.KeyPress+=(s,e)=>keys++;
  editor=new TextBox{Name="owned-editor",Left=15,Top=65,Width=320};
  board=new EvidenceBoard{Left=15,Top=130,Width=33,Height=33};
  custom=new EvidenceCustomEditor{Name="owned-custom",Left=15,Top=195,Width=300,Height=30,BackColor=Color.LightGray};
  animation=new Panel{Left=370,Top=15,Width=320,Height=260,BackColor=Color.Black};
  form.Controls.Add(button);form.Controls.Add(editor);form.Controls.Add(board);form.Controls.Add(custom);form.Controls.Add(animation);
  form.Shown+=(s,e)=>{hwnd=form.Handle.ToInt64();button.Focus();var t=new Thread(Run);t.SetApartmentState(ApartmentState.MTA);t.IsBackground=true;t.Start();};Application.Run(form);
 }
}
