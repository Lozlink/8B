import type { CSSProperties } from "react";

/** A pool ball: 1 to 8, or the cue ball. Drawn in CSS (app/site/site.css). Decorative unless labelled. */
export function Ball({ n, style, className = "" }: { n: number | "cue"; style?: CSSProperties; className?: string }) {
  return (
    <span aria-hidden="true" className={`ball ball-${n} ${className}`} style={style}>
      {n === "cue" ? null : (
        <span>
          <b>{n}</b>
        </span>
      )}
    </span>
  );
}
