// Fixture in --serve-file mode for the PUBLIC integration smoke (CUA-IMPL-PUBLIC).
//
// It exposes the SAME providers as the native fixture and accepts ONLY its own lifecycle commands
// over <state>\command.txt (write this, read state.json). There is no generic command surface, no
// shell, no input injection: the commands are state | quit, and the JSON it publishes is its own
// measured counters, never the caller's claims.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Automation.Provider;
using System.Windows.Automation.Text;
using System.Windows.Forms;

namespace UiaFeatureServe
{
    internal static class Native
    {
        [DllImport("kernel32.dll")] internal static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] internal static extern IntPtr GetThreadDesktop(uint threadId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        internal static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder text, int bytes, out int needed);
        internal static string DesktopName()
        {
            IntPtr desktop = GetThreadDesktop(GetCurrentThreadId());
            if (desktop == IntPtr.Zero) return "?";
            var name = new StringBuilder(256);
            int needed;
            return GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed) ? name.ToString() : "?";
        }
    }
}

public static class UiaFeatureFixture
{
    private static Form form;
    private static ServeFixture fixture;
    private static string stateDir;
    private static volatile bool running = true;

    [STAThread]
    public static void Main(string[] args)
    {
        foreach (string arg in args) if (arg.StartsWith("--state=", StringComparison.Ordinal)) stateDir = arg.Substring(8);
        if (stateDir == null) stateDir = Path.Combine(Path.GetTempPath(), "uia-feature-serve-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(stateDir);
        Application.EnableVisualStyles();
        form = new Form
        {
            Text = "CUA-IMPL-1123 public fixture",
            ShowInTaskbar = false, Width = 900, Height = 640,
            StartPosition = FormStartPosition.Manual, Left = 30, Top = 40, Opacity = 0.01,
        };
        fixture = new ServeFixture { Left = 6, Top = 6, Width = 880, Height = 600, Name = "serveFixture" };
        form.Controls.Add(fixture);
        form.Shown += delegate
        {
            var pump = new Thread(Pump) { IsBackground = true };
            pump.SetApartmentState(ApartmentState.MTA);
            pump.Start();
        };
        form.FormClosing += delegate { running = false; };
        Application.Run(form);
    }

    /// <summary>Poll the fixture's own command file; nothing else can drive it.</summary>
    private static void Pump()
    {
        string commandPath = Path.Combine(stateDir, "command.txt");
        while (running)
        {
            try
            {
                if (File.Exists(commandPath))
                {
                    string payload;
                    using (var stream = new FileStream(commandPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                    using (var reader = new StreamReader(stream, Encoding.UTF8)) payload = reader.ReadToEnd();
                    File.Delete(commandPath);
                    foreach (string raw in payload.Split('\n'))
                    {
                        string command = raw.Trim().ToLowerInvariant();
                        if (command != "quit") continue;   // no other command exists
                        running = false;
                        try { form.BeginInvoke(new Action(delegate { form.Close(); })); } catch { }
                    }
                }
                WriteState();
            }
            catch { }
            Thread.Sleep(80);
        }
    }

    private static void WriteState()
    {
        IntPtr hwnd = IntPtr.Zero;
        string desktop = UiaFeatureServe.Native.DesktopName();
        try { hwnd = form.Handle; } catch { }
        var data = new Dictionary<string, object>();
        data["pid"] = Process.GetCurrentProcess().Id;
        data["hwnd"] = hwnd.ToInt64();
        data["desktop"] = desktop;
        var scroll = new Dictionary<string, object>();
        scroll["vertical"] = fixture.ScrollVertical;
        scroll["horizontal"] = fixture.ScrollHorizontal;
        data["scroll"] = scroll;
        var view = new Dictionary<string, object>();
        view["current"] = fixture.CurrentView;
        view["switches"] = fixture.ViewSwitches;
        data["view"] = view;
        var realize = new Dictionary<string, object>();
        realize["calls"] = fixture.RealizeCalls;
        realize["rows"] = fixture.RealizedRows();
        data["realize"] = realize;
        var select = new Dictionary<string, object>();
        select["calls"] = fixture.SelectCalls;
        select["text"] = fixture.HeldText;
        data["select"] = select;
        var json = new JavaScriptSerializer().Serialize(data);
        string target = Path.Combine(stateDir, "state.json");
        string temp = target + ".tmp";
        try { File.WriteAllText(temp, json, new UTF8Encoding(false)); if (File.Exists(target)) File.Delete(target); File.Move(temp, target); }
        catch { }
    }
}

/// <summary>Hosts the four measured providers and reports only its own counters.</summary>
public sealed class ServeFixture : Control
{
    internal readonly ScrollSurface Scroll = new ScrollSurface();
    internal readonly ViewSurface View = new ViewSurface();
    internal readonly CountingSurface Counting = new CountingSurface();
    internal double ScrollVertical { get { return Scroll.VerticalPercent; } }
    internal double ScrollHorizontal { get { return Scroll.HorizontalPercent; } }
    internal int CurrentView { get { return View.CurrentViewId; } }
    internal int ViewSwitches { get { return View.ViewSwitches; } }
    internal int RealizeCalls { get { return View.RealizeCalls; } }
    internal int SelectCalls { get { return Counting.SelectCalls; } }
    internal string HeldText { get { return Counting.HeldText; } }
    internal int[] RealizedRows() { lock (View.Realized) return new List<int>(View.Realized).ToArray(); }

    internal ServeFixture()
    {
        Scroll.Left = 6; Scroll.Top = 6; Scroll.Width = 400; Scroll.Height = 260; Scroll.Name = "scrollFixture";
        Scroll.AccessibleName = "scrollFixture";
        Controls.Add(Scroll);
        View.Left = 420; View.Top = 6; View.Width = 440; View.Height = 260; View.Name = "viewFixture";
        View.AccessibleName = "viewFixture";
        Controls.Add(View);
        Counting.Left = 6; Counting.Top = 280; Counting.Width = 850; Counting.Height = 100; Counting.Name = "countingEditor";
        Counting.AccessibleName = "countingEditor";
        Counting.Text = "counting editor value=alpha tail. value=alpha 杭州 Résumé end.";
        Controls.Add(Counting);
    }
}

/// <summary>Vertical-only scroll provider (horizontal axis is the negative case).</summary>
public sealed class ScrollSurface : Control
{
    internal double VerticalPercent;
    internal double HorizontalPercent;
    private readonly Provider provider;
    internal int SetCalls;

    internal ScrollSurface() { SetStyle(ControlStyles.UserPaint, true); BackColor = Color.White; provider = new Provider(this); }

    protected override void WndProc(ref Message message)
    {
        const int WM_GETOBJECT = 0x003D;
        if (message.Msg == WM_GETOBJECT && unchecked((int)message.LParam.ToInt64()) == AutomationInteropProvider.RootObjectId)
        {
            message.Result = AutomationInteropProvider.ReturnRawElementProvider(message.HWnd, message.WParam, message.LParam, provider);
            return;
        }
        base.WndProc(ref message);
    }

    private sealed class Provider : IRawElementProviderSimple, IScrollProvider
    {
        private readonly ScrollSurface owner;
        internal Provider(ScrollSurface owner) { this.owner = owner; }
        public ProviderOptions ProviderOptions { get { return ProviderOptions.ServerSideProvider | ProviderOptions.UseComThreading; } }
        public IRawElementProviderSimple HostRawElementProvider { get { return AutomationInteropProvider.HostProviderFromHandle(owner.Handle); } }
        public object GetPatternProvider(int id) { return id == ScrollPattern.Pattern.Id ? this : null; }
        public object GetPropertyValue(int id)
        {
            if (id == AutomationElementIdentifiers.NameProperty.Id) return "scroll fixture";
            if (id == AutomationElementIdentifiers.AutomationIdProperty.Id) return "scrollFixture";
            if (id == AutomationElementIdentifiers.ControlTypeProperty.Id) return ControlType.List.Id;
            if (id == AutomationElementIdentifiers.IsEnabledProperty.Id) return true;
            if (id == AutomationElementIdentifiers.IsOffscreenProperty.Id) return false;
            if (id == AutomationElementIdentifiers.IsKeyboardFocusableProperty.Id) return true;
            if (id == AutomationElementIdentifiers.ProcessIdProperty.Id) return Process.GetCurrentProcess().Id;
            return null;
        }
        public bool HorizontallyScrollable { get { return false; } }
        public double HorizontalScrollPercent { get { return ScrollPattern.NoScroll; } }
        public double HorizontalViewSize { get { return 100; } }
        public bool VerticallyScrollable { get { return true; } }
        public double VerticalScrollPercent { get { return owner.VerticalPercent; } }
        public double VerticalViewSize { get { return 50; } }
        public void Scroll(ScrollAmount h, ScrollAmount v)
        {
            int step = v == ScrollAmount.LargeIncrement ? 10 : v == ScrollAmount.SmallIncrement ? 1
                : v == ScrollAmount.LargeDecrement ? -10 : v == ScrollAmount.SmallDecrement ? -1 : 0;
            owner.VerticalPercent = Math.Max(0, Math.Min(100, owner.VerticalPercent + step));
        }
        public void SetScrollPercent(double h, double v)
        {
            owner.SetCalls++;
            if (v != ScrollPattern.NoScroll) owner.VerticalPercent = v;
            if (h != ScrollPattern.NoScroll) owner.HorizontalPercent = h;
        }
    }
}

/// <summary>MultipleView 1/2 plus 60 virtualised rows with IVirtualizedItemProvider.Realize.</summary>
public sealed class ViewSurface : Control
{
    internal int CurrentViewId = 1;
    internal int ViewSwitches;
    internal int RealizeCalls;
    internal readonly HashSet<int> Realized = new HashSet<int>();
    private readonly Provider provider;

    internal ViewSurface() { SetStyle(ControlStyles.UserPaint, true); BackColor = Color.White; provider = new Provider(this); }

    protected override void WndProc(ref Message message)
    {
        const int WM_GETOBJECT = 0x003D;
        if (message.Msg == WM_GETOBJECT && unchecked((int)message.LParam.ToInt64()) == AutomationInteropProvider.RootObjectId)
        {
            message.Result = AutomationInteropProvider.ReturnRawElementProvider(message.HWnd, message.WParam, message.LParam, provider);
            return;
        }
        base.WndProc(ref message);
    }

    private sealed class Provider : IRawElementProviderSimple, IRawElementProviderFragmentRoot, IRawElementProviderFragment, IMultipleViewProvider
    {
        private readonly ViewSurface owner;
        internal Provider(ViewSurface owner) { this.owner = owner; }
        public ProviderOptions ProviderOptions { get { return ProviderOptions.ServerSideProvider | ProviderOptions.UseComThreading; } }
        public IRawElementProviderSimple HostRawElementProvider { get { return AutomationInteropProvider.HostProviderFromHandle(owner.Handle); } }
        public object GetPatternProvider(int id) { return id == MultipleViewPattern.Pattern.Id ? this : null; }
        public object GetPropertyValue(int id)
        {
            if (id == AutomationElementIdentifiers.NameProperty.Id) return "view fixture";
            if (id == AutomationElementIdentifiers.AutomationIdProperty.Id) return "viewFixture";
            if (id == AutomationElementIdentifiers.ControlTypeProperty.Id) return ControlType.List.Id;
            if (id == AutomationElementIdentifiers.IsEnabledProperty.Id) return true;
            if (id == AutomationElementIdentifiers.IsOffscreenProperty.Id) return false;
            if (id == AutomationElementIdentifiers.IsKeyboardFocusableProperty.Id) return true;
            if (id == AutomationElementIdentifiers.ProcessIdProperty.Id) return Process.GetCurrentProcess().Id;
            if (id == MultipleViewPatternIdentifiers.CurrentViewProperty.Id) return owner.CurrentViewId;
            if (id == MultipleViewPatternIdentifiers.SupportedViewsProperty.Id) return new[] { 1, 2 };
            return null;
        }
        public int CurrentView { get { return owner.CurrentViewId; } }
        public int[] GetSupportedViews() { return new[] { 1, 2 }; }
        public string GetViewName(int id) { return id == 1 ? "One" : id == 2 ? "Two" : null; }
        public void SetCurrentView(int id)
        {
            if (id != 1 && id != 2) throw new ArgumentOutOfRangeException("viewId");
            owner.ViewSwitches++;
            owner.CurrentViewId = id;
        }
        public IRawElementProviderFragment Navigate(NavigateDirection direction)
        {
            if (direction == NavigateDirection.Parent) return null;
            if (direction == NavigateDirection.FirstChild) return new Row(owner, 0);
            if (direction == NavigateDirection.LastChild) return new Row(owner, 59);
            return null;
        }
        public int[] GetRuntimeId() { return new[] { 5150, owner.Handle.ToInt32(), 1 }; }
        public System.Windows.Rect BoundingRectangle
        {
            get { RECT rect; GetWindowRect(owner.Handle, out rect); return new System.Windows.Rect(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top); }
        }
        public IRawElementProviderSimple[] GetEmbeddedFragmentRoots() { return null; }
        public void SetFocus() { }
        public IRawElementProviderFragmentRoot FragmentRoot { get { return this; } }
        public IRawElementProviderFragment ElementProviderFromPoint(double x, double y) { return new Row(owner, 0); }
        public IRawElementProviderFragment GetFocus() { return null; }
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    }

    private sealed class Row : IRawElementProviderFragment, IRawElementProviderSimple, IVirtualizedItemProvider
    {
        private readonly ViewSurface owner;
        private readonly int row;
        internal Row(ViewSurface owner, int row) { this.owner = owner; this.row = row; }
        public ProviderOptions ProviderOptions { get { return ProviderOptions.ServerSideProvider | ProviderOptions.UseComThreading; } }
        public IRawElementProviderSimple HostRawElementProvider { get { return null; } }
        public object GetPatternProvider(int id) { return id == VirtualizedItemPattern.Pattern.Id ? this : null; }
        public object GetPropertyValue(int id)
        {
            if (id == AutomationElementIdentifiers.NameProperty.Id) return "row " + row;
            if (id == AutomationElementIdentifiers.AutomationIdProperty.Id) return "row-" + row;
            if (id == AutomationElementIdentifiers.ControlTypeProperty.Id) return ControlType.ListItem.Id;
            if (id == AutomationElementIdentifiers.IsEnabledProperty.Id) return true;
            if (id == AutomationElementIdentifiers.IsOffscreenProperty.Id) { lock (owner.Realized) return !(row < 8 || owner.Realized.Contains(row)); }
            if (id == AutomationElementIdentifiers.ProcessIdProperty.Id) return Process.GetCurrentProcess().Id;
            return null;
        }
        public IRawElementProviderFragment Navigate(NavigateDirection direction)
        {
            if (direction == NavigateDirection.Parent) return new ParentAnchor(owner);
            if (direction == NavigateDirection.NextSibling && row + 1 < 60) return new Row(owner, row + 1);
            if (direction == NavigateDirection.PreviousSibling && row > 0) return new Row(owner, row - 1);
            return null;
        }
        public int[] GetRuntimeId() { return new[] { 5150, owner.Handle.ToInt32(), 100 + row }; }
        public System.Windows.Rect BoundingRectangle
        {
            get
            {
                RECT rect; GetWindowRect(owner.Handle, out rect);
                int height = Math.Max(1, owner.ClientSize.Height / 8);
                return new System.Windows.Rect(rect.Left + 2, rect.Top + 2 + (row % 8) * height, Math.Max(1, owner.ClientSize.Width - 4), height - 1);
            }
        }
        public IRawElementProviderSimple[] GetEmbeddedFragmentRoots() { return null; }
        public void SetFocus() { }
        public IRawElementProviderFragmentRoot FragmentRoot { get { return new ParentAnchor(owner); } }
        public void Realize() { owner.RealizeCalls++; lock (owner.Realized) owner.Realized.Add(row); }
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    }

    /// <summary>The rows' HWND-level anchor so target evidence can reach a real window.</summary>
    private sealed class ParentAnchor : IRawElementProviderFragmentRoot, IRawElementProviderFragment, IRawElementProviderSimple
    {
        private readonly ViewSurface owner;
        internal ParentAnchor(ViewSurface owner) { this.owner = owner; }
        public ProviderOptions ProviderOptions { get { return ProviderOptions.ServerSideProvider | ProviderOptions.UseComThreading; } }
        public IRawElementProviderSimple HostRawElementProvider { get { return AutomationInteropProvider.HostProviderFromHandle(owner.Handle); } }
        public object GetPatternProvider(int id) { return null; }
        public object GetPropertyValue(int id)
        {
            if (id == AutomationElementIdentifiers.NameProperty.Id) return "view fixture";
            if (id == AutomationElementIdentifiers.AutomationIdProperty.Id) return "viewFixture";
            if (id == AutomationElementIdentifiers.ControlTypeProperty.Id) return ControlType.List.Id;
            if (id == AutomationElementIdentifiers.IsEnabledProperty.Id) return true;
            if (id == AutomationElementIdentifiers.IsOffscreenProperty.Id) return false;
            if (id == AutomationElementIdentifiers.ProcessIdProperty.Id) return Process.GetCurrentProcess().Id;
            return null;
        }
        public IRawElementProviderFragment Navigate(NavigateDirection direction) { return null; }
        public int[] GetRuntimeId() { return new[] { 5150, owner.Handle.ToInt32(), 1 }; }
        public System.Windows.Rect BoundingRectangle
        {
            get { RECT rect; GetWindowRect(owner.Handle, out rect); return new System.Windows.Rect(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top); }
        }
        public IRawElementProviderSimple[] GetEmbeddedFragmentRoots() { return null; }
        public void SetFocus() { }
        public IRawElementProviderFragmentRoot FragmentRoot { get { return this; } }
        public IRawElementProviderFragment ElementProviderFromPoint(double x, double y) { return null; }
        public IRawElementProviderFragment GetFocus() { return null; }
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    }
}

/// <summary>Text provider that counts Select() calls — the one-commit-per-request witness.</summary>
public sealed class CountingSurface : TextBox
{
    internal int SelectCalls;
    private TextProvider provider;
    private TextRange held;

    internal CountingSurface() { Multiline = true; provider = new TextProvider(this); }

    internal string HeldText
    {
        get
        {
            if (held == null) return "";
            int start = held.StartOffset, length = held.Length;
            if (start < 0 || length < 0 || start + length > TextLength) return "";
            return Text.Substring(start, length);
        }
    }

    protected override void WndProc(ref Message message)
    {
        const int WM_GETOBJECT = 0x003D;
        if (message.Msg == WM_GETOBJECT && unchecked((int)message.LParam.ToInt64()) == AutomationInteropProvider.RootObjectId)
        {
            message.Result = AutomationInteropProvider.ReturnRawElementProvider(message.HWnd, message.WParam, message.LParam, provider);
            return;
        }
        base.WndProc(ref message);
    }

    private sealed class TextProvider : IRawElementProviderSimple, ITextProvider
    {
        private readonly CountingSurface owner;
        internal TextProvider(CountingSurface owner) { this.owner = owner; }
        public ProviderOptions ProviderOptions { get { return ProviderOptions.ServerSideProvider; } }
        public IRawElementProviderSimple HostRawElementProvider { get { return AutomationInteropProvider.HostProviderFromHandle(owner.Handle); } }
        public object GetPatternProvider(int id) { return id == TextPattern.Pattern.Id ? this : null; }
        public object GetPropertyValue(int id)
        {
            if (id == AutomationElementIdentifiers.NameProperty.Id) return "counting editor";
            if (id == AutomationElementIdentifiers.AutomationIdProperty.Id) return "countingEditor";
            if (id == AutomationElementIdentifiers.ControlTypeProperty.Id) return ControlType.Edit.Id;
            if (id == AutomationElementIdentifiers.IsEnabledProperty.Id) return owner.Enabled;
            if (id == AutomationElementIdentifiers.IsKeyboardFocusableProperty.Id) return true;
            if (id == AutomationElementIdentifiers.ProcessIdProperty.Id) return Process.GetCurrentProcess().Id;
            return null;
        }
        public ITextRangeProvider[] GetSelection() { return new ITextRangeProvider[] { owner.held ?? new TextRange(owner, 0, 0) }; }
        public ITextRangeProvider[] GetVisibleRanges() { return new ITextRangeProvider[] { new TextRange(owner, 0, owner.TextLength) }; }
        public ITextRangeProvider RangeFromChild(IRawElementProviderSimple child) { return null; }
        public ITextRangeProvider RangeFromPoint(System.Windows.Point point) { return new TextRange(owner, 0, 0); }
        public ITextRangeProvider DocumentRange { get { return new TextRange(owner, 0, owner.TextLength); } }
        public SupportedTextSelection SupportedTextSelection { get { return SupportedTextSelection.Single; } }
    }

    private sealed class TextRange : ITextRangeProvider
    {
        private readonly CountingSurface owner;
        private int start, end;
        internal TextRange(CountingSurface owner, int start, int length) { this.owner = owner; this.start = start; this.end = start + length; }
        internal int StartOffset { get { return start; } }
        internal int Length { get { return Math.Max(0, end - start); } }
        public bool Compare(ITextRangeProvider range) { var other = range as TextRange; return other != null && other.start == start && other.end == end; }
        public int CompareEndpoints(TextPatternRangeEndpoint endpoint, ITextRangeProvider target, TextPatternRangeEndpoint targetEndpoint)
        {
            var other = (TextRange)target;
            return (endpoint == TextPatternRangeEndpoint.Start ? start : end)
                .CompareTo(targetEndpoint == TextPatternRangeEndpoint.Start ? other.start : other.end);
        }
        public void ExpandToEnclosingUnit(TextUnit unit) { }
        public ITextRangeProvider FindAttribute(int attribute, object value, bool backward) { return null; }
        public ITextRangeProvider FindText(string text, bool backward, bool ignoreCase)
        {
            string window = owner.Text.Substring(start, Math.Max(0, end - start));
            StringComparison comparison = ignoreCase ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            int found = backward ? window.LastIndexOf(text, StringComparison.Ordinal) : window.IndexOf(text, comparison);
            return found < 0 ? null : new TextRange(owner, start + found, text.Length);
        }
        public object GetAttributeValue(int attribute) { return null; }
        public double[] GetBoundingRectangles() { return new double[0]; }
        public IRawElementProviderSimple GetEnclosingElement() { return null; }
        public string GetText(int maxLength)
        {
            int take = Math.Min(end - start, owner.TextLength - start);
            if (maxLength > 0) take = Math.Min(take, maxLength);
            return take <= 0 ? "" : owner.Text.Substring(start, take);
        }
        public int Move(TextUnit unit, int count) { return 0; }
        public void MoveEndpointByRange(TextPatternRangeEndpoint endpoint, ITextRangeProvider target, TextPatternRangeEndpoint targetEndpoint)
        {
            var other = (TextRange)target;
            int value = targetEndpoint == TextPatternRangeEndpoint.Start ? other.start : other.end;
            if (endpoint == TextPatternRangeEndpoint.Start) start = value; else end = value;
        }
        public int MoveEndpointByUnit(TextPatternRangeEndpoint endpoint, TextUnit unit, int count)
        {
            if (unit != TextUnit.Character || count == 0) return 0;
            int length = owner.TextLength, moved;
            if (endpoint == TextPatternRangeEndpoint.Start)
            {
                int target = Math.Min(end, Math.Max(0, Math.Min(length, start + count)));
                moved = target - start; start = target;
            }
            else
            {
                int target = Math.Max(start, Math.Max(0, Math.Min(length, end + count)));
                moved = target - end; end = target;
            }
            return Math.Abs(moved);
        }
        public void RemoveFromSelection() { }
        public void ScrollIntoView(bool alignToTop) { }
        public void Select()
        {
            owner.SelectCalls++;
            owner.held = new TextRange(owner, start, end - start);
        }
        public void AddToSelection() { }
        public ITextRangeProvider Clone() { return new TextRange(owner, start, end - start); }
        public IRawElementProviderSimple[] GetChildren() { return null; }
    }
}
