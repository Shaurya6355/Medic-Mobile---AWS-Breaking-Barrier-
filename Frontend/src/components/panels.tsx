import { V3_HASH } from "../domain/data";
import type { Workflow } from "../domain/types";

export function VersionsPanel({ w }: { w: Workflow }) {
  return (
    <section className="panel">
      <h2>Version history</h2>
      <div className="vrow"><span className="mono b">v3</span><span><b>Deployed</b><span className="note">{V3_HASH} · Oct 12</span></span></div>
      {w.versions.map((v, i) => (
        <div key={i} className="vrow"><span className="mono b">{v.ver}</span><span><b>{v.event}</b><span className="note">{v.meta}</span></span></div>
      ))}
      <p className="note" style={{ margin: 0 }}>Each version is a frozen logic model with a hash. An approval points at one hash.</p>
    </section>
  );
}
