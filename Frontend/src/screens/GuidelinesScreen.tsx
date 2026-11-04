import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import * as api from "../api";
import { PATHWAYS, fnv } from "../domain/data";
import { verLabel } from "../domain/workflow";
import type { Guideline, PipelineStep, Role, Workflow } from "../domain/types";
import type { Actions } from "../actions";

/** "14-15, 18" -> [14, 15, 18] */
function parsePages(s: string, max: number): number[] {
  const out = new Set<number>();
  s.split(",").map(x => x.trim()).filter(Boolean).forEach(part => {
    const [a, b] = part.split("-").map(x => parseInt(x, 10));
    if (isNaN(a)) return;
    for (let n = a; n <= (isNaN(b) ? a : b) && n - a < 500; n++) if (n >= 1 && n <= max) out.add(n);
  });
  return [...out].sort((x, y) => x - y);
}

const BUSY = (g: Guideline) => g.status === "Uploading" || g.status === "Processing";
const STATUS_TEXT: Partial<Record<Guideline["status"], string>> = { Indexed: "Ready", Processing: "Processing" };

function elapsed(s: PipelineStep): string {
  if (!s.startedAt || !s.endedAt) return "";
  const ms = new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime();
  return ms < 1000 ? ms + " ms" : (ms / 1000).toFixed(1) + " s";
}

/** The loader: where the file is in upload -> S3 event -> extract -> digest -> logic model. */
function PipelineLoader({ g }: { g: Guideline }) {
  if (!g.steps) return null;
  return (
    <div className="pipeline" aria-live="polite">
      <div className="lab">Pipeline</div>
      <ol className="psteps">
        {g.steps.map(s => (
          <li key={s.key} className={"pstep " + s.state}>
            <span className="pdot" aria-hidden="true" />
            <span className="plabel">{s.label}</span>
            <span className="pstate">
              {s.state === "running" ? <span className="spin" aria-hidden="true" /> : null}
              {{ pending: "Waiting", running: "Running", done: elapsed(s) || "Done", failed: "Failed" }[s.state]}
            </span>
            {s.detail ? <span className="pdetail mono">{s.detail}</span> : null}
          </li>
        ))}
      </ol>
      {g.status === "Indexed" && g.logicModel?.source === "placeholder" ? (
        <div className="banner muted">
          No model is connected yet, so the logic model is the hardcoded sample spec (cough_fast_breathing v1), not content drafted from this file.
          {" Quote check: " + g.logicModel.quotesFound + " of " + g.logicModel.quotesTotal + " source quotes appear in this file" + (g.logicModel.quotesOnPage !== undefined ? ", " + g.logicModel.quotesOnPage + " on the page they cite" : "") + "."}
        </div>
      ) : null}
      {g.error && g.status !== "Indexed" ? <div className="banner" role="alert">{g.error}</div> : null}
    </div>
  );
}

export function GuidelinesScreen({ w, role, act }: { w: Workflow | null; role: Role; act: Actions }) {
  const [lib, setLib] = useState<Guideline[]>([]);
  const [selId, setSelId] = useState(api.LIVE ? "" : "g-imci");
  const [path, setPath] = useState(PATHWAYS[0]);
  const [pageText, setPageText] = useState("14-15");
  /** File name -> upload percent, while the PUT to S3 runs (before the backend has a record). */
  const [uploading, setUploading] = useState<Record<string, number>>({});
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = () => api.listGuidelines().then(l => { setLib(l); setLoadErr(null); return l; }, e => { setLoadErr(e instanceof Error ? e.message : String(e)); return null; });

  useEffect(() => {
    refresh().then(l => { if (l && api.LIVE && l.length) setSelId(id => id || l[l.length - 1].id); });
  }, []);

  // Poll while any file is still moving through the pipeline.
  const busy = lib.some(BUSY);
  useEffect(() => {
    if (!api.LIVE || !busy) return;
    const t = setInterval(refresh, 700);
    return () => clearInterval(t);
  }, [busy]);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    for (const file of files) {
      setUploading(u => ({ ...u, [file.name]: 0 }));
      try {
        const g = await api.uploadGuideline(file, pct => setUploading(u => ({ ...u, [file.name]: pct })));
        setSelId(g.id);
        await refresh();
      } catch (err) {
        setLoadErr(file.name + ": " + (err instanceof Error ? err.message : String(err)));
      } finally {
        setUploading(u => { const n = { ...u }; delete n[file.name]; return n; });
      }
    }
  };

  const f = lib.find(x => x.id === selId);
  const maxPages = f?.pages ?? 1;

  // A file from the pipeline: default to all of its pages once they are known.
  useEffect(() => {
    if (api.LIVE && f?.pages) setPageText(f.pages > 1 ? "1-" + f.pages : "1");
  }, [selId, f?.pages]);

  const pages = f?.pages ? parsePages(pageText, maxPages) : [];
  const wrongPath = path !== PATHWAYS[0];
  const sampleOnly = wrongPath || (!api.LIVE && selId !== "g-imci");
  const canCreate = role === "po" && !!f && f.status === "Indexed" && pages.length > 0 && !sampleOnly && !creating;

  const create = async () => {
    if (!f) return;
    setCreating(true);
    try { await act.createDraft({ guidelineId: f.id, pathway: path, pages }); }
    finally { setCreating(false); }
  };

  return (
    <div className="grid2 g-lib">
      <section className="panel">
        <div className="ph"><h2>Guideline library</h2><span className="ver">{lib.length} files{api.LIVE ? " · live pipeline" : " · sample data"}</span></div>
        <input ref={fileInput} type="file" multiple accept={api.ACCEPT} hidden onChange={onPick} />
        <div className="btnrow">
          <button type="button" className="btn primary" disabled={role !== "po"} onClick={() => fileInput.current?.click()}>Upload guideline</button>
          <span className="note">{api.LIVE ? "Local mode reads PDF (with a text layer), TXT, MD, CSV and HTML" : "PDF, Word, spreadsheet, image or web page"}</span>
        </div>
        {loadErr ? <div className="banner" role="alert">{loadErr}</div> : null}
        {Object.entries(uploading).map(([n, pct]) => (
          <div key={n} className="libitem"><span className="tbadge">...</span><span className="lname">{n}</span><span className="note">Uploading {pct}%</span><span className="st"><span className="spin" aria-hidden="true" />Uploading</span></div>
        ))}
        {api.LIVE && !lib.length && !Object.keys(uploading).length && !loadErr ? <p className="note">No guidelines yet. Upload one to start the pipeline; try Backend/samples/cough-guideline-sample.pdf.</p> : null}
        {lib.map(x => (
          <button key={x.id} type="button" className={"libitem" + (x.id === selId ? " on" : "")} onClick={() => setSelId(x.id)}>
            <span className="tbadge">{x.type}</span>
            <span className="lname">{x.name}</span>
            <span className="note">{BUSY(x) ? (x.steps?.find(s => s.state === "running")?.label ?? "Waiting for the S3 event") + "..." : x.meta}</span>
            <span className={"st " + (x.status === "Indexed" ? "ok" : x.status === "Failed" || x.status === "Unsupported" ? "bad" : "")}>
              {BUSY(x) ? <span className="spin" aria-hidden="true" /> : null}{STATUS_TEXT[x.status] ?? x.status}
            </span>
          </button>
        ))}
      </section>

      {f ? (
        <section className="panel">
          <span className="note">Selected guideline</span>
          <h2 className="big">{f.name}</h2>
          <div className="mono note">{f.s3Uri ?? "s3://guidelines/" + f.name.toLowerCase().replace(/[^a-z0-9.]+/g, "-") + " · sha256 " + fnv(f.name)}</div>

          <PipelineLoader g={f} />

          <div className="lab">Pathway to extract</div>
          <div className="chips">
            {PATHWAYS.map(p => <button key={p} type="button" className={"chipb" + (path === p ? " on" : "")} aria-pressed={path === p} onClick={() => setPath(p)}>{p}</button>)}
          </div>

          <div className="fld">
            <label htmlFor="pages">Pages to read</label>
            <input id="pages" type="text" className="mono" value={pageText} disabled={!f.pages} onChange={e => setPageText(e.target.value)} placeholder="for example 14-15, 18" />
            <span className="note">
              {f.pages ? pages.length + " of " + f.pages + " pages selected" + (pages.length ? " (" + pages.join(", ") + ")" : "") + ". Only these pages are indexed and sent to the model."
                : BUSY(f) ? "Pages are known once text extraction finishes." : "This file has no readable pages."}
            </span>
          </div>

          <div className="lab">Existing form to compare against</div>
          <div className="mono pcard">forms/app/cough_assessment.xlsx · deployed v3</div>

          {!w || w.state === "none" ? (
            <div className="actions">
              <span className="note">
                {role !== "po" ? "Only the program officer can create a workflow draft."
                  : wrongPath && api.LIVE ? "The logic model format covers only the cough pathway for now."
                  : sampleOnly ? "Sample data covers only the IMCI booklet and the cough pathway."
                  : BUSY(f) ? "Waiting for the pipeline to finish."
                  : f.status !== "Indexed" ? "This file did not make it through the pipeline."
                  : api.LIVE ? "Loads the logic model JSON the pipeline built for this file."
                  : "Indexes the pages and drafts questions and rules with verbatim quotes."}
              </span>
              <button type="button" className="btn primary" disabled={!canCreate} onClick={create}>
                {creating ? <><span className="spin" aria-hidden="true" />Loading logic model...</> : "Create workflow draft"}
              </button>
            </div>
          ) : (
            <div className="banner good">A workflow exists for this pathway ({verLabel(w)}). <Link to="/review">Open Review</Link>.</div>
          )}
        </section>
      ) : api.LIVE && lib.length ? (
        <section className="panel"><p className="note">Pick a guideline on the left.</p></section>
      ) : null}
    </div>
  );
}
