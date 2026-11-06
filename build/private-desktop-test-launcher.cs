using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

// Never calls SwitchDesktop. A kill-on-close job contains every test descendant.
static class PrivateDesktopTestLauncher {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
  public int cb; public string reserved, desktop, title;
  public int x,y,width,height,cols,rows,fill,flags; public short show,reservedBytes;
  public IntPtr reserved2,stdin,stdout,stderr;
 }
 [StructLayout(LayoutKind.Sequential)] struct ProcInfo { public IntPtr process,thread; public uint pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
  public long processTime,jobTime; public uint flags; public UIntPtr minimum,maximum;
  public uint activeProcesses; public UIntPtr affinity; public uint priority,scheduling;
 }
 [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
  public BasicLimits basic; public IoCounters io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob;
 }
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateDesktop(string name,IntPtr device,IntPtr mode,uint flags,uint access,IntPtr security);
 [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr handle);
 [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint tid);
 [DllImport("user32.dll",SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder text,int bytes,out int needed);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string exe,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref StartupInfo start,out ProcInfo child);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimits limits,int size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 static string Name(IntPtr desktop) {
  int needed;var name=new StringBuilder(256);
  if(desktop==IntPtr.Zero||!GetUserObjectInformation(desktop,2,name,name.Capacity*2,out needed))throw new Win32Exception();
  return name.ToString();
 }
 static string InputName() {
  var desktop=OpenInputDesktop(0,false,1);if(desktop==IntPtr.Zero)throw new Win32Exception();
  try{return Name(desktop);}finally{CloseDesktop(desktop);}
 }
 static void Verify(int pid,string expected) {
  using(var process=Process.GetProcessById(pid)) {
   var first=process.Threads[0];foreach(ProcessThread t in process.Threads)if(t.StartTime<first.StartTime)first=t;
   if(Name(GetThreadDesktop((uint)first.Id))!=expected)throw new Exception("Test process did not inherit private desktop");
   if(InputName()==expected)throw new Exception("Refusing to test on the current input desktop");
  }
 }
 static int Main(string[] args) {
  var name=Environment.GetEnvironmentVariable("DSH_PRIVATE_TEST_DESKTOP");
  if(String.IsNullOrEmpty(name)||!name.StartsWith("DshIsolatedTest-",StringComparison.Ordinal))throw new Exception("Private desktop identity required");
  if(args.Length==2&&args[0]=="verify"){Verify(Int32.Parse(args[1]),name);return 0;}
  if(args.Length!=3||args[0]!="run")throw new Exception("Expected run node test-script");
  var before=InputName();var desktop=CreateDesktop(name,IntPtr.Zero,IntPtr.Zero,0,0x01ff,IntPtr.Zero);
  if(desktop==IntPtr.Zero)throw new Win32Exception();
  IntPtr job=IntPtr.Zero;
  ProcInfo child=new ProcInfo();
  try {
   job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Win32Exception();
   var limits=new ExtendedLimits();limits.basic.flags=0x2000;
   if(!SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(ExtendedLimits))))throw new Win32Exception();
   var start=new StartupInfo{cb=Marshal.SizeOf(typeof(StartupInfo)),desktop="winsta0\\"+name};
   var command=new StringBuilder("\""+args[1]+"\" \""+args[2]+"\"");
   if(!CreateProcess(args[1],command,IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,null,ref start,out child))throw new Win32Exception();
   if(!AssignProcessToJobObject(job,child.process))throw new Win32Exception();
   if(ResumeThread(child.thread)==0xffffffff)throw new Win32Exception();
   uint timeout=180000;UInt32.TryParse(Environment.GetEnvironmentVariable("DSH_PRIVATE_TEST_TIMEOUT_MS"),out timeout);
   if(timeout<1000||timeout>210000)throw new Exception("Invalid test timeout");
   if(WaitForSingleObject(child.process,timeout)!=0)throw new TimeoutException("Isolated test timed out");
   uint code;if(!GetExitCodeProcess(child.process,out code))throw new Win32Exception();
   if(InputName()!=before)throw new Exception("Input desktop changed during test; refusing to report pass");
   return (int)code;
  } finally {
   if(child.process!=IntPtr.Zero&&WaitForSingleObject(child.process,0)==258)TerminateProcess(child.process,1);
   if(job!=IntPtr.Zero)CloseHandle(job); // kills descendants even after a crash or test timeout
   if(child.thread!=IntPtr.Zero)CloseHandle(child.thread);
   if(child.process!=IntPtr.Zero)CloseHandle(child.process);
   CloseDesktop(desktop);
  }
 }
}
