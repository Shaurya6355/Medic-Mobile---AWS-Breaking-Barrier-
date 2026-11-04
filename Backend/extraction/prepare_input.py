"""Deterministic pre-processing for extraction (no model calls).
Splits a PDF into page images and numbered text blocks with bounding boxes.
Usage: python3 prepare_input.py <pdf> <out_dir>
"""
import hashlib, json, re, subprocess, sys, xml.etree.ElementTree as ET
from pathlib import Path

pdf, out = Path(sys.argv[1]), Path(sys.argv[2])
(out / "pages").mkdir(parents=True, exist_ok=True)

subprocess.run(["pdftoppm", "-r", "110", "-png", str(pdf), str(out / "pages" / "page")], check=True)
xml = subprocess.run(["pdftotext", "-bbox-layout", str(pdf), "-"], check=True, capture_output=True, text=True).stdout
xml = xml.replace(' xmlns="http://www.w3.org/1999/xhtml"', "")
# the PDF maps some ligatures (ti, fi) to control characters; drop them so the XML parses
xml = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", xml)
root = ET.fromstring(xml)

pages = []
for pi, page in enumerate(root.iter("page"), start=1):
    blocks = []
    for bi, blk in enumerate(page.iter("block"), start=1):
        lines = [" ".join(w.text or "" for w in ln.iter("word")) for ln in blk.iter("line")]
        text = "\n".join(l for l in lines if l.strip())
        if not text.strip():
            continue
        blocks.append({
            "block_id": f"p{pi}.b{bi}", "pdf_page": pi,
            "bbox": [round(float(blk.get(k)), 1) for k in ("xMin", "yMin", "xMax", "yMax")],
            "text": text,
        })
    pages.append({"pdf_page": pi, "width": float(page.get("width")), "height": float(page.get("height")),
                  "image": f"pages/page-{pi:02d}.png", "blocks": blocks})

doc = {"source_id": pdf.stem, "doc_name": pdf.name,
       "doc_sha256": hashlib.sha256(pdf.read_bytes()).hexdigest(),
       "page_count": len(pages), "pages": pages}
(out / "input_blocks.json").write_text(json.dumps(doc, indent=2, ensure_ascii=False))
print(f"pages={len(pages)} blocks={sum(len(p['blocks']) for p in pages)}")
