// Fixture-owned UIA provider. Windows' legacy button proxy uses SendInput to
// focus the button; that cannot run on a never-activated private desktop.
// This provider invokes only this test control while exercising the production
// UIA selector / stale-target / InvokePattern paths without global input.
using System;
using System.Runtime.InteropServices;
using System.Windows.Automation;
using System.Windows.Automation.Provider;
using System.Windows.Forms;

public class PrivateInvokeButton : Button {
 private Provider provider;
 [DllImport("UIAutomationCore.dll")] static extern IntPtr UiaReturnRawElementProvider(IntPtr hwnd,IntPtr wParam,IntPtr lParam,IRawElementProviderSimple provider);
 protected override void WndProc(ref Message m) {
  if(m.Msg==0x003D && m.LParam.ToInt64()==AutomationInteropProvider.RootObjectId) {
   if(provider==null)provider=new Provider(this);
   m.Result=UiaReturnRawElementProvider(Handle,m.WParam,m.LParam,provider);return;
  }
  base.WndProc(ref m);
 }
 private sealed class Provider : IRawElementProviderSimple,IInvokeProvider {
  readonly PrivateInvokeButton button;
  public Provider(PrivateInvokeButton value){button=value;}
  public ProviderOptions ProviderOptions {get{return ProviderOptions.ServerSideProvider;}}
  public IRawElementProviderSimple HostRawElementProvider {get{return AutomationInteropProvider.HostProviderFromHandle(button.Handle);}}
  public object GetPatternProvider(int id){return id==InvokePatternIdentifiers.Pattern.Id?this:null;}
  public object GetPropertyValue(int id){
   if(id==AutomationElementIdentifiers.NameProperty.Id)return button.Text;
   if(id==AutomationElementIdentifiers.AutomationIdProperty.Id)return button.Name;
   if(id==AutomationElementIdentifiers.ControlTypeProperty.Id)return ControlType.Button.Id;
   if(id==AutomationElementIdentifiers.IsEnabledProperty.Id)return button.Enabled;
   if(id==AutomationElementIdentifiers.IsControlElementProperty.Id || id==AutomationElementIdentifiers.IsContentElementProperty.Id)return true;
   return null;
  }
  public void Invoke(){button.BeginInvoke(new Action(button.PerformClick));}
 }
}
