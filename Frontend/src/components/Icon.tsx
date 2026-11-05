/** A Material Symbols Outlined glyph (the design system's icon set). Decorative unless `label` is given. */
export function Icon({ name, size = 20, fill = false, label, className = "" }: { name: string; size?: number; fill?: boolean; label?: string; className?: string }) {
  return (
    <span className={"ms" + (fill ? " fill" : "") + (className ? " " + className : "")} style={{ fontSize: size }} aria-hidden={label ? undefined : true} aria-label={label} role={label ? "img" : undefined}>
      {name}
    </span>
  );
}
