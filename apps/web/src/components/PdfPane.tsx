import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, forwardRef, useRef, useState } from 'react';
import { useShortcutLabel } from '../util/shortcuts';
import { pagesOnScreen, scrollTopForPage, type PdfPagesStore } from '../util/pdfPages';
import { cMapUrl, pdfjs } from '../util/pdfjs';
import { citeEntry, renderCitePreview } from '../editor/latexExtras';

export interface PdfPaneHandle {
  /** Scroll to a page + PDF-space y and flash a highlight (forward SyncTeX). */
  showForward(page: number, y: number, h?: number): void;
  /** Re-run the fit-to-width layout without changing zoom — the zoom label's
   *  reset is a no-op at 100%, which is exactly where a stale fit hurts. */
  refit(): void;
  /** Scroll so the top of a page (1-based, clamped) is at the top of the pane. */
  goToPage(page: number): void;
}

interface Props {
  pdfUrl: string | null;
  /** The project whose bibliography the cite popups read; with branch it keys
   *  the bib index that citeEntry() looks keys up in. */
  projectId: string;
  /** The branch whose PDF is shown; a change empties the pane (see below). */
  branch?: string;
  status: 'idle' | 'compiling' | 'ok' | 'error';
  zoom?: number; // multiplier on fit-width (1 = fit width)
  /** Whether the failed compile produced actual parsed errors — gates the "fix the errors" copy. */
  hasErrors?: boolean;
  /** The last run failed: whatever is on screen is from the last successful typeset. */
  stale?: boolean;
  /** onFirstOpen waits for this: the parent knows what the project holds only
   *  after its file listing arrives. */
  ready?: boolean;
  /** No .tex on the branch: the idle copy must not invite a typeset that
   *  would only fail. */
  hasTex?: boolean;
  onFirstOpen(): void;
  /** Inverse SyncTeX: user double-clicked at (page, pdfX, pdfY) in PDF points. */
  onInverse?(page: number, x: number, y: number): void;
  /** Receives the page on screen and the page count; null while no PDF shows. */
  pages?: PdfPagesStore;
}

const PdfPane = forwardRef<PdfPaneHandle, Props>(function PdfPane({ pdfUrl, projectId, branch, status, zoom = 1, hasErrors = false, stale = false, ready = true, hasTex = true, onFirstOpen, onInverse, pages }, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const typesetKeys = useShortcutLabel('typeset');
  const innerRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const renderTask = useRef(0);
  const firstOpenFired = useRef(false);
  // per-page viewport info for coordinate mapping. `anno` is the cite-link
  // overlay for the page (lazily built with the pixels, dropped when released).
  const pageInfo = useRef<Array<{ el: HTMLCanvasElement; scale: number; height: number; anno?: HTMLDivElement | null }>>([]);

  // Cite popup: shown on hover and pinned on click. projectId/branch are read
  // through refs so the imperative hotspot handlers built inside the render
  // effect (which doesn't depend on them) never look keys up in a stale index.
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const branchRef = useRef(branch);
  branchRef.current = branch;
  const popRef = useRef<HTMLDivElement | null>(null);
  const popAnchor = useRef<HTMLElement | null>(null);
  const popPinned = useRef(false);
  const hoverTimer = useRef(0);

  const hideCitePop = useCallback(() => {
    popPinned.current = false;
    popAnchor.current = null;
    popRef.current?.remove();
    popRef.current = null;
  }, []);

  // Lay the cite-link overlay exactly over its page canvas. Called after layout
  // and on every zoom/width relayout so the hotspots (positioned in percent)
  // track the canvas box the user actually sees.
  const positionLayer = useCallback((it: { el: HTMLCanvasElement; anno?: HTMLDivElement | null }) => {
    const layer = it.anno;
    if (!layer) return;
    layer.style.left = `${it.el.offsetLeft}px`;
    layer.style.top = `${it.el.offsetTop}px`;
    layer.style.width = `${it.el.clientWidth}px`;
    layer.style.height = `${it.el.clientHeight}px`;
  }, []);

  const showCitePop = useCallback((anchor: HTMLElement, key: string, pinned: boolean) => {
    const scroller = scrollRef.current, inner = innerRef.current;
    if (!scroller || !inner) return;
    const entry = citeEntry(projectIdRef.current, branchRef.current || 'main', key);
    let pop = popRef.current;
    // replaceChildren on a relayout detaches the popup; rebuild if it's gone.
    if (!pop || !pop.isConnected) {
      pop = document.createElement('div');
      pop.className = 'pdf-cite-pop';
      pop.setAttribute('data-testid', 'pdf-cite-pop');
      inner.appendChild(pop);
      popRef.current = pop;
    }
    pop.replaceChildren(renderCitePreview(entry, key));
    popPinned.current = pinned;
    popAnchor.current = anchor;
    // Place above the hotspot, flipping below when it would clip the top of the
    // scrolled view. Coordinates are relative to inner (the popup's offset
    // parent), measured off the live rects so zoom/scroll never desync them.
    pop.style.left = '0px';
    pop.style.top = '0px';
    const ar = anchor.getBoundingClientRect();
    const ir = inner.getBoundingClientRect();
    const left = ar.left - ir.left, top = ar.top - ir.top;
    const x = Math.max(4, Math.min(left, inner.clientWidth - pop.offsetWidth - 4));
    let y = top - pop.offsetHeight - 8;
    if (y < scroller.scrollTop + 4) y = top + ar.height + 8;
    pop.style.left = `${x}px`;
    pop.style.top = `${y}px`;
  }, []);

  useImperativeHandle(ref, () => ({
    showForward(page, y, h = 12) {
      const info = pageInfo.current[page - 1];
      const scroller = scrollRef.current;
      if (!info || !scroller) return;
      const top = info.el.offsetTop + y * info.scale;
      scroller.scrollTo({ top: top - scroller.clientHeight / 3, behavior: 'smooth' });
      // flash a highlight overlay
      const flash = document.createElement('div');
      flash.className = 'pdf-flash';
      flash.style.left = `${info.el.offsetLeft}px`;
      flash.style.top = `${info.el.offsetTop + (y - h) * info.scale}px`;
      flash.style.width = `${info.el.clientWidth}px`;
      flash.style.height = `${Math.max(16, h * 2 * info.scale)}px`;
      innerRef.current?.appendChild(flash);
      setTimeout(() => flash.remove(), 1400);
    },
    refit() {
      setRefitTick((n) => n + 1);
    },
    goToPage(page) {
      const info = pageInfo.current;
      const scroller = scrollRef.current;
      if (!info.length || !scroller) return;
      const i = Math.min(Math.max(1, Math.round(page)), info.length) - 1;
      scroller.scrollTo({ top: scrollTopForPage(info[i].el, info[i - 1]?.el) });
    },
  }), []);

  // The page on screen, for the page field in the preview's header. Measured
  // at most once a frame while scrolling, and only around the viewport.
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const measureFrame = useRef(0);
  const measurePage = useCallback(() => {
    if (measureFrame.current) return;
    measureFrame.current = requestAnimationFrame(() => {
      measureFrame.current = 0;
      const store = pagesRef.current, scroller = scrollRef.current;
      if (!store || !scroller) return;
      const info = pageInfo.current;
      store.set(pagesOnScreen(scroller, info.length, (i) => info[i].el));
    });
  }, []);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.addEventListener('scroll', measurePage, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', measurePage);
      cancelAnimationFrame(measureFrame.current);
      measureFrame.current = 0;
      pagesRef.current?.set(null);
    };
  }, [measurePage]);

  // auto-typeset once when the pane first mounts with no pdf
  useEffect(() => {
    if (!firstOpenFired.current && ready && !pdfUrl && status === 'idle') {
      firstOpenFired.current = true;
      onFirstOpen();
    }
  }, [pdfUrl, status, ready, onFirstOpen]);

  // Zoom clicks arrive in bursts; debounce so three +10% clicks trigger one
  // re-layout instead of three full render passes.
  const [layoutZoom, setLayoutZoom] = useState(zoom);
  useEffect(() => {
    // The click itself must show: stretch the pages already on screen to the
    // new size at once, and let the debounced pass below redraw them sharp.
    const ratio = zoom / layoutZoom;
    for (const { el } of pageInfo.current) {
      const w = Number(el.dataset.w), h = Number(el.dataset.h);
      if (w && h) { el.style.width = `${Math.floor(w * ratio)}px`; el.style.height = `${Math.floor(h * ratio)}px`; }
    }
    // Canvases just changed size, so every overlay's box (and the offsetTop of
    // later pages) moved — realign the cite layers so hotspots stay on target.
    for (const it of pageInfo.current) positionLayer(it);
    hideCitePop();
    measurePage();
    const t = setTimeout(() => setLayoutZoom(zoom), 150);
    return () => clearTimeout(t);
  }, [zoom]);

  // A width change (splitter drag, window resize) must re-run the fit-to-width
  // layout: the render pass below reads scroller.clientWidth once and bakes it
  // into every canvas size, so without tracking it the pages keep their old
  // width and zooming is the only way out. Debounced like zoom bursts — a drag
  // emits a resize event per frame. widthTick is purely the layout trigger;
  // the pass reads the live width itself.
  const [widthTick, setWidthTick] = useState(0);
  const [refitTick, setRefitTick] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    let last = el.clientWidth;
    const ro = new ResizeObserver(() => {
      measurePage(); // a taller or shorter pane can put another page on screen
      clearTimeout(t);
      t = setTimeout(() => {
        if (el.clientWidth !== last) { last = el.clientWidth; setWidthTick((n) => n + 1); }
      }, 150);
    });
    ro.observe(el);
    return () => { clearTimeout(t); ro.disconnect(); };
  }, []);

  // A branch switch nulls pdfUrl, which alone never touches the canvases —
  // the pane would keep showing the previous branch's pages, and a failed
  // typeset on the new branch would label them as its last successful one.
  useEffect(() => {
    renderTask.current++;
    innerRef.current?.replaceChildren();
    pageInfo.current = [];
    setRendered(false);
    pagesRef.current?.set(null);
    hideCitePop();
  }, [branch, hideCitePop]);

  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  useEffect(() => {
    if (!pdfUrl || !innerRef.current) return;
    const my = ++renderTask.current;
    const container = innerRef.current;
    const scroller = scrollRef.current!;
    const prevScroll = scroller.scrollTop;
    // This pass replaceChildren()s the pages, detaching any open popup; drop it
    // so a stale pinned flag doesn't suppress hover after a relayout.
    hideCitePop();
    let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']> | null = null;
    let observer: IntersectionObserver | null = null;

    // Virtualized rendering: every page gets a correctly-sized canvas
    // immediately (layout only — getViewport, no rasterization), so scroll
    // geometry, SyncTeX offsets, and test selectors are all valid from the
    // start. Pixels are rasterized only for pages near the viewport; far
    // offscreen pages release their backing store (a 100-page paper would
    // otherwise hold ~660 MB of RGBA at zoom 1, gigabytes when zoomed).
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const states = new Map<number, 'blank' | 'rendering' | 'done'>();
    let chain: Promise<void> = Promise.resolve(); // serialize worker renders

    // Turn a page's hyperref cite links into hover/click hotspots. hyperref
    // names each bibliography anchor `cite.<bibkey>`, so a Link annotation whose
    // named dest starts with `cite.` hands us the key directly — no number→key
    // mapping, and it covers numeric [1], author-year, and natbib styles alike.
    // Rects are percentages of the page box so the zoom live-stretch keeps them
    // aligned without a rebuild; a document without hyperref simply has none.
    const buildCiteLinks = async (page: Awaited<ReturnType<NonNullable<typeof doc>['getPage']>>, info: (typeof pageInfo.current)[number]) => {
      const layer = info.anno;
      if (!layer || layer.dataset.built) return;
      let annos: Array<Record<string, unknown>>;
      try { annos = await page.getAnnotations() as Array<Record<string, unknown>>; }
      catch { return; }
      if (my !== renderTask.current || info.anno !== layer) return;
      const base = page.getViewport({ scale: 1 });
      for (const a of annos) {
        const dest = a.dest;
        if (a.subtype !== 'Link' || typeof dest !== 'string' || !dest.startsWith('cite.')) continue;
        const key = dest.slice('cite.'.length);
        const r = a.rect as [number, number, number, number] | undefined;
        if (!key || !r) continue;
        // Annotation rects are PDF points, bottom-left origin; convert to a
        // top-left box as a fraction of the page so CSS percentages place it.
        const [x1, y1, x2, y2] = r;
        const hot = document.createElement('a');
        hot.className = 'pdf-cite-link';
        hot.tabIndex = 0;
        hot.dataset.citeKey = key;
        hot.setAttribute('data-testid', `pdf-cite-link-${key}`);
        hot.style.left = `${(Math.min(x1, x2) / base.width) * 100}%`;
        hot.style.top = `${((base.height - Math.max(y1, y2)) / base.height) * 100}%`;
        hot.style.width = `${(Math.abs(x2 - x1) / base.width) * 100}%`;
        hot.style.height = `${(Math.abs(y2 - y1) / base.height) * 100}%`;
        layer.appendChild(hot);
      }
      layer.dataset.built = '1';
    };

    const rasterize = (i: number) => {
      if (states.get(i) === 'rendering' || states.get(i) === 'done') return;
      states.set(i, 'rendering');
      chain = chain.then(async () => {
        if (my !== renderTask.current || !doc) return;
        const info = pageInfo.current[i - 1];
        if (!info) return;
        try {
          const page = await doc.getPage(i);
          if (my !== renderTask.current) return;
          const viewport = page.getViewport({ scale: info.scale });
          const canvas = info.el;
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          const cctx = canvas.getContext('2d')!;
          cctx.scale(dpr, dpr);
          await page.render({ canvasContext: cctx, viewport }).promise;
          if (my === renderTask.current) states.set(i, 'done');
          if (my === renderTask.current) await buildCiteLinks(page, info);
        } catch (err) {
          states.set(i, 'blank');
          if ((err as { name?: string })?.name !== 'RenderingCancelledException') console.error('[pdf] page render failed', err);
        }
      });
    };

    const release = (i: number) => {
      if (states.get(i) !== 'done') return;
      const info = pageInfo.current[i - 1];
      if (!info) return;
      // Zero the backing store (frees the bitmap); CSS size stays, so layout,
      // offsets, and visibility checks are untouched.
      info.el.width = 0;
      info.el.height = 0;
      states.set(i, 'blank');
    };

    (async () => {
      try {
        // CJK PDFs embed Identity-H CID fonts; pdf.js needs the packed CMaps
        // to map their glyphs or every CJK character renders as blank space
        // (Latin text and math are unaffected). cMapUrl says where they are
        // served from.
        doc = await pdfjs.getDocument({
          url: pdfUrl,
          cMapUrl,
          cMapPacked: true,
        }).promise;
        if (my !== renderTask.current) { try { doc.destroy(); } catch { /* noop */ } return; }
        const width = Math.max(320, scroller.clientWidth - 36) * layoutZoom;
        const frag = document.createDocumentFragment();
        const info: typeof pageInfo.current = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          if (my !== renderTask.current) return;
          const base = page.getViewport({ scale: 1 });
          const scale = width / base.width;
          const canvas = document.createElement('canvas');
          canvas.className = 'pdf-page';
          canvas.dataset.page = String(i);
          canvas.dataset.w = String(Math.floor(base.width * scale));
          canvas.dataset.h = String(Math.floor(base.height * scale));
          canvas.style.width = `${canvas.dataset.w}px`;
          canvas.style.height = `${canvas.dataset.h}px`;
          canvas.style.background = '#fff';
          // Cite-link hotspots live in a sibling overlay, not the canvas (a
          // canvas has no children). It's positioned over the canvas box; its
          // hotspots use percentages so a zoom stretch keeps them aligned.
          const layer = document.createElement('div');
          layer.className = 'pdf-cite-layer';
          frag.appendChild(canvas);
          frag.appendChild(layer);
          info.push({ el: canvas, scale, height: base.height, anno: layer });
          states.set(i, 'blank');
        }
        if (my !== renderTask.current) return;
        container.replaceChildren(frag);
        pageInfo.current = info;
        scroller.scrollTop = prevScroll;
        for (const it of info) positionLayer(it);

        // First visible page rasterizes before the spinner goes away — no
        // flash of blank paper on open.
        rasterize(1);
        await chain;
        if (my !== renderTask.current) return;
        setRendered(true);
        measurePage();

        observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            const i = Number((entry.target as HTMLElement).dataset.page);
            if (!i) continue;
            if (entry.isIntersecting) rasterize(i);
            else release(i);
          }
        }, { root: scroller, rootMargin: '150% 0px' });
        for (const { el } of info) observer.observe(el);
      } catch (err) {
        // a superseded render (fast retyping) cancels itself — that's expected, not an error
        if ((err as { name?: string })?.name !== 'RenderingCancelledException') console.error('[pdf] render failed', err);
      }
    })();
    // Invalidate any in-flight render (so its guarded loop bails before touching
    // the DOM/state) and release the pdf.js document — each compile is a unique
    // URL, so without this the worker's document memory accretes every typeset.
    return () => {
      renderTask.current++;
      observer?.disconnect();
      Promise.resolve(doc).then((d) => { try { d?.destroy(); } catch { /* already gone */ } });
    };
  }, [pdfUrl, layoutZoom, widthTick, refitTick, measurePage, positionLayer, hideCitePop]);

  const handleDblClick = (e: React.MouseEvent) => {
    if (!onInverse) return;
    // closest() instead of an instanceof check: works whatever element ends up
    // on top (canvas, flash overlay remnants, future wrappers).
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-page]');
    if (!target?.dataset.page) return;
    const idx = Number(target.dataset.page) - 1;
    const info = pageInfo.current[idx];
    if (!info) return;
    const rect = target.getBoundingClientRect();
    const x = (e.clientX - rect.left) / info.scale;
    const y = (e.clientY - rect.top) / info.scale;
    onInverse(idx + 1, x, y);
  };

  // Cite hotspots are created imperatively inside the render effect, so their
  // hover/click is handled by delegation on the inner container rather than per
  // element. Hover opens after a short delay (matching the source hover); click
  // or keyboard focus pins it open until an outside click or Escape.
  const citeOf = (e: React.SyntheticEvent) => (e.target as HTMLElement).closest<HTMLElement>('.pdf-cite-link');
  const onCitePointerOver = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return; // touch uses click; hover would double-fire
    const hot = citeOf(e);
    if (!hot?.dataset.citeKey || popPinned.current) return;
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => showCitePop(hot, hot.dataset.citeKey!, false), 300);
  };
  const onCitePointerOut = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    const hot = citeOf(e);
    if (!hot || popPinned.current) return;
    // leaving for the popup itself shouldn't dismiss it
    const to = e.relatedTarget as Node | null;
    if (to && popRef.current?.contains(to)) return;
    window.clearTimeout(hoverTimer.current);
    hideCitePop();
  };
  const onCiteClick = (e: React.MouseEvent) => {
    const hot = citeOf(e);
    if (!hot?.dataset.citeKey) return;
    e.preventDefault(); // it's an <a> with no href; don't let it scroll/navigate
    window.clearTimeout(hoverTimer.current);
    // Always (re)pin rather than toggle: a mouse click focuses the <a> first,
    // and onCiteFocus already pins it — a toggle here would then close what the
    // same gesture just opened. Outside-click / Escape are the way to dismiss.
    showCitePop(hot, hot.dataset.citeKey, true);
  };
  const onCiteFocus = (e: React.FocusEvent) => {
    const hot = citeOf(e);
    if (hot?.dataset.citeKey) showCitePop(hot, hot.dataset.citeKey, true);
  };

  // Dismiss a pinned popup on an outside click or Escape (hover popups close on
  // pointer-out). Scrolling the pane keeps the popup anchored via reposition.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if ((t as HTMLElement)?.closest?.('.pdf-cite-link')) return; // the click handler decides
      hideCitePop();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hideCitePop(); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [hideCitePop]);

  // Keep a pinned popup glued to its hotspot while the pane scrolls.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const onScroll = () => {
      const a = popAnchor.current;
      if (a?.isConnected && a.dataset.citeKey) showCitePop(a, a.dataset.citeKey, popPinned.current);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [showCitePop]);

  return (
    <div className="pdf-pane" ref={scrollRef} data-testid="pdf-pane">
      {stale && rendered && (
        <div className="pdf-stale" data-testid="pdf-stale">Preview is from the last successful typeset</div>
      )}
      <div
        className="pdf-pane__inner"
        ref={innerRef}
        onDoubleClick={handleDblClick}
        onPointerOver={onCitePointerOver}
        onPointerOut={onCitePointerOut}
        onClick={onCiteClick}
        onFocus={onCiteFocus}
        title={onInverse ? 'Double-click to jump to source' : undefined}
      />
      {!rendered && (
        <div className="pdf-empty">
          {status === 'compiling' ? (
            <><span className="spinner" /><p>Typesetting your document…</p></>
          ) : status === 'error' ? (
            // Only blame the document when there are errors to fix — a failed
            // run without parsed errors (missing root, server trouble) isn't
            // the user's LaTeX.
            <p>{hasErrors ? 'Fix the errors on the left, then typeset again.' : 'Typesetting didn’t finish — open the log for details.'}</p>
          ) : ready && !hasTex ? (
            <p data-testid="pdf-empty-no-tex">Create a .tex file to typeset and preview.</p>
          ) : (
            <p>Press <span className="kbd">{typesetKeys}</span> to typeset and preview.</p>
          )}
        </div>
      )}
    </div>
  );
});

export default PdfPane;
