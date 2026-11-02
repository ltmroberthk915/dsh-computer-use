// Exercises production painting against memory only: never starts an overlay,
// creates a native window, installs a hook, or dispatches desktop input.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using DshComputerUse.Worker;

class GlowVisualFixture
{
    const BindingFlags PrivateStatic = BindingFlags.Static | BindingFlags.NonPublic;
    static readonly Type GlowType = typeof(Program).Assembly.GetType("DshComputerUse.Worker.Glow");
    static readonly List<object> Results = new List<object>();

    static int Main(string[] args)
    {
        string output = args[0];
        Directory.CreateDirectory(output);
        foreach (int width in new int[] { 1280, 2560 })
        {
            int height = width * 9 / 16;
            Render(output, "thinking", width, height, "PaintBlue", new object[] { false }, Rectangle.Empty);
            Render(output, "acting", width, height, "PaintBlue", new object[] { true }, Rectangle.Empty);
            Render(output, "handoff", width, height, "PaintHumanYield", new object[0], Rectangle.Empty);
            Render(output, "preparing", width, height, "PaintPreparation", new object[] { 650 }, Rectangle.Empty);
            Render(output, "paused", width, height, "PaintStop", new object[0], Rectangle.Empty);
            Render(output, "capture", width, height, "PaintFlash", new object[0], Rectangle.Empty);
        }
        Render(output, "capture-crop", 1280, 720, "PaintFlash", new object[0], new Rectangle(120, 90, 860, 480));
        Render(output, "capture-tiny", 1280, 720, "PaintFlash", new object[0], new Rectangle(84, 72, 8, 8));
        Render(output, "capture-clipped", 1280, 720, "PaintFlash", new object[0], new Rectangle(-12, -16, 220, 180));
        SaveContactSheet(output, false);
        SaveContactSheet(output, true);
        string json = new JavaScriptSerializer().Serialize(Results);
        File.WriteAllText(Path.Combine(output, "metrics.json"), json);
        Console.WriteLine(json);
        return 0;
    }

    static void Render(string output, string name, int w, int h, string method, object[] extras, Rectangle capture)
    {
        if (method == "PaintFlash")
        {
            string[] names = { "_fx", "_fy", "_fw", "_fh" };
            int[] values = { capture.X, capture.Y, capture.Width, capture.Height };
            for (int i = 0; i < names.Length; i++) GlowType.GetField(names[i], PrivateStatic).SetValue(null, values[i]);
        }
        IntPtr bits = Marshal.AllocHGlobal(w * h * 4);
        try
        {
            object[] invoke = new object[3 + extras.Length];
            invoke[0] = bits; invoke[1] = w; invoke[2] = h;
            Array.Copy(extras, 0, invoke, 3, extras.Length);
            GlowType.GetMethod(method, PrivateStatic).Invoke(null, invoke);
            byte[] data = new byte[w * h * 4];
            Marshal.Copy(bits, data, 0, data.Length);
            Rectangle region = capture.IsEmpty ? new Rectangle(0, 0, w, h) : Rectangle.Intersect(capture, new Rectangle(0, 0, w, h));
            int edgeHoles = 0, outsidePixels = 0, invalidPremultiplied = 0;
            int contentMinX = w, contentMinY = h, contentMaxX = -1, contentMaxY = -1, contentPixels = 0;
            int minCornerAlpha = 255, maxInteriorAlpha = 0;
            foreach (Point p in new Point[] { new Point(region.Left, region.Top), new Point(region.Right - 1, region.Top),
                new Point(region.Left, region.Bottom - 1), new Point(region.Right - 1, region.Bottom - 1) })
                minCornerAlpha = Math.Min(minCornerAlpha, data[(p.Y * w + p.X) * 4 + 3]);
            for (int y = 0; y < h; y++) for (int x = 0; x < w; x++)
            {
                int at = (y * w + x) * 4, a = data[at + 3];
                if (data[at] > a || data[at + 1] > a || data[at + 2] > a) invalidPremultiplied++;
                bool inside = region.Contains(x, y);
                if (!inside) { if (a != 0) outsidePixels++; continue; }
                int edgeDistance = Math.Min(Math.Min(x - region.Left, region.Right - 1 - x), Math.Min(y - region.Top, region.Bottom - 1 - y));
                if (edgeDistance == 0 && a == 0) edgeHoles++;
                if (edgeDistance >= 8 && a != 0)
                {
                    contentPixels++;
                    contentMinX = Math.Min(contentMinX, x); contentMinY = Math.Min(contentMinY, y);
                    contentMaxX = Math.Max(contentMaxX, x); contentMaxY = Math.Max(contentMaxY, y);
                    maxInteriorAlpha = Math.Max(maxInteriorAlpha, a);
                }
            }
            string stem = name + "-" + w + "x" + h;
            using (var bitmap = new Bitmap(w, h, w * 4, PixelFormat.Format32bppPArgb, bits))
            {
                bitmap.Save(Path.Combine(output, stem + ".png"), ImageFormat.Png);
                using (var preview = new Bitmap(w, h, PixelFormat.Format32bppPArgb))
                using (var g = Graphics.FromImage(preview))
                {
                    DrawPreviewBackground(g, w, h, false);
                    g.DrawImageUnscaled(bitmap, 0, 0);
                    preview.Save(Path.Combine(output, stem + "-preview.png"), ImageFormat.Png);
                    DrawPreviewBackground(g, w, h, true);
                    g.DrawImageUnscaled(bitmap, 0, 0);
                    preview.Save(Path.Combine(output, stem + "-dark-preview.png"), ImageFormat.Png);
                }
            }
            Results.Add(new { name, width = w, height = h, edgeHoles, minCornerAlpha, outsidePixels,
                invalidPremultiplied, contentPixels, maxInteriorAlpha,
                contentBounds = contentPixels == 0 ? null : new { x = contentMinX, y = contentMinY,
                    width = contentMaxX - contentMinX + 1, height = contentMaxY - contentMinY + 1 } });
        }
        finally { Marshal.FreeHGlobal(bits); }
    }

    static void DrawPreviewBackground(Graphics g, int w, int h, bool dark)
    {
        // A synthetic document surface makes occlusion visible without capturing
        // any real desktop or user content.
        g.Clear(dark ? Color.FromArgb(20, 26, 35) : Color.FromArgb(243, 245, 248));
        using (var header = new SolidBrush(dark ? Color.FromArgb(34, 43, 57) : Color.FromArgb(225, 231, 239))) g.FillRectangle(header, 0, 0, w, 54);
        using (var sidebar = new SolidBrush(dark ? Color.FromArgb(25, 33, 45) : Color.FromArgb(233, 237, 243))) g.FillRectangle(sidebar, 0, 54, w / 7, h - 54);
        using (var surface = new SolidBrush(dark ? Color.FromArgb(29, 38, 51) : Color.White)) g.FillRectangle(surface, w / 7 + 40, 86, w * 5 / 7, h - 130);
        using (var pen = new Pen(dark ? Color.FromArgb(56, 68, 86) : Color.FromArgb(216, 222, 231), 1))
        {
            for (int y = 138; y < h - 70; y += 32) g.DrawLine(pen, w / 7 + 70, y, w - 100, y);
            for (int x = w / 7 + 70; x < w - 100; x += (w - w / 7 - 170) / 4) g.DrawLine(pen, x, 138, x, h - 70);
        }
        using (var text = new SolidBrush(dark ? Color.FromArgb(210, 220, 233) : Color.FromArgb(65, 79, 97)))
        using (var font = new Font("Segoe UI", 14))
        using (var small = new Font("Segoe UI", 10))
        {
            g.DrawString("Workspace   /   Project notes", small, text, 18, 16);
            g.DrawString("Overview", small, text, 20, 84);
            g.DrawString("Documents", small, text, 20, 118);
            g.DrawString("Reports", small, text, 20, 152);
            g.DrawString("Project overview · sample content", font, text, w / 7 + 70, 99);
            string[] columns = { "Work item", "Owner", "Status", "Updated" };
            int colWidth = (w - w / 7 - 170) / 4;
            for (int c = 0; c < columns.Length; c++) g.DrawString(columns[c], small, text, w / 7 + 78 + c * colWidth, 145);
            for (int row = 0; row < Math.Min(10, (h - 240) / 32); row++)
            {
                float y = 177 + row * 32;
                g.DrawString("Document " + (row + 1), small, text, w / 7 + 78, y);
                g.DrawString("Team", small, text, w / 7 + 78 + colWidth, y);
                g.DrawString(row % 2 == 0 ? "Ready" : "In progress", small, text, w / 7 + 78 + colWidth * 2, y);
                g.DrawString("Today", small, text, w / 7 + 78 + colWidth * 3, y);
            }
        }
    }

    static void SaveContactSheet(string output, bool dark)
    {
        string[] states = { "thinking", "acting", "handoff", "preparing", "paused", "capture" };
        const int cellWidth = 640, cellHeight = 390;
        using (var sheet = new Bitmap(cellWidth * 2, cellHeight * 3))
        using (var g = Graphics.FromImage(sheet))
        using (var font = new Font("Segoe UI", 12))
        using (var brush = new SolidBrush(Color.FromArgb(36, 46, 61)))
        {
            g.Clear(Color.FromArgb(248, 250, 252));
            for (int i = 0; i < states.Length; i++)
            {
                int x = i % 2 * cellWidth, y = i / 2 * cellHeight;
                g.DrawString(states[i], font, brush, x + 12, y + 5);
                using (var picture = Image.FromFile(Path.Combine(output, states[i] + "-1280x720" + (dark ? "-dark-preview.png" : "-preview.png"))))
                    g.DrawImage(picture, new Rectangle(x, y + 30, cellWidth, 360));
            }
            sheet.Save(Path.Combine(output, dark ? "contact-sheet-dark.png" : "contact-sheet.png"), ImageFormat.Png);
        }
    }
}
