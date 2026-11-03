"""Render original storefront feature illustrations. Requires Pillow; no app screenshots."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from pathlib import Path
import math

OUT = Path(__file__).resolve().parents[1] / 'docs' / 'images'
OUT.mkdir(parents=True, exist_ok=True)
W,H=1440,900
WHITE='#F2F4F8'; MUTED='#98A5BA'; MINT='#9AF2D1'; LAV='#B7ACFF'; BLUE='#6E9EFF'
def font(size,bold=False):
    return ImageFont.truetype('C:/Windows/Fonts/msyhbd.ttc' if bold else 'C:/Windows/Fonts/msyh.ttc',size)
def text(d,xy,s,size=28,color=WHITE,bold=False): d.text(xy,s,font=font(size,bold),fill=color)
def panel(d,box,fill='#141D2E',outline='#2C3952',radius=24): d.rounded_rectangle(box,radius,fill=fill,outline=outline,width=2)
def base(num,kicker,title,subtitle):
    im=Image.new('RGB',(W,H),'#090E19'); glow=Image.new('RGB',(W,H),'#090E19'); g=ImageDraw.Draw(glow)
    g.ellipse((760,-500,1790,480),fill='#233E59');g.ellipse((-300,500,400,1100),fill='#182D35');g.ellipse((700,620,1450,1200),fill='#25203F')
    im=Image.blend(im,glow.filter(ImageFilter.GaussianBlur(120)),.65); d=ImageDraw.Draw(im)
    d.line((64,68,100,68),fill=MINT,width=4)
    text(d,(118,48),'COMPUTER USE  /  CODEX STYLE',22,MINT,True)
    text(d,(64,122),title,70,WHITE,True);text(d,(68,225),subtitle,27,MUTED)
    text(d,(66,824),'DeepSeek Harness  ×  Windows',22,MUTED)
    text(d,(1040,826),f'{kicker}  /  {num:02d}',20,MUTED)
    return im,d
def cursor(d,x,y,color=MINT):
    d.polygon([(x,y),(x+9,y+55),(x+25,y+37),(x+47,y+35)],fill=color)
def save(im,name): im.save(OUT/name,optimize=True)

im,d=base(1,'功能示意','像 Codex 一样，操控电脑。','把观察、操作、验证，连成一段自然的桌面协作。')
panel(d,(68,320,1372,770),fill='#101827')
text(d,(102,346),'桌面工作台',22,MUTED); d.ellipse((1310,355,1322,367),fill=MINT)
panel(d,(102,404,620,727),fill='#0D1422')
text(d,(132,432),'你描述目标',24,MINT,True)
text(d,(132,487),'“把这组资料整理到应用里。”',27)
d.line((132,550,588,550),fill='#2B364D',width=1)
text(d,(132,580),'AI 看屏幕 · 找控件 · 执行动作',24)
text(d,(132,634),'完成后释放桌面，聊天继续。',23,MUTED)
panel(d,(656,404,1338,727),fill='#151F31',outline='#577AB7')
text(d,(690,429),'观察',24,BLUE,True); text(d,(914,429),'操作',24,LAV,True);text(d,(1152,429),'验证',24,MINT,True)
for x,c in [(690,BLUE),(914,LAV),(1152,MINT)]:
    panel(d,(x,493,x+150,613),fill='#1C2940',outline='#34445F',radius=13)
    for yy,ww in [(516,96),(540,72),(564,86)]:d.rounded_rectangle((x+18,yy,x+ww,yy+7),3,fill=c)
for x in [860,1084]:text(d,(x,527),'→',27,MUTED)
cursor(d,1002,570)
text(d,(690,663),'截图 + UI Automation  /  鼠标 + 键盘',23,MUTED)
save(im,'01-codex-style.png')

im,d=base(2,'功能示意','你接手。AI 等待，再接着做。','控制权随操作流转，任务不会因为一次人工接管而丢失。')
cards=[(68,'01','先提醒','1.5 秒操作预告','让你从容停下手头输入',LAV),(512,'02','可接管','实际操控时亮起深蓝光','接管后暂时中断，等待交回',BLUE),(956,'03','再继续','交回后重新观察现场','沿着原任务继续完成',MINT)]
for x,n,title,a,b,c in cards:
    panel(d,(x,342,x+416,705),fill='#141D2D')
    text(d,(x+30,371),n,22,c,True)
    d.line((x+30,426,x+386,426),fill=c,width=3)
    text(d,(x+30,458),title,45,WHITE,True)
    text(d,(x+30,548),a,25,c)
    text(d,(x+30,603),b,23,MUTED)
text(d,(73,746),'非实际操控期间，可正常使用电脑。明确暂停、取消和退出仍然有效。',24,MUTED)
save(im,'02-handoff.png')

im,d=base(3,'功能示意','更少往返，更省 Token。','把已知连续步骤合并执行，让每次观察都更有用。')
panel(d,(68,338,500,714),fill='#111C2C')
text(d,(100,371),'看得更聚焦',32,MINT,True)
text(d,(100,433),'控件定位 · 增量观察',25,WHITE)
text(d,(100,482),'区域截图 · 按需降采样',25,WHITE)
panel(d,(100,555,468,674),fill='#0B1320',outline='#2E4055',radius=12)
text(d,(122,577),'UI Automation',20,MUTED)
text(d,(122,615),'目标：备注输入框  #12',23,MINT)
text(d,(536,491),'→',36,MUTED)
panel(d,(604,338,1372,714),fill='#142337',outline='#3E5A76')
text(d,(640,371),'已知流程，一次批量调用',32,WHITE,True)
for x,label,c in [(640,'点击目标',BLUE),(879,'输入内容',LAV),(1118,'回读验证',MINT)]:
    panel(d,(x,459,x+216,571),fill='#0E1929',outline='#344A65',radius=14)
    text(d,(x+26,494),label,28,c,True)
text(d,(640,620),'computer_batch  ·  串行执行，遇错即停',24,MUTED)
text(d,(73,750),'流程示意；实际 Token 用量取决于任务、模型与观察方式。',23,MUTED)
save(im,'03-token-efficiency.png')
sheet=Image.new('RGB',(960,600*3),'#090E19')
for i,n in enumerate(['01-codex-style.png','02-handoff.png','03-token-efficiency.png']):sheet.paste(Image.open(OUT/n).resize((960,600),Image.Resampling.LANCZOS),(0,600*i))
preview=OUT.parents[1]/'build'/'promo-20261103'
preview.mkdir(parents=True,exist_ok=True)
sheet.save(preview/'contact-sheet.jpg',quality=92)
print(OUT)
