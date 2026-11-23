// Production UIA feature acceptance (CUA-IMPL-1123), on THIS process's own controls only.
//
// Every measured behaviour is produced by the SHIPPED worker.cs compiled into this exe; the fixture
// below is only the target. Each row is one assertion with the evidence it rests on, and the
// negative cases are as important as the positive ones:
//
//   actions   a per-control action list that matches what the executor really accepts
//             (no selectText on a password box, no setValue on a read-only value, no focus on a
//             non-focusable control, no setScrollPercent on a control with no scroll axis)
//   scroll    exact 70% vertical, the untouched horizontal axis, illegal values rejected BEFORE
//             any provider call, and direction scroll still working
//   realize   an off-screen virtualized row realised for real (provider counter moves), plus the
//             element being reported as invalidated rather than replayed
//   views     1 -> 2 for real, an unsupported id refused, a control without MultipleView refused
//   selectText default select, cursor_before / cursor_after endpoints verified against the control's
//             own ranges, repeated text disambiguated by prefix/suffix, absent text refused
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Web.Script.Serialization;
using System.Drawing;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Automation.Provider;
using System.Windows.Automation.Text;
using System.Windows.Forms;

public static class UiaFeatureProbe
{
    private static readonly List<string> output = new List<string>();
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1 << 24 };
    private static readonly Type Worker = typeof(DshComputerUse.Worker.Program);
    private static Form form;
    private static FeatureFixture fixture;
    private static long hwnd;

    private static Dictionary<string, object> Args(params object[] pairs)
    {
        var map = new Dictionary<string, object>();
        for (int index = 0; index < pairs.Length; index += 2) map[(string)pairs[index]] = pairs[index + 1];
        return map;
    }

    private static object Call(string method, Dictionary<string, object> args)
    {
        try
        {
            MethodInfo info = Worker.GetMethod(method, BindingFlags.Static | BindingFlags.NonPublic);
            if (info == null) throw new Exception("no such worker method: " + method);
            return info.Invoke(null, new object[] { args });
        }
        catch (TargetInvocationException wrapped) { throw wrapped.InnerException ?? wrapped; }
    }

    private static Dictionary<string, object> UiAct(string target, string action, Dictionary<string, object> extra = null)
    {
        var args = Args("target", target, "action", action, "settleMs", 60, "depth", 6, "maxNodes", 300);
        if (extra != null) foreach (var pair in extra) args[pair.Key] = pair.Value;
        return (Dictionary<string, object>)Call("UiaAct", args);
    }

    /// <summary>One assertion row: name, pass, and the evidence a reviewer can re-check.</summary>
    private static void Emit(string name, bool ok, object detail)
    {
        output.Add(Json.Serialize(new { name, ok, detail }));
        Console.WriteLine(output[output.Count - 1]);
    }

    private static string Failure(Exception error)
    {
        Exception inner = error is TargetInvocationException ? (((TargetInvocationException)error).InnerException ?? error) : error;
        return inner.GetType().Name + ": " + inner.Message;
    }

    [STAThread]
    public static void Main(string[] args)
    {
        string outFile = null;
        foreach (string arg in args) if (arg.StartsWith("--out=", StringComparison.Ordinal)) outFile = arg.Substring(6);
        try
        {
            Worker.Assembly.GetType("DshComputerUse.Worker.Glow").GetProperty("Enabled").SetValue(null, false, null);
            form = new Form
            {
                Text = "CUA-IMPL-1123 UIA feature fixture",
                ShowInTaskbar = false, Width = 900, Height = 640,
                StartPosition = FormStartPosition.Manual, Left = 30, Top = 40, Opacity = 0.01,
            };
            fixture = new FeatureFixture { Left = 6, Top = 6, Width = 880, Height = 600, Name = "featureFixture" };
            form.Controls.Add(fixture);
            form.Shown += delegate
            {
                hwnd = form.Handle.ToInt64();
                var thread = new Thread(Run) { IsBackground = true };
                thread.SetApartmentState(ApartmentState.MTA);
                thread.Start();
            };
            Application.Run(form);
        }
        finally
        {
            if (outFile != null) File.WriteAllText(outFile, string.Join("\n", output) + "\n", new UTF8Encoding(false));
        }
    }

    private static void Run()
    {
        try
        {
            Dictionary<string, object> observed = (Dictionary<string, object>)Call("Uia",
                Args("hwnd", hwnd, "query", true, "targets", true, "actions", true,
                     "depth", 6, "maxNodes", 300, "limit", 80, "budgetMs", 5000));
            var flat = (List<object>)observed["flat"];
            Func<string, Dictionary<string, object>> element = id =>
            {
                foreach (object candidate in flat)
                {
                    var row = (Dictionary<string, object>)candidate;
                    if (Equals(row.ContainsKey("automationId") ? row["automationId"] : null, id)) return row;
                }
                throw new Exception("fixture element not found: " + id);
            };
            Func<string, string> target = id =>
            {
                var row = element(id);
                if (!row.ContainsKey("target")) throw new Exception("no target for " + id);
                return (string)row["target"];
            };
            Func<string, List<string>> actionsOf = id =>
            {
                var row = element(id);
                if (!row.ContainsKey("actions")) return new List<string>();
                object raw = row["actions"];
                if (raw is List<string>) return (List<string>)raw;
                if (raw is object[]) return ((object[])raw).Cast<string>().ToList();
                if (raw is System.Collections.IEnumerable) return ((System.Collections.IEnumerable)raw).Cast<object>().Select(o => Convert.ToString(o)).ToList();
                return new List<string>();
            };

            ActionsGroup(element, actionsOf, target);
            ScrollGroup(target);
            RealizeGroup(target);
            ViewsGroup(target);
            // Each group is independent: one failure must not hide the rest, and it must be named.
            try { SelectTextGroup(target); }
            catch (Exception groupError) { Emit("select-group-error", false, new { error = Failure(groupError), stack = groupError.ToString() }); }
            Emit("fixture-complete", true, new { elements = flat.Count });
        }
        catch (Exception error) { Emit("fatal", false, new { error = Failure(error), stack = error.ToString() }); }
        finally { try { form.BeginInvoke(new Action(delegate { form.Close(); })); } catch { } }
    }

    // ================================== actions ==============================================
    private static void ActionsGroup(
        Func<string, Dictionary<string, object>> element,
        Func<string, List<string>> actionsOf,
        Func<string, string> target)
    {
        // Positive: a focusable, selectable, non-password editor advertises selectText and focus.
        List<string> editor = actionsOf("editor");
        Emit("actions-editor-selectable", editor.Contains("selectText") && editor.Contains("focus"),
            new { actions = editor });

        // Negative: a PASSWORD box exposes TextPattern but must never advertise selectText.
        List<string> password = actionsOf("passwordBox");
        Emit("actions-password-no-selectText", !password.Contains("selectText"),
            new { actions = password, why = "password controls expose a TextPattern yet refuse text selection" });

        // Negative: a read-only value control never advertises setValue.
        List<string> readOnly = actionsOf("readOnlyValue");
        Emit("actions-readonly-no-setValue", !readOnly.Contains("setValue"),
            new { actions = readOnly });

        // Negative: a disabled button advertises no mutation at all.
        List<string> disabled = actionsOf("disabledButton");
        Emit("actions-disabled-no-invoke", !disabled.Contains("invoke"),
            new { actions = disabled, enabled = element("disabledButton").ContainsKey("enabled") ? element("disabledButton")["enabled"] : null });

        // Negative: a disabled control must not advertise focus either, even when the provider still
        // reports IsKeyboardFocusable — a disabled control cannot actually take focus.
        Emit("actions-disabled-no-focus", !disabled.Contains("focus"),
            new { actions = disabled, note = "disabled controls report focusable on some providers yet refuse focus" });

        // Negative: a LEAF node holds ExpandCollapsePattern but cannot expand or collapse, so neither
        // direction may be advertised.
        List<string> leaf = actionsOf("leafNode");
        Emit("actions-leaf-node-no-expand-collapse",
            !leaf.Contains("expand") && !leaf.Contains("collapse"),
            new { actions = leaf, note = "ExpandCollapseState=LeafNode cannot expand" });

        // Positive control for the same filter: a genuinely collapsed node advertises expand only,
        // and an expanded one advertises collapse only.
        List<string> collapsed = actionsOf("collapsedNode");
        List<string> expanded = actionsOf("expandedNode");
        Emit("actions-expand-collapse-state-filtered",
            collapsed.Contains("expand") && !collapsed.Contains("collapse")
            && expanded.Contains("collapse") && !expanded.Contains("expand"),
            new { collapsed = collapsed, expanded = expanded });

        // A selected item in a CLEARABLE single-select list: add is impossible (no multi-select) but
        // REMOVE is legal, because the selection is not required and may be cleared. This is the case
        // a naive "no multi-select => no remove" rule gets wrong.
        List<string> clearableSingle = actionsOf("clearableSingleItem");
        Emit("actions-clearable-single-allows-remove",
            clearableSingle.Contains("select") && clearableSingle.Contains("removeFromSelection")
            && !clearableSingle.Contains("addToSelection"),
            new { actions = clearableSingle, note = "CanSelectMultiple=false, IsSelectionRequired=false, item selected" });

        // A selected item in a REQUIRED single-select list is the only selection: removing it would
        // empty a required selection, so remove must not be advertised.
        List<string> requiredSingle = actionsOf("requiredSingleItem");
        Emit("actions-required-single-no-remove",
            requiredSingle.Contains("select") && !requiredSingle.Contains("removeFromSelection")
            && !requiredSingle.Contains("addToSelection"),
            new { actions = requiredSingle, note = "IsSelectionRequired=true with one selected item" });

        // Multi-select, required selection, but TWO items selected AND this item already selected:
        // remove is legal because a non-empty selection survives. Only the last item is unremovable.
        List<string> requiredMulti = actionsOf("requiredMultiItem");
        Emit("actions-required-multi-allows-remove",
            requiredMulti.Contains("select") && requiredMulti.Contains("removeFromSelection"),
            new { actions = requiredMulti, note = "CanSelectMultiple=true, IsSelectionRequired=true, 2 selected, this one selected" });

        // Same container with only ONE item selected: now remove would empty a required selection.
        List<string> requiredMultiLast = actionsOf("requiredMultiLastItem");
        Emit("actions-required-multi-last-no-remove",
            requiredMultiLast.Contains("select") && !requiredMultiLast.Contains("removeFromSelection"),
            new { actions = requiredMultiLast, note = "the last selected item of a required selection" });

        // An UNSELECTED item in a multi-select container can be added but not removed.
        List<string> unselected = actionsOf("unselectedMultiItem");
        Emit("actions-unselected-add-only",
            unselected.Contains("addToSelection") && !unselected.Contains("removeFromSelection"),
            new { actions = unselected, note = "not selected yet" });

        // Positive controls for a plain multi-select container, in BOTH item states: an unselected
        // item may be added (but not removed), and a selected one may be removed.
        List<string> multiUnselected = actionsOf("multiSelectItem");
        Emit("actions-multi-select-add-when-unselected",
            multiUnselected.Contains("select") && multiUnselected.Contains("addToSelection")
            && !multiUnselected.Contains("removeFromSelection"),
            new { actions = multiUnselected, note = "multi-select container, this item not selected" });

        List<string> multiSelected = actionsOf("multiSelectedItem");
        Emit("actions-multi-select-remove-when-selected",
            multiSelected.Contains("select") && multiSelected.Contains("removeFromSelection"),
            new { actions = multiSelected, note = "multi-select container, this item selected" });

        // Negative: a control with neither scroll axis never advertises the scroll actions.
        List<string> noScroll = actionsOf("staticLabel");
        Emit("actions-nosroll-axis", !noScroll.Contains("setScrollPercent") && !noScroll.Contains("scroll"),
            new { actions = noScroll });

        // Negative: a control without MultipleView never advertises setCurrentView.
        List<string> plain = actionsOf("editor");
        Emit("actions-no-view-without-pattern", !plain.Contains("setCurrentView"),
            new { actions = plain });

        // Capability detail the caller needs to pick a legal value. The scroll control is
        // deliberately scrollable on BOTH axes, so the reported axes must say so.
        var scrollRow = element("scrollFixture");
        var schema = scrollRow.ContainsKey("actionSchema") ? (Dictionary<string, object>)scrollRow["actionSchema"] : new Dictionary<string, object>();
        bool schemaAccurate = schema.ContainsKey("scrollAxes")
            && Equals(((Dictionary<string, object>)schema["scrollAxes"])["vertical"], true)
            && Equals(((Dictionary<string, object>)schema["scrollAxes"])["horizontal"], true);
        Emit("actions-scroll-axes-reported", schemaAccurate, new { schema = schema.ContainsKey("scrollAxes") ? schema["scrollAxes"] : null });

        var viewRow = element("viewFixture");
        var viewSchema = viewRow.ContainsKey("actionSchema") ? (Dictionary<string, object>)viewRow["actionSchema"] : new Dictionary<string, object>();
        var views = viewSchema.ContainsKey("views") ? (List<object>)viewSchema["views"] : new List<object>();
        Emit("actions-views-reported", views.Count == 2, new { views, currentView = viewSchema.ContainsKey("currentView") ? viewSchema["currentView"] : null });

        // The default response stays lean: no actions key unless it was asked for.
        var lean = (Dictionary<string, object>)Call("Uia",
            Args("hwnd", hwnd, "query", true, "depth", 6, "maxNodes", 300, "limit", 80, "budgetMs", 4000));
        bool anyActions = ((List<object>)lean["flat"]).Cast<Dictionary<string, object>>().Any(row => row.ContainsKey("actions"));
        Emit("actions-opt-in-only", !anyActions, new { anyActions, note = "actions:true is required; a broad inventory pays nothing" });
    }

    // ================================== scroll ===============================================
    private static void ScrollGroup(Func<string, string> target)
    {
        string token = target("scrollFixture");
        // The control is scrollable on BOTH axes and starts at (35, 20), so "leave the other axis
        // alone" is provable: a correct implementation keeps 35/20 respectively instead of zeroing.
        fixture.ScrollVertical = 20; fixture.ScrollHorizontal = 35;
        Emit("scroll-starts-two-axis", Math.Abs(fixture.ScrollStartVertical - 20) < 0.5 && Math.Abs(fixture.ScrollStartHorizontal - 35) < 0.5,
            new { vertical = fixture.ScrollStartVertical, horizontal = fixture.ScrollStartHorizontal,
                  note = "both axes scrollable and non-zero, so an omitted axis must stay where it is" });

        // (35,20) -> set vertical 70 only: horizontal must stay 35.
        Dictionary<string, object> exact = UiAct(token, "setScrollPercent",
            Args("horizontalPercent", -1, "verticalPercent", 70));
        Emit("scroll-exact-70-untouched-axis",
            Math.Abs(fixture.ScrollVertical - 70) < 0.5 && Math.Abs(fixture.ScrollHorizontal - 35) < 0.5
            && Equals(exact.ContainsKey("verticalPercent") ? exact["verticalPercent"] : null, 70.0),
            new { fixtureVertical = fixture.ScrollVertical, fixtureHorizontal = fixture.ScrollHorizontal,
                  receiptVertical = exact.ContainsKey("verticalPercent") ? exact["verticalPercent"] : null,
                  receiptHorizontal = exact.ContainsKey("horizontalPercent") ? exact["horizontalPercent"] : null });

        // (35,70) -> set horizontal 0 only: vertical must stay 70.
        Dictionary<string, object> horizontalOnly = UiAct(token, "setScrollPercent",
            Args("horizontalPercent", 0, "verticalPercent", -1));
        Emit("scroll-horizontal-only-untouched-vertical",
            Math.Abs(fixture.ScrollHorizontal - 0) < 0.5 && Math.Abs(fixture.ScrollVertical - 70) < 0.5
            && Equals(horizontalOnly.ContainsKey("horizontalPercent") ? horizontalOnly["horizontalPercent"] : null, 0.0),
            new { fixtureVertical = fixture.ScrollVertical, fixtureHorizontal = fixture.ScrollHorizontal,
                  receiptVertical = horizontalOnly.ContainsKey("verticalPercent") ? horizontalOnly["verticalPercent"] : null,
                  receiptHorizontal = horizontalOnly.ContainsKey("horizontalPercent") ? horizontalOnly["horizontalPercent"] : null });

        // Omitting an axis entirely is the same "leave it" contract as -1.
        Dictionary<string, object> omitted = UiAct(token, "setScrollPercent", Args("verticalPercent", 40));
        Emit("scroll-omitted-axis-unchanged",
            Math.Abs(fixture.ScrollVertical - 40) < 0.5 && Math.Abs(fixture.ScrollHorizontal - 0) < 0.5,
            new { fixtureVertical = fixture.ScrollVertical, fixtureHorizontal = fixture.ScrollHorizontal });

        // Illegal values are refused BEFORE the provider sees anything.
        double before = fixture.ScrollVertical;
        int callsBefore = fixture.SetScrollCalls;
        string refusal101 = null, refusalNeg = null;
        try { UiAct(token, "setScrollPercent", Args("verticalPercent", 101)); } catch (Exception error) { refusal101 = Failure(error); }
        try { UiAct(token, "setScrollPercent", Args("verticalPercent", -5)); } catch (Exception error) { refusalNeg = Failure(error); }
        Emit("scroll-illegal-value-no-mutation",
            refusal101 != null && refusalNeg != null && Math.Abs(fixture.ScrollVertical - before) < 0.5
            && fixture.SetScrollCalls == callsBefore,
            new { refusal101, refusalNeg, fixtureVertical = fixture.ScrollVertical,
                  providerCallsDuringRefusals = fixture.SetScrollCalls - callsBefore });

        // No axis argument at all is an argument error, not a silent scroll.
        string refusalBoth = null;
        try { UiAct(token, "setScrollPercent", Args()); } catch (Exception error) { refusalBoth = Failure(error); }
        Emit("scroll-requires-an-axis", refusalBoth != null, new { refusalBoth });

        // A control with no scroll pattern must refuse by name, not pretend to scroll.
        string noAxis = null;
        try { UiAct(target("staticLabel"), "setScrollPercent", Args("verticalPercent", 50)); } catch (Exception error) { noAxis = Failure(error); }
        Emit("scroll-unsupported-control-refused", noAxis != null, new { noAxis });

        // A control that scrolls vertically ONLY must refuse a horizontal request by name, and must
        // still accept a vertical one — that is what "unsupported axis" means in practice.
        string noHorizontal = null;
        double verticalBeforeRefusal = fixture.VerticalOnlyPercent;
        try { UiAct(target("verticalOnly"), "setScrollPercent", Args("horizontalPercent", 30, "verticalPercent", -1)); }
        catch (Exception error) { noHorizontal = Failure(error); }
        Dictionary<string, object> verticalAccepted = null;
        try { verticalAccepted = UiAct(target("verticalOnly"), "setScrollPercent", Args("verticalPercent", 55)); }
        catch (Exception error) { verticalAccepted = Args("error", Failure(error)); }
        Emit("scroll-unavailable-axis-refused",
            noHorizontal != null && noHorizontal.Contains("SCROLL_AXIS_UNAVAILABLE")
            && Math.Abs(fixture.VerticalOnlyPercent - 55) < 0.5,
            new { noHorizontal, verticalBeforeRefusal, verticalAfter = fixture.VerticalOnlyPercent,
                  verticalAccepted = verticalAccepted.ContainsKey("verticalPercent") ? verticalAccepted["verticalPercent"] : null });

        // Direction scrolling still works exactly as before.
        int rowsBefore = fixture.TopRow;
        Dictionary<string, object> direction = UiAct(token, "scroll", Args("value", "down"));
        Emit("scroll-direction-still-works", fixture.TopRow > rowsBefore,
            new { rowsBefore, rowsAfter = fixture.TopRow, via = direction.ContainsKey("via") ? direction["via"] : null });
    }

    // ================================== realize ==============================================
    private static void RealizeGroup(Func<string, string> target)
    {
        // A row that starts off-screen and unrealised. The row id is chosen from what the fixture
        // itself reports, so the case cannot depend on a guessed index.
        fixture.Realized.Clear();
        var observed = (Dictionary<string, object>)Call("Uia",
            Args("hwnd", hwnd, "query", true, "targets", true, "actions", true,
                 "depth", 6, "maxNodes", 300, "limit", 80, "budgetMs", 5000));
        var allRows = ((List<object>)observed["flat"]).Cast<Dictionary<string, object>>()
            .Where(row => row.ContainsKey("automationId") && Convert.ToString(row["automationId"]).StartsWith("row-"))
            .ToList();
        // The worker reports IsOffscreen as "isOffscreen".
        var offscreenRow = allRows.FirstOrDefault(row => row.ContainsKey("isOffscreen") && Equals(row["isOffscreen"], true));
        if (offscreenRow == null)
        {
            Emit("realize-row-offscreen-first", false, new { rowsSeen = allRows.Count,
                ids = allRows.Select(row => Convert.ToString(row["automationId"])).Take(20).ToArray(),
                why = "no offscreen row was observed in the fixture tree" });
            return;
        }
        string rowId = Convert.ToString(offscreenRow["automationId"]);
        // Targets are only issued for elements with a native runtime id; a row fragment that cannot
        // be targeted is reported as such, and a different one is tried.
        if (!offscreenRow.ContainsKey("target"))
        {
            var retry = (Dictionary<string, object>)Call("Uia",
                Args("hwnd", hwnd, "query", true, "targets", true, "automationId", rowId,
                     "depth", 6, "maxNodes", 300, "limit", 5, "budgetMs", 5000));
            var retryRows = (List<object>)retry["flat"];
            if (retryRows.Count > 0) offscreenRow = (Dictionary<string, object>)retryRows[0];
        }
        Emit("realize-row-offscreen-first", offscreenRow.ContainsKey("target"),
            new { rowId, rowsSeen = allRows.Count, targetIssued = offscreenRow.ContainsKey("target") });
        if (!offscreenRow.ContainsKey("target")) { Emit("realize-target-available", false, new { rowId, why = "no target issued" }); return; }
        int rowIndex;
        if (!Int32.TryParse(rowId.Substring("row-".Length), out rowIndex)) { Emit("realize-target-available", false, new { rowId }); return; }

        int callsBefore = fixture.RealizeCalls;
        Dictionary<string, object> receipt = UiAct((string)offscreenRow["target"], "realize");
        Emit("realize-provider-called",
            fixture.RealizeCalls == callsBefore + 1 && fixture.Realized.Contains(rowIndex)
            && Equals(receipt.ContainsKey("realized") ? receipt["realized"] : null, true),
            new { rowIndex, providerCalls = fixture.RealizeCalls - callsBefore, realizedRows = fixture.Realized.ToArray() });

        // The receipt must tell the caller to re-observe instead of replaying, and a dead element
        // must be reported as such rather than failing the successful action.
        Emit("realize-requires-reobserve",
            Equals(receipt.ContainsKey("reobserveRequired") ? receipt["reobserveRequired"] : null, true),
            new { receipt = new { realized = receipt.ContainsKey("realized") ? receipt["realized"] : null, reobserveRequired = receipt.ContainsKey("reobserveRequired") ? receipt["reobserveRequired"] : null, elementUnavailable = receipt.ContainsKey("elementUnavailable") ? receipt["elementUnavailable"] : null } });

        // A control without VirtualizedItem must refuse.
        string refused = null;
        try { UiAct(target("editor"), "realize"); } catch (Exception error) { refused = Failure(error); }
        Emit("realize-unsupported-control-refused", refused != null, new { refused });
    }

    // ================================== views ================================================
    private static void ViewsGroup(Func<string, string> target)
    {
        string token = target("viewFixture");
        Emit("views-start-at-one", fixture.CurrentViewId == 1, new { view = fixture.CurrentViewId, switches = fixture.ViewSwitches });

        Dictionary<string, object> switched = UiAct(token, "setCurrentView", Args("value", "2"));
        Emit("views-switch-one-to-two",
            fixture.CurrentViewId == 2 && Equals(switched.ContainsKey("viewChanged") ? switched["viewChanged"] : null, true)
            && Equals(switched.ContainsKey("currentView") ? switched["currentView"] : null, 2),
            new { fixtureView = fixture.CurrentViewId, receipt = new { currentView = switched.ContainsKey("currentView") ? switched["currentView"] : null, beforeView = switched.ContainsKey("beforeView") ? switched["beforeView"] : null } });

        // An id the provider does not report must be refused before any switch.
        string unsupported = null;
        int switchesBefore = fixture.ViewSwitches;
        try { UiAct(token, "setCurrentView", Args("value", "99")); } catch (Exception error) { unsupported = Failure(error); }
        Emit("views-unsupported-id-refused",
            unsupported != null && unsupported.Contains("VIEW_ID_UNSUPPORTED") && fixture.ViewSwitches == switchesBefore,
            new { unsupported, switches = fixture.ViewSwitches - switchesBefore });

        // A non-numeric id is an argument error.
        string nonNumeric = null;
        try { UiAct(token, "setCurrentView", Args("value", "two")); } catch (Exception error) { nonNumeric = Failure(error); }
        Emit("views-non-numeric-refused", nonNumeric != null, new { nonNumeric });

        // A control without MultipleViewPattern refuses.
        string noPattern = null;
        try { UiAct(target("editor"), "setCurrentView", Args("value", "2")); } catch (Exception error) { noPattern = Failure(error); }
        Emit("views-unsupported-control-refused", noPattern != null, new { noPattern });
    }

    // ================================== selectText ===========================================
    private static void SelectTextGroup(Func<string, string> target)
    {
        // Text selection runs on the counting editor, whose OWN provider implements the text range.
        // A stock WinForms box is served by the OS proxy, and that proxy moves endpoints by sending
        // keyboard input (Misc.SetFocus -> SendInput), which a non-input private desktop cannot do —
        // so the proxy would make this a test of input delivery, not of our selection logic.
        Func<Dictionary<string, object>> observeCounting = () =>
        {
            var observed = (Dictionary<string, object>)Call("Uia",
                Args("hwnd", hwnd, "query", true, "targets", true, "automationId", "countingEditor",
                     "depth", 6, "maxNodes", 300, "limit", 5, "budgetMs", 5000));
            var rows = (List<object>)observed["flat"];
            return rows.Count > 0 ? (Dictionary<string, object>)rows[0] : null;
        };
        var first = observeCounting();
        if (first == null || !first.ContainsKey("target"))
        {
            Emit("select-target-available", false, new { why = "countingEditor target not issued" });
            return;
        }
        string token = (string)first["target"];
        // The counting editor's text: "counting editor value=alpha tail. value=alpha 杭州 Résumé end."
        // "value=alpha" occurs twice; "editor " pins the first at offset 15, " 杭州" pins the second at 35.

        // Default: select = the whole matched passage. Offsets are read back from the fixture's OWN
        // provider range (HeldStart/HeldLength), so the assertion cannot be self-confirming.
        Dictionary<string, object> plain = UiAct(token, "selectText", Args("value", "value=alpha", "prefix", "editor "));
        Emit("select-default-whole-range",
            Equals(plain.ContainsKey("selectionVerified") ? plain["selectionVerified"] : null, true)
            && Equals(plain.ContainsKey("collapsed") ? plain["collapsed"] : null, false)
            && fixture.HeldStart == 16 && fixture.HeldLength == 11
            && fixture.HeldText == "value=alpha",
            new { heldStart = fixture.HeldStart, heldLength = fixture.HeldLength, heldText = fixture.HeldText,
                  startMatches = plain.ContainsKey("startMatches") ? plain["startMatches"] : null,
                  endMatches = plain.ContainsKey("endMatches") ? plain["endMatches"] : null });

        // cursor_before collapses the SAME range onto its start; cursor_after onto its end.
        Dictionary<string, object> before = UiAct(token, "selectText",
            Args("value", "value=alpha", "prefix", "editor ", "selectionType", "cursor_before"));
        Emit("select-cursor-before",
            Equals(before.ContainsKey("collapsed") ? before["collapsed"] : null, true)
            && Equals(before.ContainsKey("selectionVerified") ? before["selectionVerified"] : null, true)
            && fixture.HeldStart == 16 && fixture.HeldLength == 0,
            new { heldStart = fixture.HeldStart, heldLength = fixture.HeldLength });

        Dictionary<string, object> after = UiAct(token, "selectText",
            Args("value", "value=alpha", "prefix", "editor ", "selectionType", "cursor_after"));
        Emit("select-cursor-after",
            Equals(after.ContainsKey("collapsed") ? after["collapsed"] : null, true)
            && Equals(after.ContainsKey("selectionVerified") ? after["selectionVerified"] : null, true)
            && fixture.HeldStart == 27 && fixture.HeldLength == 0,
            new { heldStart = fixture.HeldStart, heldLength = fixture.HeldLength });

        // Repeated text without context is still ambiguous, and context resolves it.
        string ambiguous = null;
        try { UiAct(token, "selectText", Args("value", "value=alpha")); } catch (Exception error) { ambiguous = Failure(error); }
        Emit("select-repeated-still-ambiguous", ambiguous != null && ambiguous.Contains("AMBIGUOUS_TEXT"), new { ambiguous });

        Dictionary<string, object> second = UiAct(token, "selectText", Args("value", "value=alpha", "suffix", " 杭州"));
        Emit("select-suffix-disambiguates",
            second.ContainsKey("selectionVerified") && Equals(second["selectionVerified"], true)
            && fixture.HeldText == "value=alpha" && fixture.HeldStart == 34,
            new { heldStart = fixture.HeldStart, heldText = fixture.HeldText });

        // Missing text and an invalid selectionType are refused, and the selection is unchanged.
        string absent = null;
        int startBefore = fixture.HeldStart, lengthBefore = fixture.HeldLength;
        try { UiAct(token, "selectText", Args("value", "no-such-text")); } catch (Exception error) { absent = Failure(error); }
        Emit("select-absent-refused",
            absent != null && absent.Contains("TEXT_NOT_FOUND")
            && fixture.HeldStart == startBefore && fixture.HeldLength == lengthBefore,
            new { absent, selectionUnchanged = fixture.HeldStart == startBefore && fixture.HeldLength == lengthBefore });

        string badType = null;
        int startBeforeType = fixture.HeldStart, lengthBeforeType = fixture.HeldLength;
        try { UiAct(token, "selectText", Args("value", "value=alpha", "selectionType", "cursor_sideways")); } catch (Exception error) { badType = Failure(error); }
        Emit("select-bad-selectionType-refused",
            badType != null && badType.Contains("INVALID_ARGUMENT")
            && fixture.HeldStart == startBeforeType && fixture.HeldLength == lengthBeforeType,
            new { badType, selectionUnchanged = fixture.HeldStart == startBeforeType && fixture.HeldLength == lengthBeforeType });

        // Unicode and CJK selection still work through our own range implementation.
        Dictionary<string, object> cjk = UiAct(token, "selectText", Args("value", "杭州 Résumé"));
        Emit("select-unicode-offsets",
            cjk.ContainsKey("selectionVerified") && Equals(cjk["selectionVerified"], true)
            && fixture.HeldText == "杭州 Résumé" && fixture.HeldStart == 46,
            new { heldStart = fixture.HeldStart, heldText = fixture.HeldText });

        // QA2 negative: a provider that ACCEPTS Select() but keeps a DIFFERENT single range must not
        // be reported as verified. Run on the counting editor, which demonstrates exactly that.
        var stubbornRow = (Dictionary<string, object>)Call("Uia",
            Args("hwnd", hwnd, "query", true, "targets", true, "automationId", "countingEditor",
                 "depth", 6, "maxNodes", 300, "limit", 5, "budgetMs", 5000));
        var stubbornRows = (List<object>)stubbornRow["flat"];
        if (stubbornRows.Count == 0 || !((Dictionary<string, object>)stubbornRows[0]).ContainsKey("target"))
        {
            Emit("select-wrong-range-not-verified", false, new { why = "countingEditor target not issued" });
        }
        else
        {
            string stubbornToken = (string)((Dictionary<string, object>)stubbornRows[0])["target"];
            fixture.StubbornSelect = true;
            Dictionary<string, object> stubborn = UiAct(stubbornToken, "selectText", Args("value", "value=alpha", "prefix", "editor "));
            fixture.StubbornSelect = false;
            Emit("select-wrong-range-not-verified",
                stubborn.ContainsKey("selectionVerified") && Equals(stubborn["selectionVerified"], false)
                && stubborn.ContainsKey("startMatches") && Equals(stubborn["startMatches"], false),
                new { receiptVerified = stubborn.ContainsKey("selectionVerified") ? stubborn["selectionVerified"] : null,
                      startMatches = stubborn.ContainsKey("startMatches") ? stubborn["startMatches"] : null,
                      endMatches = stubborn.ContainsKey("endMatches") ? stubborn["endMatches"] : null });
        }

        // ONESELECT: exactly ONE provider Select() per request, for all three modes.
        var countingRow = (Dictionary<string, object>)Call("Uia",
            Args("hwnd", hwnd, "query", true, "targets", true, "automationId", "countingEditor",
                 "depth", 6, "maxNodes", 300, "limit", 5, "budgetMs", 5000));
        var countingRows = (List<object>)countingRow["flat"];
        if (countingRows.Count == 0 || !((Dictionary<string, object>)countingRows[0]).ContainsKey("target"))
        {
            Emit("select-exactly-one-commit", false, new { why = "countingEditor target not issued" });
        }
        else
        {
            string countingToken = (string)((Dictionary<string, object>)countingRows[0])["target"];
            var calls = new List<object>();
            bool allOne = true;
            foreach (string mode in new[] { "select", "cursor_before", "cursor_after" })
            {
                int beforeCalls = fixture.Counting.SelectCalls;
                var extra = Args("value", "value=alpha", "prefix", "editor ");
                if (mode != "select") extra["selectionType"] = mode;
                UiAct(countingToken, "selectText", extra);
                int delta = fixture.Counting.SelectCalls - beforeCalls;
                calls.Add(new { mode, selectCalls = delta });
                if (delta != 1) allOne = false;
            }
            Emit("select-exactly-one-commit", allOne, new { calls,
                note = "the provider counts Select(); one request must commit exactly once" });
        }

        // A control that is not selectable refuses by name.
        var passwordRow = (Dictionary<string, object>)Call("Uia",
            Args("hwnd", hwnd, "query", true, "targets", true, "automationId", "passwordBox",
                 "depth", 6, "maxNodes", 300, "limit", 5, "budgetMs", 5000));
        var passwordRows = (List<object>)passwordRow["flat"];
        string notSelectable = null;
        if (passwordRows.Count > 0 && ((Dictionary<string, object>)passwordRows[0]).ContainsKey("target"))
        {
            try { UiAct((string)((Dictionary<string, object>)passwordRows[0])["target"], "selectText", Args("value", "x")); }
            catch (Exception error) { notSelectable = Failure(error); }
        }
        else notSelectable = "password target unavailable";
        Emit("select-password-refused", notSelectable != null, new { notSelectable });
    }
}

/// <summary>Fixture controls for the CUA-IMPL-1123 acceptance. Owned by this process only.</summary>
public sealed class FeatureFixture : Control
{
    internal readonly TextBox Editor;
    internal readonly CountingEditor Counting;
    internal readonly TextBox Password;
    internal readonly TextBox ReadOnlyValue;
    internal readonly Button DisabledButton;
    internal readonly Label StaticLabel;
    internal readonly ScrollPanel ScrollSurface;
    internal readonly VerticalOnlyPanel VerticalOnly;

    // Action-availability fixtures: each reports a DIFFERENT real state, so the capability list can
    // be checked against what the control actually is rather than against a pattern's presence.
    internal readonly StatusSurface LeafNode;
    internal readonly StatusSurface CollapsedNode;
    internal readonly StatusSurface ExpandedNode;
    internal readonly StatusSurface SingleSelectItem;
    internal readonly StatusSurface RequiredMultiItem;
    internal readonly StatusSurface MultiSelectItem;
    internal readonly StatusSurface ClearableSingleItem;
    internal readonly StatusSurface RequiredSingleItem;
    internal readonly StatusSurface RequiredMultiLastItem;
    internal readonly StatusSurface UnselectedMultiItem;
    internal readonly StatusSurface MultiSelectedItem;
    internal readonly ViewPanel ViewSurface;

    internal FeatureFixture()
    {
        Editor = new TextBox
        {
            Left = 6, Top = 6, Width = 620, Height = 120, Multiline = true, Name = "editor",
            Text = "header one alpha value=alpha tail. The quick brown fox jumps. value=alpha. "
                 + "The quick brown fox jumps. value=beta 杭州 Résumé jumps.",
        };
        Editor.AccessibleName = "editor";
        Controls.Add(Editor);

        // A second editor whose provider COUNTS Select() calls, so "exactly one commit per request"
        // is measured at the provider boundary instead of inferred from the receipt.
        Counting = new CountingEditor
        {
            Left = 6, Top = 132, Width = 620, Height = 90, Multiline = true, Name = "countingEditor",
            Text = "counting editor value=alpha tail. value=alpha 杭州 Résumé end.",
        };
        Counting.AccessibleName = "countingEditor";
        Controls.Add(Counting);

        Password = new TextBox { Left = 640, Top = 6, Width = 220, Height = 24, Name = "passwordBox", UseSystemPasswordChar = true, Text = "secret" };
        Password.AccessibleName = "passwordBox";
        Controls.Add(Password);

        ReadOnlyValue = new TextBox { Left = 640, Top = 40, Width = 220, Height = 24, Name = "readOnlyValue", ReadOnly = true, Text = "immutable" };
        ReadOnlyValue.AccessibleName = "readOnlyValue";
        Controls.Add(ReadOnlyValue);

        DisabledButton = new Button { Left = 640, Top = 74, Width = 220, Height = 30, Name = "disabledButton", Text = "disabled", Enabled = false };
        Controls.Add(DisabledButton);

        // A control that scrolls VERTICALLY ONLY: the axis refusal case. It must stay distinct from
        // the two-axis control, which can no longer prove that refusing an unavailable axis works.
        VerticalOnly = new VerticalOnlyPanel { Left = 440, Top = 466, Width = 420, Height = 120, Name = "verticalOnly" };
        VerticalOnly.AccessibleName = "verticalOnly";
        Controls.Add(VerticalOnly);

        // Six one-state controls for the action filter. They live in a hidden strip so the window
        // layout the other cases measure does not move.
        int stripLeft = 880;
        LeafNode = new StatusSurface { Left = stripLeft, Top = 6, Width = 60, Height = 20, Name = "leafNode" };
        CollapsedNode = new StatusSurface { Left = stripLeft, Top = 30, Width = 60, Height = 20, Name = "collapsedNode" };
        ExpandedNode = new StatusSurface { Left = stripLeft, Top = 54, Width = 60, Height = 20, Name = "expandedNode" };
        SingleSelectItem = new StatusSurface { Left = stripLeft, Top = 78, Width = 60, Height = 20, Name = "singleSelectItem" };
        RequiredMultiItem = new StatusSurface { Left = stripLeft, Top = 102, Width = 60, Height = 20, Name = "requiredMultiItem" };
        MultiSelectItem = new StatusSurface { Left = stripLeft, Top = 126, Width = 60, Height = 20, Name = "multiSelectItem" };
        ClearableSingleItem = new StatusSurface { Left = stripLeft, Top = 150, Width = 60, Height = 20, Name = "clearableSingleItem" };
        RequiredSingleItem = new StatusSurface { Left = stripLeft, Top = 174, Width = 60, Height = 20, Name = "requiredSingleItem" };
        RequiredMultiLastItem = new StatusSurface { Left = stripLeft, Top = 198, Width = 60, Height = 20, Name = "requiredMultiLastItem" };
        UnselectedMultiItem = new StatusSurface { Left = stripLeft, Top = 222, Width = 60, Height = 20, Name = "unselectedMultiItem" };
        MultiSelectedItem = new StatusSurface { Left = stripLeft, Top = 246, Width = 60, Height = 20, Name = "multiSelectedItem" };

        LeafNode.ExpandState = UiaExpandState.Leaf;
        CollapsedNode.ExpandState = UiaExpandState.Collapsed;
        ExpandedNode.ExpandState = UiaExpandState.Expanded;

        // Every selection fixture states the two facts the filter reads: selected, and how many.
        SingleSelectItem.Selection = UiaSelection.Single;                 // required, only one
        RequiredMultiItem.Selection = UiaSelection.RequiredMultiple;      // required, 2 selected
        RequiredMultiItem.SelectedCount = 2;
        MultiSelectItem.Selection = UiaSelection.Multiple;                // free, and THIS one unselected
        MultiSelectItem.ItemSelected = false;
        MultiSelectItem.SelectedCount = 2;
        ClearableSingleItem.Selection = UiaSelection.ClearableSingle;     // NOT required, one selected
        ClearableSingleItem.ItemSelected = true;
        RequiredSingleItem.Selection = UiaSelection.Single;               // required, the only one
        RequiredSingleItem.ItemSelected = true;
        RequiredMultiLastItem.Selection = UiaSelection.RequiredMultiple;  // required, just this one
        RequiredMultiLastItem.SelectedCount = 1;
        UnselectedMultiItem.Selection = UiaSelection.Multiple;            // free, NOT selected
        UnselectedMultiItem.ItemSelected = false;
        UnselectedMultiItem.SelectedCount = 2;
        MultiSelectedItem.Selection = UiaSelection.Multiple;              // free, this one selected
        MultiSelectedItem.ItemSelected = true;
        MultiSelectedItem.SelectedCount = 2;

        foreach (var surface in new[] { LeafNode, CollapsedNode, ExpandedNode, SingleSelectItem, RequiredMultiItem,
            MultiSelectItem, ClearableSingleItem, RequiredSingleItem, RequiredMultiLastItem, UnselectedMultiItem, MultiSelectedItem })
        {
            surface.AccessibleName = surface.Name;
            Controls.Add(surface);
        }

        // A control with NO scroll pattern at all: the "unsupported control" negative case.
        StaticLabel = new Label { Left = 6, Top = 132, Width = 620, Height = 18, Name = "staticLabel", Text = "static, not scrollable" };
        StaticLabel.AccessibleName = "staticLabel";
        Controls.Add(StaticLabel);

        ScrollSurface = new ScrollPanel { Left = 6, Top = 156, Width = 420, Height = 300, Name = "scrollFixture" };
        Controls.Add(ScrollSurface);

        ViewSurface = new ViewPanel { Left = 440, Top = 156, Width = 420, Height = 300, Name = "viewFixture" };
        Controls.Add(ViewSurface);
    }

    internal TextBox TextControl { get { return Editor; } }
    // The QA2 negative case needs a provider that accepts Select() but retains a different range.
    // The counting editor already can do that, so it doubles as the stubborn control.
    internal bool StubbornSelect { set { Counting.Stubborn = value; } }
    // What the control's OWN provider currently holds, for assertions that cannot be self-confirming.
    internal int HeldStart { get { return Counting.HeldStart; } }
    internal int HeldLength { get { return Counting.HeldLength; } }
    internal string HeldText { get { return Counting.HeldText; } }
    internal int TopRow { get { return ScrollSurface.TopRow; } }
    internal double ScrollVertical { get { return ScrollSurface.VerticalPercent; } set { ScrollSurface.VerticalPercent = value; } }
    internal double ScrollHorizontal { get { return ScrollSurface.HorizontalPercent; } set { ScrollSurface.HorizontalPercent = value; } }
    // The values the provider was constructed with, so "it started non-zero" is not a claim this
    // test makes about itself after mutating the control.
    internal double ScrollStartVertical { get { return ScrollSurface.StartVertical; } }
    internal double ScrollStartHorizontal { get { return ScrollSurface.StartHorizontal; } }
    internal double VerticalOnlyPercent { get { return VerticalOnly.VerticalPercent; } }
    internal int SetScrollCalls { get { return ScrollSurface.SetPercentCalls; } }
    internal int RealizeCalls { get { return ViewSurface.RealizeCalls; } }
    internal HashSet<int> Realized { get { return ViewSurface.Realized; } }
    internal int CurrentViewId { get { return ViewSurface.CurrentViewId; } }
    internal int ViewSwitches { get { return ViewSurface.ViewSwitches; } }
}

/// <summary>
/// A text control whose ITextProvider counts Select() calls and can deliberately retain the WRONG
/// range: that is how "the provider accepted Select but kept a different selection" is measurable.
/// </summary>
public sealed class CountingEditor : TextBox
{
    internal int SelectCalls;
    internal bool Stubborn;
    private Provider provider;
    private Range held;

    internal int HeldStart { get { return held == null ? 0 : held.StartOffset; } }
    internal int HeldLength { get { return held == null ? 0 : held.Length; } }
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

    internal CountingEditor()
    {
        Multiline = true;
        provider = new Provider(this);
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

    private sealed class Provider : IRawElementProviderSimple, ITextProvider
    {
        private readonly CountingEditor owner;
        internal Provider(CountingEditor owner) { this.owner = owner; }
        public ProviderOptions ProviderOptions { get { return ProviderOptions.ServerSideProvider; } }
        public IRawElementProviderSimple HostRawElementProvider { get { return AutomationInteropProvider.HostProviderFromHandle(owner.Handle); } }
        public object GetPatternProvider(int patternId) { return patternId == TextPattern.Pattern.Id ? this : null; }
        public object GetPropertyValue(int propertyId)
        {
            if (propertyId == AutomationElementIdentifiers.NameProperty.Id) return "counting editor";
            if (propertyId == AutomationElementIdentifiers.AutomationIdProperty.Id) return "countingEditor";
            if (propertyId == AutomationElementIdentifiers.ControlTypeProperty.Id) return ControlType.Edit.Id;
            if (propertyId == AutomationElementIdentifiers.IsEnabledProperty.Id) return owner.Enabled;
            if (propertyId == AutomationElementIdentifiers.IsKeyboardFocusableProperty.Id) return true;
            if (propertyId == AutomationElementIdentifiers.ProcessIdProperty.Id) return Process.GetCurrentProcess().Id;
            return null;
        }
        public ITextRangeProvider[] GetSelection()
        {
            // While Stubborn, the control reports a DIFFERENT single range than the one selected.
            var range = owner.held ?? new Range(owner, 0, 0);
            return new ITextRangeProvider[] { range };
        }
        public ITextRangeProvider[] GetVisibleRanges() { return new ITextRangeProvider[] { new Range(owner, 0, owner.TextLength) }; }
        public ITextRangeProvider RangeFromChild(IRawElementProviderSimple child) { return null; }
        public ITextRangeProvider RangeFromPoint(System.Windows.Point point) { return new Range(owner, 0, 0); }
        public ITextRangeProvider DocumentRange { get { return new Range(owner, 0, owner.TextLength); } }
        public SupportedTextSelection SupportedTextSelection { get { return SupportedTextSelection.Single; } }
    }

    private sealed class Range : ITextRangeProvider
    {
        private readonly CountingEditor owner;
        private int start, end;
        internal Range(CountingEditor owner, int start, int length) { this.owner = owner; this.start = start; this.end = start + length; }
        internal int StartOffset { get { return start; } }
        internal int Length { get { return Math.Max(0, end - start); } }
        public bool Compare(ITextRangeProvider range)
        {
            var other = range as Range;
            return other != null && other.start == start && other.end == end;
        }
        public int CompareEndpoints(TextPatternRangeEndpoint endpoint, ITextRangeProvider target, TextPatternRangeEndpoint targetEndpoint)
        {
            var other = (Range)target;
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
            return found < 0 ? null : new Range(owner, start + found, text.Length);
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
            var other = (Range)target;
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
        /// <summary>The counted commit. A stubborn control keeps a different range on purpose.</summary>
        public void Select()
        {
            owner.SelectCalls++;
            owner.held = owner.Stubborn ? new Range(owner, 0, 1) : new Range(owner, start, end - start);
        }
        public void AddToSelection() { }
        public ITextRangeProvider Clone() { return new Range(owner, start, end - start); }
        public IRawElementProviderSimple[] GetChildren() { return null; }
    }
}

/// <summary>Which ExpandCollapseState a StatusSurface reports.</summary>
public enum UiaExpandState { None, Leaf, Collapsed, Expanded }

/// <summary>Which selection shape a StatusSurface reports.</summary>
public enum UiaSelection { None, Single, RequiredMultiple, Multiple, ClearableSingle }

/// <summary>
/// A control whose provider reports ONE specific real state, so the action filter can be checked
/// against a genuine ExpandCollapseState / selection container rather than a guess.
/// </summary>
public sealed class StatusSurface : Control
{
    internal UiaExpandState ExpandState = UiaExpandState.None;
    internal UiaSelection Selection = UiaSelection.None;
    // The two facts the remove/add decision turns on: is THIS item selected, and how many are.
    // Defaults describe the common case measured here: an item that IS selected.
    internal bool ItemSelected = true;
    internal int SelectedCount = 1;
    private readonly Provider provider;
    private readonly ContainerProvider container;

    internal StatusSurface()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
        BackColor = Color.WhiteSmoke;
        provider = new Provider(this);
        container = new ContainerProvider(this);
    }

    internal bool HasExpand { get { return ExpandState != UiaExpandState.None; } }
    internal bool HasSelection { get { return Selection != UiaSelection.None; } }
    internal bool CanSelectMultiple { get { return Selection == UiaSelection.Multiple || Selection == UiaSelection.RequiredMultiple; } }
    internal bool IsSelectionRequired { get { return Selection != UiaSelection.Multiple && Selection != UiaSelection.ClearableSingle; } }
    internal IRawElementProviderSimple ItemProvider() { return new Provider(this).SelfSimple; }

    protected override void OnPaint(PaintEventArgs args)
    {
        args.Graphics.Clear(Color.WhiteSmoke);
        args.Graphics.DrawString(Name ?? "surface", Font, Brushes.Black, 2, 2);
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

    /// <summary>
    /// The container a SelectionItem reports. It exposes a REAL ISelectionProvider so the client can
    /// read CanSelectMultiple / IsSelectionRequired through the pattern the shipped code queries.
    /// </summary>
    internal sealed class ContainerProvider : IRawElementProviderSimple, ISelectionProvider
    {
        private readonly StatusSurface owner;
        internal ContainerProvider(StatusSurface owner) { this.owner = owner; }
        public ProviderOptions ProviderOptions { get { return ProviderOptions.ServerSideProvider | ProviderOptions.UseComThreading; } }
        public IRawElementProviderSimple HostRawElementProvider { get { return null; } }
        public object GetPatternProvider(int patternId) { return patternId == SelectionPattern.Pattern.Id ? this : null; }
        public object GetPropertyValue(int propertyId)
        {
            if (propertyId == AutomationElementIdentifiers.NameProperty.Id) return "container of " + owner.Name;
            if (propertyId == AutomationElementIdentifiers.AutomationIdProperty.Id) return "container-" + owner.Name;
            if (propertyId == AutomationElementIdentifiers.ControlTypeProperty.Id) return ControlType.List.Id;
            if (propertyId == AutomationElementIdentifiers.IsEnabledProperty.Id) return true;
            if (propertyId == AutomationElementIdentifiers.IsOffscreenProperty.Id) return false;
            if (propertyId == AutomationElementIdentifiers.ProcessIdProperty.Id) return System.Diagnostics.Process.GetCurrentProcess().Id;
            return null;
        }
        // ---- ISelectionProvider: the live capability the action filter must honour ----
        public bool CanSelectMultiple { get { return owner.CanSelectMultiple; } }
        public bool IsSelectionRequired { get { return owner.IsSelectionRequired; } }
        public IRawElementProviderSimple[] GetSelection()
        {
            // The SELECTED COUNT is what decides whether a required selection still allows remove.
            var selected = new List<IRawElementProviderSimple>();
            for (int index = 0; index < Math.Max(0, owner.SelectedCount); index++) selected.Add(owner.ItemProvider());
            return selected.ToArray();
        }
    }

    private sealed class Provider : IRawElementProviderSimple
    {
        private readonly StatusSurface owner;
        internal Provider(StatusSurface owner) { this.owner = owner; }
        internal IRawElementProviderSimple SelfSimple { get { return this; } }
        public ProviderOptions ProviderOptions { get { return ProviderOptions.ServerSideProvider | ProviderOptions.UseComThreading; } }
        public IRawElementProviderSimple HostRawElementProvider { get { return AutomationInteropProvider.HostProviderFromHandle(owner.Handle); } }
        public object GetPatternProvider(int patternId)
        {
            if (owner.HasExpand && patternId == ExpandCollapsePattern.Pattern.Id) return new Expander(owner);
            if (owner.HasSelection && patternId == SelectionItemPattern.Pattern.Id) return new Item(owner);
            return null;
        }
        internal object providerExpander { get { return new Expander(owner); } }
        internal object providerItem { get { return new Item(owner); } }
        public object GetPropertyValue(int propertyId)
        {
            if (propertyId == AutomationElementIdentifiers.NameProperty.Id) return owner.Name;
            if (propertyId == AutomationElementIdentifiers.AutomationIdProperty.Id) return owner.Name;
            if (propertyId == AutomationElementIdentifiers.ControlTypeProperty.Id) return ControlType.ListItem.Id;
            if (propertyId == AutomationElementIdentifiers.IsEnabledProperty.Id) return true;
            if (propertyId == AutomationElementIdentifiers.IsOffscreenProperty.Id) return false;
            if (propertyId == AutomationElementIdentifiers.IsKeyboardFocusableProperty.Id) return true;
            if (propertyId == AutomationElementIdentifiers.ProcessIdProperty.Id) return Process.GetCurrentProcess().Id;
            return null;
        }
    }

    private sealed class Expander : IExpandCollapseProvider
    {
        private readonly StatusSurface owner;
        internal Expander(StatusSurface owner) { this.owner = owner; }
        public ExpandCollapseState ExpandCollapseState
        {
            get
            {
                switch (owner.ExpandState)
                {
                    case UiaExpandState.Collapsed: return ExpandCollapseState.Collapsed;
                    case UiaExpandState.Expanded: return ExpandCollapseState.Expanded;
                    default: return ExpandCollapseState.LeafNode;
                }
            }
        }
        public void Expand()
        {
            if (ExpandCollapseState != ExpandCollapseState.Collapsed)
                throw new InvalidOperationException("this node cannot be expanded");
            owner.ExpandState = UiaExpandState.Expanded;
        }
        public void Collapse()
        {
            if (ExpandCollapseState != ExpandCollapseState.Expanded)
                throw new InvalidOperationException("this node cannot be collapsed");
            owner.ExpandState = UiaExpandState.Collapsed;
        }
    }

    private sealed class Item : ISelectionItemProvider
    {
        private readonly StatusSurface owner;
        internal Item(StatusSurface owner) { this.owner = owner; }
        public bool IsSelected { get { return owner.ItemSelected; } }
        public IRawElementProviderSimple SelectionContainer { get { return owner.container; } }
        public void Select() { }
        public void AddToSelection()
        {
            if (!owner.CanSelectMultiple) throw new InvalidOperationException("single selection container");
            if (owner.ItemSelected) throw new InvalidOperationException("item is already selected");
        }
        public void RemoveFromSelection()
        {
            // Mirrors the real contract: removing the only remaining item of a REQUIRED selection is
            // refused, while any other selected item may be removed.
            if (owner.IsSelectionRequired && owner.SelectedCount <= 1)
                throw new InvalidOperationException("cannot clear a required selection");
            if (!owner.ItemSelected) throw new InvalidOperationException("item is not selected");
        }
    }
}

/// <summary>Vertical-only scroll: the control that must refuse a horizontal percentage.</summary>
public sealed class VerticalOnlyPanel : Control
{
    internal double VerticalPercent = 10;
    private readonly Provider provider;

    internal VerticalOnlyPanel()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
        BackColor = Color.White;
        provider = new Provider(this);
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

    private sealed class Provider : IRawElementProviderSimple, IScrollProvider
    {
        private readonly VerticalOnlyPanel owner;
        internal Provider(VerticalOnlyPanel owner) { this.owner = owner; }
        public ProviderOptions ProviderOptions { get { return ProviderOptions.ServerSideProvider | ProviderOptions.UseComThreading; } }
        public IRawElementProviderSimple HostRawElementProvider { get { return AutomationInteropProvider.HostProviderFromHandle(owner.Handle); } }
        public object GetPatternProvider(int id) { return id == ScrollPattern.Pattern.Id ? this : null; }
        public object GetPropertyValue(int id)
        {
            if (id == AutomationElementIdentifiers.NameProperty.Id) return "vertical only";
            if (id == AutomationElementIdentifiers.AutomationIdProperty.Id) return "verticalOnly";
            if (id == AutomationElementIdentifiers.ControlTypeProperty.Id) return ControlType.List.Id;
            if (id == AutomationElementIdentifiers.IsEnabledProperty.Id) return true;
            if (id == AutomationElementIdentifiers.IsOffscreenProperty.Id) return false;
            if (id == AutomationElementIdentifiers.IsKeyboardFocusableProperty.Id) return false;
            if (id == AutomationElementIdentifiers.ProcessIdProperty.Id) return Process.GetCurrentProcess().Id;
            return null;
        }
        public bool HorizontallyScrollable { get { return false; } }
        public double HorizontalScrollPercent { get { return ScrollPattern.NoScroll; } }
        public double HorizontalViewSize { get { return 100; } }
        public bool VerticallyScrollable { get { return true; } }
        public double VerticalScrollPercent { get { return owner.VerticalPercent; } }
        public double VerticalViewSize { get { return 50; } }
        public void Scroll(ScrollAmount h, ScrollAmount v) { }
        public void SetScrollPercent(double h, double v)
        {
            if (v != ScrollPattern.NoScroll) owner.VerticalPercent = v;
        }
    }
}

/// <summary>
/// A scroll panel with BOTH axes scrollable, so "set one axis and leave the other" is measurable:
/// it starts at a non-zero position (35, 20) and reports each axis independently.
/// </summary>
public sealed class ScrollPanel : Control
{
    // Deliberately non-zero at both axes: an implementation that reset the other axis to 0 would be
    // indistinguishable from a correct one if it started at 0.
    internal double VerticalPercent = 20;
    internal double HorizontalPercent = 35;
    internal readonly double StartVertical = 20;
    internal readonly double StartHorizontal = 35;
    internal int TopRow;
    internal int SetPercentCalls;
    internal int ScrollCalls;
    private readonly Provider provider;

    internal ScrollPanel()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
        BackColor = Color.White;
        provider = new Provider(this);
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

    protected override void OnPaint(PaintEventArgs args)
    {
        args.Graphics.Clear(Color.White);
        for (int offset = 0; offset < 8; offset++)
        {
            Rectangle bounds = new Rectangle(2, 2 + offset * 26, ClientSize.Width - 4, 25);
            args.Graphics.DrawRectangle(Pens.Gainsboro, bounds);
            args.Graphics.DrawString("row " + (TopRow + offset), Font, Brushes.Black, bounds.Left + 4, bounds.Top + 4);
        }
    }

    private sealed class Provider : IRawElementProviderSimple, IScrollProvider
    {
        private readonly ScrollPanel owner;
        internal Provider(ScrollPanel owner) { this.owner = owner; }
        public ProviderOptions ProviderOptions { get { return ProviderOptions.ServerSideProvider | ProviderOptions.UseComThreading; } }
        public IRawElementProviderSimple HostRawElementProvider { get { return AutomationInteropProvider.HostProviderFromHandle(owner.Handle); } }
        public object GetPatternProvider(int patternId) { return patternId == ScrollPattern.Pattern.Id ? this : null; }
        public object GetPropertyValue(int propertyId)
        {
            if (propertyId == AutomationElementIdentifiers.NameProperty.Id) return "scroll fixture";
            if (propertyId == AutomationElementIdentifiers.AutomationIdProperty.Id) return "scrollFixture";
            if (propertyId == AutomationElementIdentifiers.ControlTypeProperty.Id) return ControlType.List.Id;
            if (propertyId == AutomationElementIdentifiers.IsEnabledProperty.Id) return true;
            if (propertyId == AutomationElementIdentifiers.IsOffscreenProperty.Id) return false;
            if (propertyId == AutomationElementIdentifiers.IsKeyboardFocusableProperty.Id) return true;
            if (propertyId == AutomationElementIdentifiers.ProcessIdProperty.Id) return Process.GetCurrentProcess().Id;
            return null;
        }
        // BOTH axes are scrollable on this control, each reported independently.
        public bool HorizontallyScrollable { get { return true; } }
        public double HorizontalScrollPercent { get { return owner.HorizontalPercent; } }
        public double HorizontalViewSize { get { return 50; } }
        public bool VerticallyScrollable { get { return true; } }
        public double VerticalScrollPercent { get { return owner.VerticalPercent; } }
        public double VerticalViewSize { get { return 50; } }
        public void Scroll(ScrollAmount horizontalAmount, ScrollAmount verticalAmount)
        {
            owner.ScrollCalls++;
            int verticalStep = verticalAmount == ScrollAmount.LargeIncrement ? 10 : verticalAmount == ScrollAmount.SmallIncrement ? 1
                : verticalAmount == ScrollAmount.LargeDecrement ? -10 : verticalAmount == ScrollAmount.SmallDecrement ? -1 : 0;
            int horizontalStep = horizontalAmount == ScrollAmount.LargeIncrement ? 10 : horizontalAmount == ScrollAmount.SmallIncrement ? 1
                : horizontalAmount == ScrollAmount.LargeDecrement ? -10 : horizontalAmount == ScrollAmount.SmallDecrement ? -1 : 0;
            owner.TopRow = Math.Max(0, owner.TopRow + verticalStep);
            owner.VerticalPercent = Math.Max(0, Math.Min(100, owner.VerticalPercent + verticalStep));
            owner.HorizontalPercent = Math.Max(0, Math.Min(100, owner.HorizontalPercent + horizontalStep));
            owner.Invalidate();
        }
        public void SetScrollPercent(double horizontalPercent, double verticalPercent)
        {
            owner.SetPercentCalls++;
            if (verticalPercent != ScrollPattern.NoScroll) owner.VerticalPercent = verticalPercent;
            if (horizontalPercent != ScrollPattern.NoScroll) owner.HorizontalPercent = horizontalPercent;
            owner.Invalidate();
        }
    }
}

/// <summary>MultipleView (1 -> 2) plus a virtualised row set with VirtualizedItem.Realize.</summary>
public sealed class ViewPanel : Control
{
    internal int CurrentViewId = 1;
    internal int ViewSwitches;
    internal int RealizeCalls;
    internal readonly HashSet<int> Realized = new HashSet<int>();
    private readonly Provider provider;

    internal ViewPanel()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
        BackColor = Color.White;
        provider = new Provider(this);
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

    private sealed class Provider : IRawElementProviderSimple, IRawElementProviderFragmentRoot, IRawElementProviderFragment,
        IMultipleViewProvider, IScrollProvider
    {
        private readonly ViewPanel owner;
        internal Provider(ViewPanel owner) { this.owner = owner; }

        public ProviderOptions ProviderOptions { get { return ProviderOptions.ServerSideProvider | ProviderOptions.UseComThreading; } }
        public IRawElementProviderSimple HostRawElementProvider { get { return AutomationInteropProvider.HostProviderFromHandle(owner.Handle); } }
        public object GetPatternProvider(int patternId)
        {
            if (patternId == MultipleViewPattern.Pattern.Id) return this;
            if (patternId == ScrollPattern.Pattern.Id) return this;
            return null;
        }
        public object GetPropertyValue(int propertyId)
        {
            if (propertyId == AutomationElementIdentifiers.NameProperty.Id) return "view fixture";
            if (propertyId == AutomationElementIdentifiers.AutomationIdProperty.Id) return "viewFixture";
            if (propertyId == AutomationElementIdentifiers.ControlTypeProperty.Id) return ControlType.List.Id;
            if (propertyId == AutomationElementIdentifiers.IsEnabledProperty.Id) return true;
            if (propertyId == AutomationElementIdentifiers.IsOffscreenProperty.Id) return false;
            if (propertyId == AutomationElementIdentifiers.IsKeyboardFocusableProperty.Id) return true;
            if (propertyId == AutomationElementIdentifiers.ProcessIdProperty.Id) return Process.GetCurrentProcess().Id;
            if (propertyId == MultipleViewPatternIdentifiers.CurrentViewProperty.Id) return owner.CurrentViewId;
            if (propertyId == MultipleViewPatternIdentifiers.SupportedViewsProperty.Id) return new[] { 1, 2 };
            return null;
        }

        public int CurrentView { get { return owner.CurrentViewId; } }
        public int[] GetSupportedViews() { return new[] { 1, 2 }; }
        public string GetViewName(int viewId) { return viewId == 1 ? "One" : viewId == 2 ? "Two" : null; }
        public void SetCurrentView(int viewId)
        {
            if (viewId != 1 && viewId != 2) throw new ArgumentOutOfRangeException("viewId");
            owner.ViewSwitches++;
            owner.CurrentViewId = viewId;
        }

        public bool HorizontallyScrollable { get { return false; } }
        public double HorizontalScrollPercent { get { return ScrollPattern.NoScroll; } }
        public double HorizontalViewSize { get { return 100; } }
        public bool VerticallyScrollable { get { return true; } }
        public double VerticalScrollPercent { get { return 0; } }
        public double VerticalViewSize { get { return 100; } }
        public void Scroll(ScrollAmount horizontalAmount, ScrollAmount verticalAmount) { }
        public void SetScrollPercent(double horizontalPercent, double verticalPercent) { }

        // ---- fragment: 60 rows, only the first 8 are realised ----
        public IRawElementProviderFragment Navigate(NavigateDirection direction)
        {
            if (direction == NavigateDirection.Parent) return null;
            if (direction == NavigateDirection.FirstChild) return new RowProvider(owner, 0);
            if (direction == NavigateDirection.LastChild) return new RowProvider(owner, 59);
            return null;
        }
        public int[] GetRuntimeId() { return new[] { 5150, owner.Handle.ToInt32(), 1 }; }
        public System.Windows.Rect BoundingRectangle
        {
            get
            {
                RECT rect; GetWindowRect(owner.Handle, out rect);
                return new System.Windows.Rect(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
            }
        }
        public IRawElementProviderSimple[] GetEmbeddedFragmentRoots() { return null; }
        public void SetFocus() { }
        public IRawElementProviderFragmentRoot FragmentRoot { get { return this; } }
        public IRawElementProviderFragment ElementProviderFromPoint(double x, double y) { return new RowProvider(owner, 0); }
        public IRawElementProviderFragment GetFocus() { return null; }

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        private struct RECT { public int Left, Top, Right, Bottom; }
    }

    /// <summary>One virtualised row: Offscreen until Realize is called on it.</summary>
    private sealed class RowProvider : IRawElementProviderFragment, IRawElementProviderSimple, IVirtualizedItemProvider
    {
        private readonly ViewPanel owner;
        private readonly int row;
        internal RowProvider(ViewPanel owner, int row) { this.owner = owner; this.row = row; }

        public ProviderOptions ProviderOptions { get { return ProviderOptions.ServerSideProvider | ProviderOptions.UseComThreading; } }
        public IRawElementProviderSimple HostRawElementProvider { get { return null; } }
        public object GetPatternProvider(int patternId) { return patternId == VirtualizedItemPattern.Pattern.Id ? this : null; }
        public object GetPropertyValue(int propertyId)
        {
            if (propertyId == AutomationElementIdentifiers.NameProperty.Id) return "row " + row;
            if (propertyId == AutomationElementIdentifiers.AutomationIdProperty.Id) return "row-" + row;
            if (propertyId == AutomationElementIdentifiers.ControlTypeProperty.Id) return ControlType.ListItem.Id;
            if (propertyId == AutomationElementIdentifiers.IsEnabledProperty.Id) return true;
            if (propertyId == AutomationElementIdentifiers.IsOffscreenProperty.Id)
            {
                lock (owner.Realized) return !(row < 8 || owner.Realized.Contains(row));
            }
            if (propertyId == AutomationElementIdentifiers.ProcessIdProperty.Id) return Process.GetCurrentProcess().Id;
            return null;
        }
        public IRawElementProviderFragment Navigate(NavigateDirection direction)
        {
            if (direction == NavigateDirection.Parent) return new OwnerRoot(owner);
            if (direction == NavigateDirection.NextSibling && row + 1 < 60) return new RowProvider(owner, row + 1);
            if (direction == NavigateDirection.PreviousSibling && row > 0) return new RowProvider(owner, row - 1);
            return null;
        }
        public int[] GetRuntimeId() { return new[] { 5150, owner.Handle.ToInt32(), 100 + row }; }
        public System.Windows.Rect BoundingRectangle
        {
            get
            {
                RECT rect; GetWindowRect(owner.Handle, out rect);
                int height = Math.Max(1, owner.ClientSize.Height / 8);
                return new System.Windows.Rect(rect.Left + 2, rect.Top + 2 + (row % 8) * height,
                    Math.Max(1, owner.ClientSize.Width - 4), height - 1);
            }
        }
        public IRawElementProviderSimple[] GetEmbeddedFragmentRoots() { return null; }
        public void SetFocus() { }
        public IRawElementProviderFragmentRoot FragmentRoot { get { return new OwnerRoot(owner); } }
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        private struct RECT { public int Left, Top, Right, Bottom; }
        /// <summary>The row's window-level anchor, so the parent chain reaches a real HWND.</summary>
        private sealed class OwnerRoot : IRawElementProviderFragmentRoot, IRawElementProviderFragment, IRawElementProviderSimple
        {
            private readonly ViewPanel owner;
            internal OwnerRoot(ViewPanel owner) { this.owner = owner; }
            public ProviderOptions ProviderOptions { get { return ProviderOptions.ServerSideProvider | ProviderOptions.UseComThreading; } }
            public IRawElementProviderSimple HostRawElementProvider { get { return AutomationInteropProvider.HostProviderFromHandle(owner.Handle); } }
            public object GetPatternProvider(int patternId) { return null; }
            public object GetPropertyValue(int propertyId)
            {
                if (propertyId == AutomationElementIdentifiers.NameProperty.Id) return "view fixture";
                if (propertyId == AutomationElementIdentifiers.AutomationIdProperty.Id) return "viewFixture";
                if (propertyId == AutomationElementIdentifiers.ControlTypeProperty.Id) return ControlType.List.Id;
                if (propertyId == AutomationElementIdentifiers.IsEnabledProperty.Id) return true;
                if (propertyId == AutomationElementIdentifiers.IsOffscreenProperty.Id) return false;
                if (propertyId == AutomationElementIdentifiers.ProcessIdProperty.Id) return Process.GetCurrentProcess().Id;
                return null;
            }
            public IRawElementProviderFragment Navigate(NavigateDirection direction) { return null; }
            public int[] GetRuntimeId() { return new[] { 5150, owner.Handle.ToInt32(), 1 }; }
            public System.Windows.Rect BoundingRectangle
            {
                get
                {
                    RECT rect; GetWindowRect(owner.Handle, out rect);
                    return new System.Windows.Rect(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
                }
            }
            public IRawElementProviderSimple[] GetEmbeddedFragmentRoots() { return null; }
            public void SetFocus() { }
            public IRawElementProviderFragmentRoot FragmentRoot { get { return this; } }
            public IRawElementProviderFragment ElementProviderFromPoint(double x, double y) { return null; }
            public IRawElementProviderFragment GetFocus() { return null; }
            [System.Runtime.InteropServices.DllImport("user32.dll")]
            private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
            [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
            private struct RECT { public int Left, Top, Right, Bottom; }
        }
        /// <summary>The measured effect: the provider's own counter and realised set.</summary>
        public void Realize()
        {
            owner.RealizeCalls++;
            lock (owner.Realized) owner.Realized.Add(row);
        }
    }
}
