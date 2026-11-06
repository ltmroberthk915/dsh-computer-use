// Pure geometry and state naming. No UI windows, hooks, input or worker Main.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Reflection;
using System.Web.Script.Serialization;

public static class UiGeometryFixture {
    static readonly Type Worker = typeof(DshComputerUse.Worker.Program);
    static int checks;
    static void Check(bool value, string name) { checks++; if (!value) throw new Exception(name); }
    static Dictionary<string, object> Geometry(System.Windows.Rect? rect, bool? offscreen) {
        var d = new Dictionary<string, object>();
        Worker.GetMethod("AddUiGeometry", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null,
            new object[] { d, rect, offscreen, new Rectangle(-1920, 0, 4480, 1600) });
        return d;
    }
    static void Invalid(System.Windows.Rect? rect, string name) {
        var d = Geometry(rect, null);
        Check(!(bool)d["rectValid"] && d["rect"] == null && d["intersectsVirtualScreen"] == null, name);
        Check(d["isOffscreen"] == null, name + " unknown visibility is not false");
        new JavaScriptSerializer().Serialize(d);
    }
    public static void Main() {
        Invalid(null, "unavailable");
        Invalid(System.Windows.Rect.Empty, "empty/infinite UIA bounds");
        Invalid(new System.Windows.Rect(10, 10, 0, 20), "zero width");
        Invalid(new System.Windows.Rect(Double.NaN, 10, 10, 20), "NaN");
        Invalid(new System.Windows.Rect(Double.PositiveInfinity, 10, 10, 20), "infinite origin");
        Invalid(new System.Windows.Rect(10, 10, Double.PositiveInfinity, 20), "infinite width");
        Invalid(new System.Windows.Rect(Int32.MinValue, 10, 10, 20), "INT32_MIN sentinel");
        Invalid(new System.Windows.Rect(Int32.MaxValue - 5, 10, 10, 20), "right outside int range");
        Invalid(new System.Windows.Rect(-0.5, 10, Int32.MaxValue - 0.2, 20), "rounded width cannot overflow int");
        Invalid(new System.Windows.Rect(Int32.MinValue + 0.5, 10, 10, 20), "rounded origin cannot become sentinel");
        var negative = Geometry(new System.Windows.Rect(-100, 40, 80, 60), false);
        Check((bool)negative["rectValid"] && (bool)negative["intersectsVirtualScreen"], "negative monitor origin is valid");
        var hidden = Geometry(new System.Windows.Rect(100, 40, 80, 60), true);
        Check((bool)hidden["isOffscreen"] && (bool)hidden["rectValid"], "provider offscreen and geometry validity are independent");
        Check(!hidden.ContainsKey("visible"), "geometry never promises visibility");
        var outside = Geometry(new System.Windows.Rect(2855, 299, 20, 20), false);
        Check((bool)outside["rectValid"] && !(bool)outside["intersectsVirtualScreen"], "out of display coordinates are labeled");
        var fractional = Geometry(new System.Windows.Rect(10.5, 20.2, 0.2, 0.3), false);
        var box = (Dictionary<string, object>)fractional["rect"];
        Check((int)box["width"] == 1 && (int)box["height"] == 1, "fractional bounds enclose rather than truncate to empty");
        var stateName = Worker.GetMethod("IndicatorStateName", BindingFlags.NonPublic | BindingFlags.Static);
        Check((string)stateName.Invoke(null, new object[] { 2 }) == "capture", "screenshot yellow label");
        Check((string)stateName.Invoke(null, new object[] { 6 }) == "human-handoff", "human yellow label");
        Check((string)stateName.Invoke(null, new object[] { 8 }) == "reserved", "reserved blue label");
        Check((string)stateName.Invoke(null, new object[] { 99 }) == "unknown", "new states not mislabeled");
        Console.WriteLine(new JavaScriptSerializer().Serialize(new { ok = true, checks = checks }));
    }
}
