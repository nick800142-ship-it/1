type MapEmbedProps = {
  src: string;
  title: string;
  className?: string;
};

export function MapEmbed({ src, title, className = "" }: MapEmbedProps) {
  return (
    <div className={`relative overflow-hidden bg-slate-900 ${className}`}>
      <iframe
        src={src}
        title={title}
        loading="lazy"
        allowFullScreen
        referrerPolicy="no-referrer-when-downgrade"
        className="absolute inset-0 size-full border-0"
      />
    </div>
  );
}
