import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { PATHWAYS, fnv } from "../domain/data";
import { verLabel } from "../domain/workflow";
import type { Guideline, PipelineStep, Role, Workflow } from "../domain/types";
import type { Actions } from "../actions";
import { Icon } from "../components/Icon";
import { PageHead, SectionHead } from "../components/Page";

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

/** The loader: where the run is in upload -> ingest -> extract -> logic model -> backend checks. */
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
  // Each guideline has its own workflow; the one open now (w) may belong to another guideline.
  const mine = f ? (w && w.state !== "none" && w.guideline?.id === f.id ? w : api.workflowFor(f.id)) : null;
  const maxPages = f?.pages ?? 1;

  // Live: the backend chose the pages when the run was created (every page), so there is nothing to pick here.
  const pages = api.LIVE ? [] : f?.pages ? parsePages(pageText, maxPages) : [];
  const wrongPath = path !== PATHWAYS[0];
  const sampleOnly = wrongPath || (!api.LIVE && selId !== "g-imci");
  const canCreate = role === "clinician" && !!f && f.status === "Indexed" && (api.LIVE || pages.length > 0) && !sampleOnly && !creating;

  const canRelease = role === "it" && api.LIVE && !!f?.locked && !creating;
  const openRelease = async () => {
    if (!f) return;
    setCreating(true);
    try { await act.openForRelease({ guidelineId: f.id, pathway: path }); }
    finally { setCreating(false); }
  };

  const create = async () => {
    if (!f) return;
    setCreating(true);
    try { await act.createDraft({ guidelineId: f.id, pathway: path, pages }); }
    finally { setCreating(false); }
  };

  return (
    <>
      <PageHead eyebrow={["Step 01", "Guideline to form review"]} title="Guidelines" />
    <div className="grid2 g-lib">
      <section className="panel">
        <SectionHead icon="library_books" tone="blue" title="Guideline library" sub={lib.length + " files" + (api.LIVE ? " · live pipeline" : " · sample data")} />
        <input ref={fileInput} type="file" multiple accept={api.LIVE ? ".pdf" : api.ACCEPT} hidden onChange={onPick} />
        <div className="btnrow">
          <button type="button" className="btn primary" disabled={role !== "clinician"} onClick={() => fileInput.current?.click()}><Icon name="upload_file" size={18} />Upload guideline</button>
          <span className="note">{api.LIVE ? "PDF only; the backend runs ingest, extract, logic drafting and checks" : "PDF, Word, spreadsheet, image or web page"}</span>
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
          <SectionHead icon="description" title={f.name} sub={<span className="mono">{f.s3Uri ?? "s3://guidelines/" + f.name.toLowerCase().replace(/[^a-z0-9.]+/g, "-") + " · sha256 " + fnv(f.name)}</span>} />

          <PipelineLoader g={f} />

          <div className="lab">Pathway to extract</div>
          <div className="chips">
            {PATHWAYS.map(p => <button key={p} type="button" className={"chipb" + (path === p ? " on" : "")} aria-pressed={path === p} onClick={() => setPath(p)}>{p}</button>)}
          </div>

          {api.LIVE ? <div className="note">The backend reads every page of the PDF.</div> : <div className="fld">
            <label htmlFor="pages">Pages to read</label>
            <input id="pages" type="text" className="mono" value={pageText} disabled={!f.pages} onChange={e => setPageText(e.target.value)} placeholder="for example 14-15, 18" />
            <span className="note">
              {f.pages ? pages.length + " of " + f.pages + " pages selected" + (pages.length ? " (" + pages.join(", ") + ")" : "") + ". Only these pages are indexed and sent to the model."
                : BUSY(f) ? "Pages are known once text extraction finishes." : "This file has no readable pages."}
            </span>
          </div>}

          <div className="lab">Existing form to compare against</div>
          <div className="mono pcard">forms/app/cough_assessment.xlsx · deployed v3</div>

          {role === "it" && (!w || w.state === "none" || w.remote?.runId !== f.id) ? (
            <div className="actions">
              <span className="note">{f.locked ? "The clinician approved this run. Open it to run the synthetic check and approve the deploy." : "Opens for release once the clinician approves this run."}</span>
              <button type="button" className="btn primary" disabled={!canRelease} onClick={openRelease}>
                {creating ? <><span className="spin" aria-hidden="true" />Loading approved version...</> : "Open for release"}
              </button>
            </div>
          ) : (
            <div className="actions">
              <span className="note">
                {role !== "clinician" ? "Only the clinician can start a workflow."
                  : wrongPath && api.LIVE ? "The logic model format covers only the cough pathway for now."
                  : sampleOnly ? "Sample data covers only the IMCI booklet and the cough pathway."
                  : BUSY(f) ? "Waiting for the pipeline to finish."
                  : f.status !== "Indexed" ? "This file did not make it through the pipeline."
                  : api.LIVE ? "Loads the latest logic model version of this run from the backend."
                  : "Drafts questions and rules with verbatim quotes; the AI agent checks them before you see them."}
              </span>
              {mine ? <button type="button" className="btn" disabled={creating} onClick={() => void act.openWorkflow(f.id)}>Open workflow ({verLabel(mine)})</button> : null}
              <button type="button" className="btn primary" disabled={!canCreate} onClick={create}>
                {creating ? <><span className="spin" aria-hidden="true" />Loading logic model...</> : "Create workflow draft"}
              </button>
            </div>
          )}
        </section>
      ) : api.LIVE && lib.length ? (
        <section className="panel"><p className="note">Pick a guideline on the left.</p></section>
      ) : null}
    </div>
    </>
  );
}
