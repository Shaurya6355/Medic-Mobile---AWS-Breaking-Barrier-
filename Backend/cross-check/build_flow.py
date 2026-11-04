"""Build flow.html: a yes/no flowchart of the extracted cough and fast breathing pathway.
Reads extraction_output.json (to check every cited block exists), writes flow.html. No network, no model calls.
The Yes/No layout is an arrangement of the extracted nodes and edges, not new extraction.
"""
import json
from pathlib import Path
here = Path(__file__).parent
data = json.loads((here / "extraction_output.json").read_text())
blocks = {b["block_id"] for p in json.loads((here / "input_blocks.json").read_text())["pages"] for b in p["blocks"]}

# kind: start | q (question) | out (outcome) | act (action) | info
# x,y,w,h in px.  src = block ids shown on hover.
B = {
 "assess": dict(k="start", x=40,  y=20,  w=340, h=84,  t="ASK and LOOK<br><small>cough and days, breaths per minute, chest indrawing, sleepy, convulsions, drink/feed, vomiting</small>", src=["p5.b4","p5.b5","p5.b7"], pg=5),
 "d1": dict(k="q", x=40,  y=140, w=340, h=64,  t="Cough for 14 days or more?", src=["p6.b4"], pg=6),
 "d2": dict(k="q", x=40,  y=244, w=340, h=64,  t="Chest indrawing?", src=["p6.b5"], pg=6),
 "d3": dict(k="q", x=40,  y=348, w=340, h=96,  t="Convulsions? Unusually sleepy or unconscious? Not able to drink or feed anything? Vomits everything?", src=["p6.b9","p6.b10","p6.b12","p6.b13"], pg=6),
 "d4": dict(k="q", x=40,  y=484, w=340, h=108, t="Any other danger sign? Diarrhoea 14 days or more, blood in stool, fever 7 days or more, HIV and any other illness, MUAC red (or yellow with HIV), swelling of both feet", src=["p6.b6","p6.b7","p6.b8","p6.b14","p6.b18","p6.b19","p6.b20"], pg=6, dim=True),
 "sick": dict(k="info", x=40, y=640, w=340, h=64, t="SICK but NO danger sign<br><small>cough less than 14 days</small>", src=["p8.b2","p8.b3"], pg=8),
 "d5": dict(k="q", x=40,  y=744, w=340, h=110, t="Fast breathing?<br><small>2 months up to 12 months: 50 breaths/min or more<br>12 months up to 5 years: 40 breaths/min or more</small>", src=["p8.b11","p8.b12","p8.b13"], pg=8),
 "all": dict(k="act", x=40, y=910, w=340, h=150, t="For ALL children treated at home<br><small>Advise more fluids and continue feeding.<br>Advise on when to return.<br>Follow up child in 3 days.</small>", src=["p9.b17","p9.b32","p9.b33"], pg=9),
 "d6": dict(k="q", x=40,  y=1110, w=340, h=64, t="Child becomes sicker or does not improve?", src=["p9.b34"], pg=9),
 "refer": dict(k="out", x=560, y=240, w=340, h=96, t="REFER URGENTLY TO HEALTH FACILITY<br><small>Begin treatment and assist referral</small>", src=["p6.b16","p6.b17"], pg=6),
 "steps": dict(k="act", x=560, y=376, w=340, h=250, t="Assist referral (p7)<br><small>Explain why the child needs to go.<br>If fast breathing or chest indrawing: first dose oral amoxicillin 250 mg, 2 months up to 12 months 1 tablet, 12 months up to 5 years 2 tablets.<br>Advise fluids and continue feeding. Keep child warm if not hot with fever.<br>Write a referral note. Arrange transportation.<br>Follow up on return at least once a week until well.</small>", src=["p7.b4","p7.b9","p7.b11","p7.b12","p7.b13","p7.b14","p7.b15"], pg=7),
 "amox": dict(k="act", x=560, y=730, w=340, h=150, t="Treat at home: amoxicillin 250 mg<br><small>Twice daily for 5 days.<br>2 months up to 12 months: 1 tablet.<br>12 months up to 5 years: 2 tablets.<br>Help caregiver give first dose now (p11).</small>", src=["p9.b18","p9.b19","p9.b20","p11.b18"], pg=9),
}
missing = [(k, s) for k, v in B.items() for s in v["src"] if s not in blocks]
assert not missing, missing

def mid_r(k): b=B[k]; return (b["x"]+b["w"], b["y"]+b["h"]//2)
def mid_l(k): b=B[k]; return (b["x"], b["y"]+b["h"]//2)
def bot(k): b=B[k]; return (b["x"]+b["w"]//2, b["y"]+b["h"])
def top(k): b=B[k]; return (b["x"]+b["w"]//2, b["y"])
lines = []   # (points, cls, label, label_xy)
spine = ["assess","d1","d2","d3","d4","sick","d5","all","d6"]
for a, b in zip(spine, spine[1:]):
    (x1,y1),(x2,y2)=bot(a),top(b)
    lab = None
    if a.startswith("d") and a != "d5": lab = "No"
    if a == "d4": lab = "No danger sign (p8)"
    if a == "d5": lab = "No"
    lines.append(([(x1,y1),(x2,y2)], "no" if lab else "n", lab, (x1+8,(y1+y2)//2+4)))
# YES from d1..d4 to REFER through a bus at x=480
bus = 470
for k in ["d1","d2","d3","d4"]:
    x,y = mid_r(k)
    lines.append(([(x,y),(bus,y)], "yes", "Yes", (x+8,y-8)))
lines.append(([(bus,mid_r("d1")[1]),(bus,mid_r("d4")[1])], "yes", None, None))
rx,ry = mid_l("refer")
lines.append(([(bus,ry),(rx,ry)], "yes", None, None))
# fixed attach of bus to refer: bus spans d1..d4 y; refer mid y is inside that range? make bus reach it
ys=[mid_r(k)[1] for k in ["d1","d2","d3","d4"]]+[ry]
lines.append(([(bus,min(ys)),(bus,max(ys))], "yes", None, None))
lines.append(([top("steps"),bot("refer")], "n", None, None))
lines[-1]=([bot("refer"),top("steps")], "n", None, None)
# d5 yes -> amox
x,y = mid_r("d5"); ax,ay = mid_l("amox")
lines.append(([(x,y),(ax-40,y),(ax-40,ay),(ax,ay)], "yes", "Yes", (x+8,y-8)))
# amox -> all (join)
x1,y1 = bot("amox"); ax2,ay2 = mid_r("all")
lines.append(([(x1,y1),(x1,ay2),(ax2,ay2)], "n", None, None))
# d6 yes -> refer (right side loop)
x,y = mid_r("d6"); loop = 960
rxr,ryr = mid_r("refer")
lines.append(([(x,y),(loop,y),(loop,ryr),(rxr,ryr)], "yes", "Yes", (x+8,y-8)))

def box(k,v):
    c = {"start":"start","q":"q","out":"out","act":"act","info":"info"}[v["k"]]
    return (f'<div class="b {c}{" dim" if v.get("dim") else ""}" style="left:{v["x"]}px;top:{v["y"]}px;width:{v["w"]}px;height:{v["h"]}px" '
            f'title="source blocks: {", ".join(v["src"])}"><div class="t">{v["t"]}</div><div class="p">p{v["pg"]}</div></div>')
svg = ""
for pts,cls,lab,lxy in lines:
    d = " ".join(("M" if i==0 else "L")+f"{x},{y}" for i,(x,y) in enumerate(pts))
    svg += f'<path d="{d}" class="ln {cls}" marker-end="url(#a{cls})"/>'
    if lab: svg += f'<text x="{lxy[0]}" y="{lxy[1]}" class="lb {cls}">{lab}</text>'
html = f"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>Cough and fast breathing flow</title><style>
body{{font-family:system-ui,sans-serif;margin:20px;background:#fafafa;color:#1b1f23}}
h1{{font-size:20px;margin:0 0 4px}}.sub{{font-size:13px;color:#555;margin-bottom:12px;max-width:900px}}
#c{{position:relative;width:1020px;height:1210px}}svg{{position:absolute;left:0;top:0}}
.b{{position:absolute;box-sizing:border-box;border-radius:8px;padding:8px 12px;font-size:13px;display:flex;flex-direction:column;justify-content:center;border:1.5px solid}}
.b small{{font-size:11.5px;color:#444}}.p{{position:absolute;right:8px;bottom:4px;font-size:10px;color:#777}}
.start{{background:#eef;border-color:#668}}.q{{background:#fff4cc;border-color:#bf8700;font-weight:600}}
.out{{background:#ffe3e3;border-color:#cf222e;font-weight:700}}.act{{background:#e8f5e9;border-color:#2e7d32}}
.info{{background:#f0f0f0;border-color:#888}}.dim{{opacity:.8;border-style:dashed}}
.ln{{fill:none;stroke-width:2}}.ln.yes{{stroke:#1a7f37}}.ln.no{{stroke:#cf222e}}.ln.n{{stroke:#666}}
.lb{{font-size:12px;font-weight:700}}.lb.yes{{fill:#1a7f37}}.lb.no{{fill:#cf222e}}
.leg span{{margin-right:14px;font-size:12px}}
</style></head><body>
<h1>Cough and fast breathing: question flow</h1>
<div class="sub">Yellow = question, green = actions, red = refer. Hover a box for its source blocks. Layout is arranged from extraction_output.json; Yes/No labels follow the PDF's "If ANY danger sign" and "If NO danger sign" branches and the fast breathing row. The PDF does not draw a "No cough" branch, so none is shown. Dashed = other danger signs outside the cough scope.</div>
<div class="leg"><span style="color:#1a7f37">Yes</span><span style="color:#cf222e">No</span></div>
<div id="c"><svg width="1020" height="1210"><defs>
<marker id="ayes" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#1a7f37"/></marker>
<marker id="ano" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#cf222e"/></marker>
<marker id="an" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#666"/></marker></defs>{svg}</svg>
{''.join(box(k,v) for k,v in B.items())}</div></body></html>"""
(here/"flow.html").write_text(html); print("wrote flow.html")
