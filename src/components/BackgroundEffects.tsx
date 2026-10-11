import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

type EffectSettings = { enabled: boolean; effect: "fireworks" | "sparkles" | "none"; color: string; intensity: number };
const fallback: EffectSettings = { enabled: false, effect: "fireworks", color: "#38bdf8", intensity: 0.65 };

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
  trail: Array<{ x: number; y: number }>;
};

type Rocket = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  targetY: number;
  life: number;
  trail: Array<{ x: number; y: number }>;
};

export function BackgroundEffects() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [settings, setSettings] = useState<EffectSettings>(fallback);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const { data } = await supabase.from("site_visual_effects").select("enabled,effect,color,intensity").eq("id", true).maybeSingle();
      if (active && data) setSettings(data as EffectSettings);
    };
    void load();
    const handler = () => void load();
    window.addEventListener("site-visual-effects-updated", handler);
    return () => { active = false; window.removeEventListener("site-visual-effects-updated", handler); };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !settings.enabled || settings.effect === "none" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let frame = 0;
    let last = 0;
    let stopped = false;
    const particles: Particle[] = [];
    const rockets: Rocket[] = [];
    const resize = () => { const ratio = window.devicePixelRatio || 1; canvas.width = innerWidth * ratio; canvas.height = innerHeight * ratio; canvas.style.width = `${innerWidth}px`; canvas.style.height = `${innerHeight}px`; context.setTransform(ratio, 0, 0, ratio, 0, 0); };
    const launch = () => {
      rockets.push({
        x: innerWidth * (0.12 + Math.random() * 0.76),
        y: innerHeight + 8,
        vx: (Math.random() - 0.5) * 0.35,
        vy: -(6.2 + Math.random() * 1.7 + settings.intensity * 1.5),
        targetY: innerHeight * (0.16 + Math.random() * 0.3),
        life: 1,
        trail: [],
      });
    };
    const burst = (x: number, y: number, baseVx: number, baseVy: number) => {
      const count = Math.round(46 + settings.intensity * 28);
      for (let i = 0; i < count; i += 1) {
        const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.08;
        const speed = 0.9 + Math.random() * (1.8 + settings.intensity * 1.1);
        particles.push({
          x, y,
          vx: Math.cos(angle) * speed + baseVx * 0.12,
          vy: Math.sin(angle) * speed + baseVy * 0.12,
          life: 1,
          size: 0.7 + Math.random() * 1.5,
          trail: [],
        });
      }
    };
    const tick = (time: number) => {
      if (stopped) return;
      if (time - last > 1350 / Math.max(0.35, settings.intensity)) {
        launch();
        last = time;
      }
      context.clearRect(0, 0, innerWidth, innerHeight);
      context.globalCompositeOperation = "lighter";
      for (let i = rockets.length - 1; i >= 0; i -= 1) {
        const rocket = rockets[i];
        rocket.trail.unshift({ x: rocket.x, y: rocket.y });
        if (rocket.trail.length > 12) rocket.trail.pop();
        rocket.x += rocket.vx;
        rocket.y += rocket.vy;
        rocket.vy += 0.055;
        rocket.life -= 0.006;
        for (let t = rocket.trail.length - 1; t > 0; t -= 1) {
          const from = rocket.trail[t];
          const to = rocket.trail[t - 1];
          context.globalAlpha = 0.2 * (1 - t / rocket.trail.length);
          context.strokeStyle = settings.color;
          context.lineWidth = 1.2;
          context.beginPath();
          context.moveTo(from.x, from.y);
          context.lineTo(to.x, to.y);
          context.stroke();
        }
        context.globalAlpha = 0.9;
        context.fillStyle = settings.color;
        context.beginPath();
        context.arc(rocket.x, rocket.y, 1.7, 0, Math.PI * 2);
        context.fill();
        if (rocket.y <= rocket.targetY || rocket.vy >= -0.3 || rocket.life <= 0) {
          burst(rocket.x, rocket.y, rocket.vx, rocket.vy);
          rockets.splice(i, 1);
        }
      }
      for (let i = particles.length - 1; i >= 0; i -= 1) {
        const p = particles[i];
        p.trail.unshift({ x: p.x, y: p.y });
        if (p.trail.length > 7) p.trail.pop();
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.992;
        p.vy = p.vy * 0.992 + 0.022;
        p.life -= 0.0095;
        if (p.life <= 0) {
          particles.splice(i, 1);
          continue;
        }

        context.lineCap = "round";
        for (let t = p.trail.length - 1; t > 0; t -= 1) {
          const from = p.trail[t];
          const to = p.trail[t - 1];
          context.globalAlpha = p.life * 0.12 * (1 - t / p.trail.length);
          context.strokeStyle = settings.color;
          context.lineWidth = Math.max(0.35, p.size * (1 - t / p.trail.length));
          context.beginPath();
          context.moveTo(from.x, from.y);
          context.lineTo(to.x, to.y);
          context.stroke();
        }
        context.globalAlpha = p.life * 0.82;
        context.fillStyle = settings.color;
        context.beginPath();
        context.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
      frame = requestAnimationFrame(tick);
    };
    resize();
    window.addEventListener("resize", resize);
    frame = requestAnimationFrame(tick);
    const stopTimer = window.setTimeout(() => {
      stopped = true;
      cancelAnimationFrame(frame);
      context.clearRect(0, 0, innerWidth, innerHeight);
    }, 30_000);
    return () => {
      stopped = true;
      window.clearTimeout(stopTimer);
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      context.clearRect(0, 0, innerWidth, innerHeight);
    };
  }, [settings]);

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none fixed inset-0 z-30 opacity-80" />;
}
