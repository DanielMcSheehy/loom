// Drag-to-resize for images in rendered markdown. The renderer emits
// `<span class="md-img" data-md-index=n><img …/><span class="md-img-handle"/></span>`
// as static HTML; this hook attaches delegated pointer handlers to the
// markdown container so no React tree has to live inside innerHTML.
//
// Drag the corner handle → width follows the pointer (aspect ratio kept,
// clamped to the container width); release → `onResize(index, width, src)`;
// double-click the handle → `onResize(index, null, src)` (natural size).
import { useEffect, type RefObject } from "react";
import "./images.css";

export const MIN_IMAGE_WIDTH = 40;

export type ImageResizeHandler = (index: number, width: number | null, src: string) => void;

function wrapperOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(".md-img") : null;
}

export function useImageResize(ref: RefObject<HTMLElement>, onResize?: ImageResizeHandler) {
  useEffect(() => {
    const root = ref.current;
    if (!root || !onResize) return;

    // Broken images show their alt text in a dashed box instead of a bare icon.
    const markBroken = (e: Event) => {
      wrapperOf(e.target)?.classList.add("md-img-broken");
    };
    root.addEventListener("error", markBroken, true);

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const handle = (e.target as Element | null)?.closest?.(".md-img-handle");
      const wrap = wrapperOf(e.target);
      const img = wrap?.querySelector("img");
      if (!handle || !wrap || !img) return;
      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const startW = img.getBoundingClientRect().width;
      const ratio = img.naturalWidth && img.naturalHeight ? img.naturalHeight / img.naturalWidth : img.getBoundingClientRect().height / Math.max(1, startW);
      const maxW = Math.max(MIN_IMAGE_WIDTH, Math.floor(root.getBoundingClientRect().width));
      const badge = wrap.querySelector<HTMLElement>(".md-img-size");
      let width = Math.round(startW);
      const show = () => {
        img.style.width = `${width}px`;
        img.style.height = "auto";
        if (badge) badge.textContent = `${width} × ${Math.round(width * ratio)}`;
      };
      wrap.classList.add("md-img-resizing");
      show();

      const onMove = (ev: PointerEvent) => {
        width = Math.round(Math.min(maxW, Math.max(MIN_IMAGE_WIDTH, startW + (ev.clientX - startX))));
        show();
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        wrap.classList.remove("md-img-resizing");
        const index = Number(wrap.dataset.mdIndex ?? -1);
        if (index >= 0 && width !== Math.round(startW)) onResize(index, width, wrap.dataset.mdSrc ?? img.getAttribute("src") ?? "");
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };

    const onDblClick = (e: MouseEvent) => {
      const handle = (e.target as Element | null)?.closest?.(".md-img-handle");
      const wrap = wrapperOf(e.target);
      if (!handle || !wrap) return;
      e.preventDefault();
      e.stopPropagation(); // don't flip the cell into edit mode
      const index = Number(wrap.dataset.mdIndex ?? -1);
      const img = wrap.querySelector("img");
      if (img) {
        img.style.width = "";
        img.style.height = "";
      }
      if (index >= 0) onResize(index, null, wrap.dataset.mdSrc ?? "");
    };

    // Images are draggable by default; that fights the resize handle.
    const onDragStart = (e: DragEvent) => {
      if (wrapperOf(e.target)) e.preventDefault();
    };

    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("dblclick", onDblClick);
    root.addEventListener("dragstart", onDragStart);
    return () => {
      root.removeEventListener("error", markBroken, true);
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("dblclick", onDblClick);
      root.removeEventListener("dragstart", onDragStart);
    };
  }, [ref, onResize]);
}
