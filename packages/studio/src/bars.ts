import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { moveBar, placeTip, tabStop } from './ledger-math.ts';

/**
 * What the Ledger's bar charts share (the Totals chart and Trends): the box the SVG is drawn to (at its real width, so text keeps its 12 px
 * on a phone), the tooltip layer and where it goes, and the keyboard. Hover and focus open the same tooltip, the pointer wins while it is
 * over a bar; there is one tab stop, the last bar focused (else `busy`, the busiest), and the arrows move between bars.
 * `tipAt(i)` is bar `i`'s geometry in the chart's pixels, for placing the tooltip (undefined: no such bar). Spread `bar(i)` on each
 * bar's `<g className="bar">` and `svg` on the `<svg>`; put `box` on its container and `tip` on the tooltip.
 */
export function useBars(n: number, busy: number, tipAt: (i: number) => { x: number; w: number; top: number } | undefined) {
  const [hov, setHov] = useState<number>();
  const [foc, setFoc] = useState<number>();
  const [rov, setRov] = useState<number>(); // the last bar focused, so a 30-day chart costs one Tab, not 30
  const box = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(1000);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const at = hov ?? foc;
  const stop = tabStop(rov, busy, n);

  // The tooltip is sized by its content, so it is placed after it is laid out.
  useLayoutEffect(() => {
    const el = tip.current;
    const bar = at === undefined ? undefined : tipAt(at);
    if (!el || !bar) return;
    const { left, top } = placeTip(bar, { w: el.offsetWidth, h: el.offsetHeight }, W);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  });

  return {
    box, tip, W, at,
    svg: { onKeyDown: (e: KeyboardEvent<SVGSVGElement>) => { if (e.key === 'Escape') { setHov(undefined); setFoc(undefined); } } },
    bar: (i: number) => ({
      tabIndex: i === stop ? 0 : -1,
      onMouseEnter: () => setHov(i),
      onMouseLeave: () => setHov(undefined),
      onFocus: () => { setFoc(i); setRov(i); },
      onBlur: () => setFoc(undefined),
      onKeyDown: (e: KeyboardEvent<SVGGElement>) => {
        const to = e.altKey || e.ctrlKey || e.metaKey ? null : moveBar(e.key, i, n); // Alt+Left is the browser's Back
        if (to === null) return;
        e.preventDefault();
        box.current?.querySelectorAll<SVGGElement>('.bar')[to]?.focus();
      },
    }),
  };
}
