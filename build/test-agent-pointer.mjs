// Compile only the exact production painter: no worker lifecycle, windows, hooks,
// native visibility API or guardian process can run in this offscreen fixture.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const worker = fs.readFileSync(new URL('../lib/core/worker.cs', import.meta.url), 'utf8')
const start = worker.indexOf('public static class KitePointerPainter')
assert.ok(start > 0, 'production kite painter exists')
const open = worker.indexOf('{', start)
let depth = 1, end = open + 1
// This painter has no braces in literals/comments. Reject native or lifecycle
// dependencies instead of silently compiling worker Main into this fixture.
for (; end < worker.length && depth; end++) {
  if (worker[end] === '{') depth++
  if (worker[end] === '}') depth--
}
assert.equal(depth, 0, 'complete standalone painter class')
const production = worker.slice(start, end)
assert.doesNotMatch(production, /DllImport|PointerVisibilityLease|\bProcess\b|\bProgram\b|SetSystemCursor/)
assert.match(worker, /return KitePointerPainter\.RenderPreview\(dpiScale, holding, frame, semantic\);/,
  'live AgentPointer delegates to this exact painter')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pointer-painter-'))
const source = path.join(temp, 'PointerFixture.cs'), exe = path.join(temp, 'PointerFixture.exe')
const output = path.resolve(process.argv[2] || new URL('agent-pointer-preview', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))
fs.mkdirSync(output, { recursive: true })
fs.writeFileSync(source, `using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
${production}
class Fixture {
  static int checks;
  static void Check(bool value, string message) { checks++; if (!value) throw new Exception(message); }
  static int Different(Bitmap a, Bitmap b) { int n=0; for(int y=0;y<a.Height;y++) for(int x=0;x<a.Width;x++) if(a.GetPixel(x,y)!=b.GetPixel(x,y))n++; return n; }
  static void CheckPixels(Bitmap bitmap) {
    int count=0;
    for(int y=0;y<bitmap.Height;y++) for(int x=0;x<bitmap.Width;x++) {
      int alpha=bitmap.GetPixel(x,y).A; if(alpha>0)count++;
      if(x==0||y==0||x==bitmap.Width-1||y==bitmap.Height-1) Check(alpha==0,"painter clipped at canvas boundary");
    }
    Check(count>100&&count<bitmap.Width*bitmap.Height*0.7,"isolated visible footprint");
    BitmapData data=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppPArgb);
    try {
      byte[] row=new byte[bitmap.Width*4];
      for(int y=0;y<bitmap.Height;y++) {
        Marshal.Copy(IntPtr.Add(data.Scan0,y*data.Stride),row,0,row.Length);
        for(int x=0;x<row.Length;x+=4) Check(row[x]<=row[x+3]&&row[x+1]<=row[x+3]&&row[x+2]<=row[x+3],"invalid premultiplied alpha");
      }
    } finally { bitmap.UnlockBits(data); }
  }
  static void Main(string[] args) {
    Check(KitePointerPainter.LogicalWidth==39&&KitePointerPainter.LogicalHeight==44,"new logical canvas");
    Check(KitePointerPainter.BodyScale==0.75f&&KitePointerPainter.TiltDegrees==-25f,"requested body scale and tilt");
    Check(KitePointerPainter.AnimationFrame(false,int.MinValue)==16,"acting is static across tick wrap");
    for(int tick=0;tick<2500;tick+=50) Check(KitePointerPainter.AnimationFrame(true,tick)>=7&&KitePointerPainter.AnimationFrame(true,tick)<=15,"bounded hold pulse");
    Check(KitePointerPainter.AnimationFrame(true,int.MinValue)>=7,"hold tick wrap valid");
    foreach(float scale in new float[]{1,1.25f,1.75f,2,4}) {
      Point h=KitePointerPainter.Hotspot(scale); PointF tip=KitePointerPainter.Transform(27,7,scale),bottom=KitePointerPainter.Transform(27,43,scale);
      Check(h.X==(int)Math.Round(8*scale,MidpointRounding.AwayFromZero)&&h.Y==(int)Math.Round(4*scale,MidpointRounding.AwayFromZero),"fixed device hotspot");
      Check(tip.X==h.X&&tip.Y==h.Y,"rotation fixes tip exactly at hotspot");
      double dx=bottom.X-tip.X,dy=bottom.Y-tip.Y;
      Check(Math.Abs(Math.Sqrt(dx*dx+dy*dy)-27*scale)<0.001,"body length really reduced to 75 percent");
      Check(Math.Abs(Math.Atan2(dx,dy)*180/Math.PI-25)<0.001,"body really tilted 25 degrees");
      using(Bitmap active=KitePointerPainter.RenderPreview(scale,false,16))
      using(Bitmap hold=KitePointerPainter.RenderPreview(scale,true,15))
      using(Bitmap trough=KitePointerPainter.RenderPreview(scale,true,7))
      using(Bitmap staticOtherFrame=KitePointerPainter.RenderPreview(scale,false,7)) {
        Check(active.Width==(int)Math.Ceiling(39*scale)&&active.Height==(int)Math.Ceiling(44*scale),"DPI canvas size");
        CheckPixels(active); CheckPixels(hold); CheckPixels(trough);
        Check(Different(active,hold)>20,"acting and holding remain visually distinct");
        Check(Different(hold,trough)>20,"hold breath changes actual pixels");
        Check(Different(active,staticOtherFrame)==0,"acting ignores pulse frame");
        if(scale==1.75f) {
          active.Save(System.IO.Path.Combine(args[0],"acting.png"),ImageFormat.Png);
          hold.Save(System.IO.Path.Combine(args[0],"holding.png"),ImageFormat.Png);
          trough.Save(System.IO.Path.Combine(args[0],"holding-trough.png"),ImageFormat.Png);
        }
      }
    }
    foreach(float invalid in new float[]{float.NaN,float.PositiveInfinity,-2,0}) Check(KitePointerPainter.CanvasSize(invalid)==new Size(39,44),"invalid DPI safely falls back/clamps");
    Check(KitePointerPainter.CanvasSize(10)==new Size(156,176),"DPI maximum bounded");
    string[] semantics={"arrow","ibeam","resize-ew","resize-ns","resize-nwse","resize-nesw","move","hand","cross","wait","app-starting","not-allowed","help","unknown"};
    Bitmap[] images=new Bitmap[semantics.Length];
    try {
      for(int i=0;i<semantics.Length;i++) {
        images[i]=KitePointerPainter.RenderPreview(1.75f,false,16,semantics[i]);
        CheckPixels(images[i]);
        for(int j=0;j<i;j++) Check(Different(images[i],images[j])>5,"distinct semantic marks: "+semantics[i]+" vs "+semantics[j]);
      }
      using(Bitmap unknown=KitePointerPainter.RenderPreview(1.75f,false,16,"unrecognized-custom-cursor")) Check(Different(unknown,images[13])==0,"unknown does not guess a recognized shape");
      using(Bitmap text=KitePointerPainter.RenderPreview(1.75f,false,16,"text")) Check(Different(text,images[1])==0,"native ibeam shares text mark");
      using(Bitmap board=new Bitmap(1100,440)) using(Graphics g=Graphics.FromImage(board))
      using(Font title=new Font("Segoe UI",20,FontStyle.Bold)) using(Font label=new Font("Segoe UI",11))
      using(SolidBrush white=new SolidBrush(Color.FromArgb(232,241,255))) {
        g.Clear(Color.FromArgb(12,19,36));
        g.DrawString("Kite pointer / 75% body / 25 degree tilt",title,white,24,20);
        g.DrawString("175% DPI. Fixed tip hotspot. Preview only: no native visibility API runs.",label,white,24,64);
        for(int i=0;i<images.Length;i++) {
          int x=30+(i%7)*155,y=110+(i/7)*155;
          g.DrawImageUnscaled(images[i],x,y);g.DrawString(semantics[i],label,white,x,y+86);
        }
        board.Save(System.IO.Path.Combine(args[0],"preview.png"),ImageFormat.Png);
      }
    } finally { foreach(Bitmap image in images) if(image!=null)image.Dispose(); }
    Console.WriteLine("ok pointer painter: "+checks+" assertions; isolated production painter, five DPIs, fixed hotspot, 75%/25deg transform, semantic pixels and premultiplied alpha; preview="+args[0]);
  }
}`)
try {
  const compiler = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  execFileSync(compiler, ['/nologo', '/target:exe', '/r:System.Drawing.dll', `/out:${exe}`, source], { windowsHide: true, timeout: 20000 })
  process.stdout.write(execFileSync(exe, [output], { windowsHide: true, timeout: 20000 }))
} finally {
  for (const file of [source, exe]) if (fs.existsSync(file)) fs.unlinkSync(file)
  fs.rmdirSync(temp)
}
