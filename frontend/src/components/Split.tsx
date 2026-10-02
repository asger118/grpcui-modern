import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import { cn } from "../lib/cn";

interface Props {
  /** "row" puts panes side by side, "column" stacks them. */
  direction: "row" | "column";
  first: ReactNode;
  second: ReactNode;
  initial?: number;
}

/** Two panes with a draggable divider; the split is a fraction of the container. */
export function Split({ direction, first, second, initial = 0.5 }: Props) {
  const [fraction, setFraction] = useState(initial);
  const [dragging, setDragging] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const row = direction === "row";

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging || !container.current) return;
    const rect = container.current.getBoundingClientRect();
    const pos = row ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;
    setFraction(Math.min(0.85, Math.max(0.15, pos)));
  };

  return (
    <div
      ref={container}
      className={cn("flex h-full min-h-0 w-full min-w-0", row ? "flex-row" : "flex-col", dragging && "select-none")}
    >
      <div className="min-h-0 min-w-0 overflow-hidden" style={{ flexBasis: `${fraction * 100}%` }}>
        {first}
      </div>
      <div
        role="separator"
        aria-orientation={row ? "vertical" : "horizontal"}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={() => setDragging(false)}
        onDoubleClick={() => setFraction(initial)}
        className={cn(
          "group relative shrink-0 bg-zinc-800 transition-colors",
          row ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
          dragging && "bg-sky-500",
        )}
      >
        {/* wider invisible hit area */}
        <div className={cn("absolute group-hover:bg-sky-500/40", row ? "inset-y-0 -inset-x-1" : "inset-x-0 -inset-y-1")} />
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{second}</div>
    </div>
  );
}
