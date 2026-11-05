import type { ReactNode } from "react";
import { Icon } from "./Icon";

/** Page heading: eyebrow (accent part • context), display title, actions on the right. */
export function PageHead({ eyebrow, title, actions }: { eyebrow: [string, string?]; title: string; actions?: ReactNode }) {
  return (
    <div className="rvhead">
      <div className="phead">
        <div className="eyebrow"><span className="eb-a">{eyebrow[0]}</span>{eyebrow[1] ? <><span className="eb-sep" aria-hidden="true">•</span><span>{eyebrow[1]}</span></> : null}</div>
        <h1 className="display">{title}</h1>
      </div>
      {actions}
    </div>
  );
}

/** Section header: icon tile, title, subtitle, divider below. */
export function SectionHead({ icon, tone = "grey", title, sub, aside }: { icon: string; tone?: "teal" | "blue" | "grey"; title: ReactNode; sub?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="shead">
      <span className={"stile " + tone}><Icon name={icon} size={22} /></span>
      <div className="shead-t"><h2>{title}</h2>{sub ? <p className="note">{sub}</p> : null}</div>
      {aside}
    </div>
  );
}
