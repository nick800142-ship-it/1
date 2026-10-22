import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2, MapPin, X } from "lucide-react";
import { MapEmbed } from "@/components/MapEmbed";
import { isMapEmbedUrl } from "@/lib/mapEmbed";

type GalleryProps = {
  images: string[];
  assetName: string;
  compact?: boolean;
};

export function AssetImageGallery({ images, assetName, compact = false }: GalleryProps) {
  const safeImages = images.filter(Boolean);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const closeLightbox = useCallback(() => setActiveIndex(null), []);

  if (!safeImages.length) return null;

  return (
    <>
      <div className={compact ? "flex gap-3 overflow-x-auto pb-1" : "grid gap-3 sm:grid-cols-2"}>
        {safeImages.map((image, index) => isMapEmbedUrl(image) ? (
          <div
            key={`${image}-${index}`}
            className={compact ? "relative h-32 w-52 shrink-0 overflow-hidden rounded-xl" : `relative overflow-hidden rounded-2xl ${index === 0 ? "sm:col-span-2" : ""}`}
          >
            <MapEmbed src={image} title={`${assetName} 地圖`} className={compact ? "size-full" : index === 0 ? "h-64" : "h-36"} />
            <button
              type="button"
              onClick={() => setActiveIndex(index)}
              className="absolute right-2 top-2 rounded-lg bg-slate-950/80 p-2 text-white backdrop-blur hover:bg-slate-800"
              aria-label={`放大查看 ${assetName} 地圖`}
            >
              <Maximize2 className="size-4" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <button
            key={`${image}-${index}`}
            type="button"
            onClick={() => setActiveIndex(index)}
            className={compact ? "group relative h-32 w-52 shrink-0 overflow-hidden rounded-xl" : `group relative overflow-hidden rounded-2xl ${index === 0 ? "sm:col-span-2" : ""}`}
            aria-label={`放大查看 ${assetName} 第 ${index + 1} 張圖片`}
          >
            <img
              src={image}
              alt={`${assetName} ${index + 1}`}
              className={compact ? "size-full object-cover transition duration-300 group-hover:scale-105" : `w-full object-cover transition duration-300 group-hover:scale-105 ${index === 0 ? "h-64" : "h-36"}`}
            />
            <span className="absolute bottom-2 right-2 rounded-lg bg-slate-950/75 p-2 text-white opacity-0 backdrop-blur transition group-hover:opacity-100 group-focus-visible:opacity-100">
              <Maximize2 className="size-4" aria-hidden="true" />
            </span>
          </button>
        ))}
      </div>
      <ImageLightbox
        images={safeImages}
        assetName={assetName}
        activeIndex={activeIndex}
        onClose={closeLightbox}
        onIndexChange={setActiveIndex}
      />
    </>
  );
}

export function ClickableAssetImage({ images, assetName, className, initialIndex = 0 }: { images: string[]; assetName: string; className: string; initialIndex?: number }) {
  const safeImages = images.filter(Boolean);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const closeLightbox = useCallback(() => setActiveIndex(null), []);
  if (!safeImages.length) return null;
  const displayed = safeImages[initialIndex] ?? safeImages[0];
  const displayedIsMap = isMapEmbedUrl(displayed);
  return (
    <>
      {displayedIsMap ? (
        <div className="relative block w-full overflow-hidden">
          <MapEmbed src={displayed} title={`${assetName} 地圖`} className={className.replace(/\bobject-\w+\b/g, "")} />
          <button
            type="button"
            onClick={() => setActiveIndex(initialIndex)}
            className="absolute right-3 top-3 rounded-lg bg-slate-950/80 p-2 text-white backdrop-blur hover:bg-slate-800"
            aria-label={`放大查看 ${assetName} 地圖`}
          >
            <Maximize2 className="size-4" aria-hidden="true" />
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setActiveIndex(initialIndex)} className="group relative block w-full overflow-hidden" aria-label={`放大查看 ${assetName} 圖片`}>
          <img src={displayed} alt={assetName} className={`${className} transition duration-300 group-hover:scale-105`} />
          <span className="absolute bottom-3 right-3 rounded-lg bg-slate-950/75 p-2 text-white opacity-0 backdrop-blur transition group-hover:opacity-100 group-focus-visible:opacity-100">
            <Maximize2 className="size-4" aria-hidden="true" />
          </span>
        </button>
      )}
      <ImageLightbox images={safeImages} assetName={assetName} activeIndex={activeIndex} onClose={closeLightbox} onIndexChange={setActiveIndex} />
    </>
  );
}

function ImageLightbox({ images, assetName, activeIndex, onClose, onIndexChange }: { images: string[]; assetName: string; activeIndex: number | null; onClose: () => void; onIndexChange: (index: number) => void }) {
  const touchStart = useRef<number | null>(null);
  const previous = useCallback(
    () => onIndexChange(((activeIndex ?? 0) - 1 + images.length) % images.length),
    [activeIndex, images.length, onIndexChange],
  );
  const next = useCallback(
    () => onIndexChange(((activeIndex ?? 0) + 1) % images.length),
    [activeIndex, images.length, onIndexChange],
  );

  useEffect(() => {
    if (activeIndex === null) return;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") previous();
      if (event.key === "ArrowRight") next();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [activeIndex, images.length, onClose, previous, next]);

  if (activeIndex === null) return null;
  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-slate-950/95 p-3 backdrop-blur-md sm:p-6" role="dialog" aria-modal="true" aria-label={`${assetName} 圖片檢視器`} onMouseDown={onClose}>
      <div className="flex items-center justify-between gap-4 text-white">
        <p className="truncate text-sm font-semibold">{assetName} · {activeIndex + 1} / {images.length}</p>
        <button type="button" onClick={onClose} className="rounded-xl border border-slate-700 bg-slate-900 p-3 hover:bg-slate-800" aria-label="關閉圖片檢視器"><X className="size-5" /></button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center" onMouseDown={(event) => event.stopPropagation()} onTouchStart={(event) => { touchStart.current = event.touches[0]?.clientX ?? null; }} onTouchEnd={(event) => { if (touchStart.current === null || isMapEmbedUrl(images[activeIndex])) return; const delta = event.changedTouches[0].clientX - touchStart.current; if (Math.abs(delta) > 50) {
          if (delta > 0) previous();
          else next();
        } touchStart.current = null; }}>
        {isMapEmbedUrl(images[activeIndex])
          ? <MapEmbed src={images[activeIndex]} title={`${assetName} 地圖`} className="size-full rounded-xl" />
          : <img src={images[activeIndex]} alt={`${assetName} ${activeIndex + 1}`} className="max-h-full max-w-full object-contain" />}
        {images.length > 1 && <>
          <button type="button" onClick={previous} className="absolute left-1 rounded-full border border-slate-700 bg-slate-950/80 p-3 text-white hover:bg-slate-800 sm:left-4" aria-label="上一張圖片"><ChevronLeft className="size-6" /></button>
          <button type="button" onClick={next} className="absolute right-1 rounded-full border border-slate-700 bg-slate-950/80 p-3 text-white hover:bg-slate-800 sm:right-4" aria-label="下一張圖片"><ChevronRight className="size-6" /></button>
        </>}
      </div>
      {images.length > 1 && <div className="flex justify-center gap-2 overflow-x-auto pt-3" onMouseDown={(event) => event.stopPropagation()}>{images.map((image, index) => <button key={`${image}-thumb`} type="button" onClick={() => onIndexChange(index)} aria-label={`查看第 ${index + 1} 張圖片`} aria-current={index === activeIndex} className={`h-14 w-20 shrink-0 overflow-hidden rounded-lg border-2 ${index === activeIndex ? "border-amber-400" : "border-transparent opacity-60"}`}>{isMapEmbedUrl(image) ? <span className="flex size-full items-center justify-center bg-slate-800 text-sky-300"><MapPin className="size-5" aria-hidden="true" /></span> : <img src={image} alt="" className="size-full object-cover" />}</button>)}</div>}
    </div>
  );
}
