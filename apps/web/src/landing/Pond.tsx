import { useEffect, useRef } from 'react';
import { prefersReducedMotion } from '../motion/scroll.ts';
import styles from './Landing.module.css';

interface Mote {
  x: number;
  y: number;
  phase: number;
  size: number;
  lit: boolean;
}
interface Ring {
  x: number;
  y: number;
  born: number;
  strength: number;
}

const RING_SPEED = 0.16; // px per ms
const RING_LIFE = 4200; // ms
const MAX_RINGS = 22;
const WAVE_WIDTH = 26;
const LEVELS = 6;

/**
 * Decorative pond: the pointer drops ripples that push drifting plankton outward. All work
 * happens in one canvas frame loop that stops off screen, in hidden tabs and under reduced
 * motion (which draws a single still frame instead).
 */
export function Pond() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvasRef.current;
    const pen = element?.getContext('2d');
    if (!element || !pen) return;
    // Typed bindings keep the guarded values non-null inside the hoisted helpers below.
    const canvas: HTMLCanvasElement = element;
    const context: CanvasRenderingContext2D = pen;
    const still = prefersReducedMotion();
    let width = 0,
      height = 0,
      motes: Mote[] = [],
      rings: Ring[] = [],
      frame: number | null = null,
      visible = true,
      lastDrop = 0,
      lastPointer = { x: -999, y: -999, at: 0 };
    const buckets: number[][] = Array.from({ length: LEVELS * 2 }, () => []);

    function seed() {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      const box = canvas.getBoundingClientRect();
      width = box.width;
      height = box.height;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const count = Math.min(240, Math.round((width * height) / 7000));
      // A fixed-step lattice with jitter spreads motes evenly without clumps.
      motes = Array.from({ length: count }, (_, index) => {
        const golden = index * 0.618034;
        return {
          x: (golden % 1) * width,
          y: ((index + 0.5) / count) * height,
          phase: (index * 2.399) % (Math.PI * 2),
          size: index % 9 === 0 ? 2.4 : 1.3,
          lit: index % 11 === 0,
        };
      });
    }

    function drop(x: number, y: number, strength: number, now: number) {
      rings.push({ x, y, born: now, strength });
      if (rings.length > MAX_RINGS) rings = rings.slice(-MAX_RINGS);
    }

    function draw(now: number) {
      context.clearRect(0, 0, width, height);
      rings = rings.filter((ring) => now - ring.born < RING_LIFE);
      context.lineWidth = 1;
      for (const ring of rings) {
        const age = now - ring.born,
          life = 1 - age / RING_LIFE,
          radius = age * RING_SPEED;
        for (let echo = 0; echo < 3; echo++) {
          const r = radius - echo * 22;
          if (r <= 0) continue;
          context.strokeStyle = `rgba(239, 232, 216, ${(0.28 * life * ring.strength) / (echo + 1)})`;
          context.beginPath();
          context.arc(ring.x, ring.y, r, 0, Math.PI * 2);
          context.stroke();
        }
      }
      const t = now / 1000;
      // Motes are grouped into a few brightness buckets so each frame sets a handful of fill
      // styles and issues one path per bucket, instead of restyling every mote.
      for (const bucket of buckets) bucket.length = 0;
      for (const mote of motes) {
        let x = mote.x + Math.sin(t * 0.3 + mote.phase) * 14,
          y = mote.y + Math.cos(t * 0.23 + mote.phase) * 10,
          lift = 0;
        for (const ring of rings) {
          const dx = x - ring.x,
            dy = y - ring.y,
            distance = Math.hypot(dx, dy) || 1,
            age = now - ring.born,
            offset = distance - age * RING_SPEED;
          if (Math.abs(offset) > WAVE_WIDTH * 3) continue;
          const wave =
            Math.exp(-(offset * offset) / (2 * WAVE_WIDTH * WAVE_WIDTH)) *
            (1 - age / RING_LIFE) *
            ring.strength;
          x += (dx / distance) * wave * 18;
          y += (dy / distance) * wave * 18;
          lift = Math.max(lift, wave);
        }
        const level = Math.min(LEVELS - 1, Math.floor(lift * LEVELS));
        const size = mote.size + lift * 2.2;
        buckets[(mote.lit ? LEVELS : 0) + level]?.push(x - size / 2, y - size / 2, size);
      }
      for (const [index, bucket] of buckets.entries()) {
        if (bucket.length === 0) continue;
        const lit = index >= LEVELS,
          level = (index % LEVELS) / (LEVELS - 1);
        context.fillStyle = lit
          ? `rgba(212, 242, 90, ${(0.55 + level * 0.45).toFixed(2)})`
          : `rgba(239, 232, 216, ${(0.16 + level * 0.6).toFixed(2)})`;
        context.beginPath();
        for (let at = 0; at < bucket.length; at += 3) {
          const size = bucket[at + 2] ?? 0;
          context.rect(bucket[at] ?? 0, bucket[at + 1] ?? 0, size, size);
        }
        context.fill();
      }
    }

    function loop(now: number) {
      frame = null;
      if (now - lastDrop > 2600) {
        lastDrop = now;
        drop(width * (0.15 + Math.random() * 0.7), height * (0.2 + Math.random() * 0.6), 0.7, now);
      }
      draw(now);
      if (visible && !document.hidden) frame = requestAnimationFrame(loop);
    }
    function start() {
      if (still || frame !== null || !visible || document.hidden) return;
      frame = requestAnimationFrame(loop);
    }
    function stop() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    }

    seed();
    if (still) {
      const now = performance.now();
      drop(width * 0.62, height * 0.48, 1, now - 1400);
      drop(width * 0.3, height * 0.7, 0.8, now - 2600);
      draw(now);
    }
    const host = canvas.parentElement ?? canvas;
    const pointer = (event: PointerEvent) => {
      const box = canvas.getBoundingClientRect(),
        x = event.clientX - box.left,
        y = event.clientY - box.top,
        now = performance.now();
      if (Math.hypot(x - lastPointer.x, y - lastPointer.y) < 70 || now - lastPointer.at < 90)
        return;
      lastPointer = { x, y, at: now };
      lastDrop = now;
      drop(x, y, 0.55, now);
    };
    const press = (event: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      drop(event.clientX - box.left, event.clientY - box.top, 1.3, performance.now());
    };
    const resize = () => {
      seed();
      if (still) draw(performance.now());
    };
    const visibility = () => {
      if (document.hidden) stop();
      else start();
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      if (visible) start();
      else stop();
    });
    observer.observe(canvas);
    if (!still) {
      host.addEventListener('pointermove', pointer, { passive: true });
      host.addEventListener('pointerdown', press, { passive: true });
    }
    window.addEventListener('resize', resize, { passive: true });
    document.addEventListener('visibilitychange', visibility);
    start();
    return () => {
      stop();
      observer.disconnect();
      host.removeEventListener('pointermove', pointer);
      host.removeEventListener('pointerdown', press);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  return <canvas ref={canvasRef} className={styles.pond} aria-hidden="true" />;
}
