import { useRef, useEffect } from 'react';
import { useColorMode } from '../context/ColorMode';

function lerp(start: number, end: number, t: number) {
  return start + (end - start) * t;
}

function parseColor(s: string) {
  if (s.startsWith('#')) {
    const c = s.replace('#', '');
    return {
      r: parseInt(c.substring(0, 2), 16),
      g: parseInt(c.substring(2, 4), 16),
      b: parseInt(c.substring(4, 6), 16),
    };
  }
  const m = s.match(/rgb\((\d+),(\d+),(\d+)\)/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3] };
  return { r: 0, g: 0, b: 0 };
}

function lerpColor(c1: string, c2: string, t: number) {
  const a = parseColor(c1);
  const b = parseColor(c2);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const b2 = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r},${g},${b2})`;
}

const PALETTE_A_LIGHT = { bg: '#f0f0f2', dark: '#b8c4d4', light: '#d8dce8' };
const PALETTE_A_DARK = { bg: '#08080a', dark: '#1a2830', light: '#2a3848' };
const PALETTE_B_LIGHT = { bg: '#f0e6ec', dark: '#d4bcc8', light: '#e4ccd8' };
const PALETTE_B_DARK = { bg: '#0a0e1a', dark: '#1e3058', light: '#385880' };

export interface LiquidBackgroundHandle {
  setActive: (active: boolean) => void;
}

interface LiquidBackgroundProps {
  triggerRef?: React.MutableRefObject<LiquidBackgroundHandle | null>;
}

export default function LiquidBackground({ triggerRef }: LiquidBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { mode } = useColorMode();
  const dark = mode === 'dark';

  const stateRef = useRef({
    activeMode: 'A',
    progress: 0,
    time: 0,
    w: 0,
    h: 0,
  });

  const animRef = useRef<number>(0);
  const darkRef = useRef(dark);
  /* Rendered palette — lerps toward target on theme switch */
  const palRef = useRef({
    bg: { r: 240, g: 240, b: 242 },
    darkCol: { r: 184, g: 196, b: 212 },
    lightCol: { r: 216, g: 220, b: 232 },
    transition: 0,
  });

  darkRef.current = dark;

  if (triggerRef) {
    triggerRef.current = {
      setActive: (active: boolean) => {
        stateRef.current.activeMode = active ? 'B' : 'A';
      },
    };
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      stateRef.current.w = window.innerWidth;
      stateRef.current.h = window.innerHeight;
      canvas!.width = stateRef.current.w * dpr;
      canvas!.height = stateRef.current.h * dpr;
      ctx.scale(dpr, dpr);
    }
    resize();
    window.addEventListener('resize', resize);

    function pickPalA() { return darkRef.current ? PALETTE_A_DARK : PALETTE_A_LIGHT; }
    function pickPalB() { return darkRef.current ? PALETTE_B_DARK : PALETTE_B_LIGHT; }

    function getOffset(phase: number, ampMul = 1) {
      const s = stateRef.current;
      const amp = lerp(14, 22, s.progress) * ampMul;
      const freq = lerp(0.8, 0.95, s.progress);
      const t = s.time * freq;
      const pw = Math.sin(t + phase);
      const sw = Math.sin(t * 1.6 + phase * 1.2) * 0.25;
      const tw = Math.cos(t * 0.7 - phase * 0.5) * 0.15;
      return (pw + sw + tw) * amp;
    }

    function getCosOffset(phase: number, ampMul = 1) {
      const s = stateRef.current;
      const amp = lerp(14, 22, s.progress) * ampMul;
      const freq = lerp(0.8, 0.95, s.progress);
      const t = s.time * freq;
      const pw = Math.cos(t + phase);
      const sw = Math.cos(t * 1.4 + phase * 1.1) * 0.25;
      const tw = Math.sin(t * 0.8 - phase * 0.6) * 0.15;
      return (pw + sw + tw) * amp;
    }

    function render() {
      const s = stateRef.current;
      s.time += 0.015 * 0.8;

      const target = s.activeMode === 'B' ? 1 : 0;
      const diff = target - s.progress;
      if (Math.abs(diff) > 0.001) {
        s.progress += diff * 0.03;
      } else {
        s.progress = target;
      }

      const t = s.progress;
      const w = s.w;
      const h = s.h;

      const peakBlur = 12;
      const baseBlurB = 3;
      const transBlur = Math.sin(t * Math.PI) * peakBlur;
      const staticBlur = t * baseBlurB;
      const totalBlur = transBlur + staticBlur;
      canvas!.style.filter = totalBlur > 0.1 ? `blur(${totalBlur}px)` : 'none';

      /* Smooth palette transition on theme switch */
      const p = palRef.current;
      const tgtPalA = pickPalA();
      const tgtPalB = pickPalB();
      const tgtBgA = parseColor(tgtPalA.bg);
      const tgtBgB = parseColor(tgtPalB.bg);
      const tgtDarkA = parseColor(tgtPalA.dark);
      const tgtDarkB = parseColor(tgtPalB.dark);
      const tgtLightA = parseColor(tgtPalA.light);
      const tgtLightB = parseColor(tgtPalB.light);

      if (p.bg.r !== tgtBgA.r || p.bg.g !== tgtBgA.g || p.bg.b !== tgtBgA.b) {
        p.transition = Math.min(p.transition + 0.02, 1);
        const ease = 1 - Math.pow(1 - p.transition, 3);
        p.bg.r = Math.round(p.bg.r + (tgtBgA.r - p.bg.r) * ease);
        p.bg.g = Math.round(p.bg.g + (tgtBgA.g - p.bg.g) * ease);
        p.bg.b = Math.round(p.bg.b + (tgtBgA.b - p.bg.b) * ease);
        p.darkCol.r = Math.round(p.darkCol.r + (tgtDarkA.r - p.darkCol.r) * ease);
        p.darkCol.g = Math.round(p.darkCol.g + (tgtDarkA.g - p.darkCol.g) * ease);
        p.darkCol.b = Math.round(p.darkCol.b + (tgtDarkA.b - p.darkCol.b) * ease);
        p.lightCol.r = Math.round(p.lightCol.r + (tgtLightA.r - p.lightCol.r) * ease);
        p.lightCol.g = Math.round(p.lightCol.g + (tgtLightA.g - p.lightCol.g) * ease);
        p.lightCol.b = Math.round(p.lightCol.b + (tgtLightA.b - p.lightCol.b) * ease);
        if (p.transition >= 1) {
          p.bg = tgtBgA; p.darkCol = tgtDarkA; p.lightCol = tgtLightA;
          p.transition = 0;
        }
      }

      const bgA = `rgb(${p.bg.r},${p.bg.g},${p.bg.b})`;
      const bgB = `rgb(${tgtBgB.r},${tgtBgB.g},${tgtBgB.b})`;
      const darkA = `rgb(${p.darkCol.r},${p.darkCol.g},${p.darkCol.b})`;
      const darkB = `rgb(${tgtDarkB.r},${tgtDarkB.g},${tgtDarkB.b})`;
      const lightA = `rgb(${p.lightCol.r},${p.lightCol.g},${p.lightCol.b})`;
      const lightB = `rgb(${tgtLightB.r},${tgtLightB.g},${tgtLightB.b})`;

      const bg = lerpColor(bgA, bgB, t);
      const darkCol = lerpColor(darkA, darkB, t);
      const lightCol = lerpColor(lightA, lightB, t);

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // Light waves
      ctx.fillStyle = lightCol;

      ctx.beginPath();
      ctx.moveTo(0, h * 0.20 + getOffset(0));
      ctx.bezierCurveTo(w * 0.15 + getCosOffset(1), h * 0.25 + getOffset(1), w * 0.13 + getCosOffset(2), h * 0.65 + getOffset(2), 0, h * 0.76 + getOffset(3));
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(w * 0.05 + getCosOffset(4), 0);
      ctx.bezierCurveTo(w * 0.15 + getCosOffset(5), h * 0.20 + getOffset(5), w * 0.30 + getCosOffset(6), h * 0.18 + getOffset(6), w * 0.35 + getCosOffset(7), 0);
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(w * 0.67 + getCosOffset(19), 0);
      ctx.bezierCurveTo(w * 0.72 + getCosOffset(20), h * 0.10 + getOffset(20), w * 0.83 + getCosOffset(21), h * 0.18 + getOffset(21), w, h * 0.04 + getOffset(22));
      ctx.lineTo(w, 0);
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(w, h * 0.25 + getOffset(23));
      ctx.bezierCurveTo(w * 0.88 + getCosOffset(24), h * 0.32 + getOffset(24), w * 0.89 + getCosOffset(25), h * 0.58 + getOffset(25), w, h * 0.66 + getOffset(26));
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(w * 0.69 + getCosOffset(27), h);
      ctx.bezierCurveTo(w * 0.71 + getCosOffset(28), h * 0.83 + getOffset(28), w * 0.80 + getCosOffset(29), h * 0.83 + getOffset(29), w * 0.81 + getCosOffset(30), h);
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(w * 0.31 + getCosOffset(31), h);
      ctx.bezierCurveTo(w * 0.36 + getCosOffset(32), h * 0.91 + getOffset(32), w * 0.48 + getCosOffset(33), h * 0.81 + getOffset(33), w * 0.54 + getCosOffset(34), h);
      ctx.closePath();
      ctx.fill();

      // Dark waves
      ctx.fillStyle = darkCol;

      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, h * 0.24 + getOffset(8));
      ctx.bezierCurveTo(w * 0.15 + getCosOffset(9), h * 0.27 + getOffset(9), w * 0.25 + getCosOffset(10), h * 0.18 + getOffset(10), w * 0.235 + getCosOffset(11), h * 0.12 + getOffset(11));
      ctx.bezierCurveTo(w * 0.22 + getCosOffset(12), h * 0.04 + getOffset(12), w * 0.12 + getCosOffset(13), 0, w * 0.06 + getCosOffset(14), 0);
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(w * 0.44 + getCosOffset(15), 0);
      ctx.bezierCurveTo(w * 0.48 + getCosOffset(16), h * 0.22 + getOffset(16), w * 0.63 + getCosOffset(17), h * 0.22 + getOffset(17), w * 0.68 + getCosOffset(18), 0);
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(0, h * 0.81 + getOffset(35));
      ctx.bezierCurveTo(w * 0.13 + getCosOffset(36), h * 0.68 + getOffset(36), w * 0.25 + getCosOffset(37), h * 0.74 + getOffset(37), w * 0.32 + getCosOffset(38), h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(w, h * 0.55 + getOffset(39));
      ctx.bezierCurveTo(w * 0.74 + getCosOffset(40), h * 0.60 + getOffset(40), w * 0.75 + getCosOffset(41), h * 0.85 + getOffset(41), w * 0.79 + getCosOffset(42), h);
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();

      // Dots & decor
      const szMul = lerp(1, 1.25, t);
      const dotR = Math.min(w, h);

      drawCircle(ctx, w * 0.235 + getCosOffset(43, 0.4), h * 0.33 + getOffset(43, 0.4), dotR * 0.016 * szMul, darkCol, true);
      drawCircle(ctx, w * 0.63 + getCosOffset(44, 0.4), h * 0.88 + getOffset(44, 0.4), dotR * 0.024 * szMul, darkCol, true);
      drawCircle(ctx, w * 0.865 + getCosOffset(45, 0.4), h * 0.11 + getOffset(45, 0.4), dotR * 0.008 * szMul, darkCol, true);

      const strokeW = lerp(1.5, 2.5, t);
      drawCircle(ctx, w * 0.40 + getCosOffset(46, 0.5), h * 0.09 + getOffset(46, 0.5), dotR * 0.015 * szMul, darkCol, false, strokeW);
      drawCircle(ctx, w * 0.145 + getCosOffset(47, 0.5), h * 0.645 + getOffset(47, 0.5), dotR * 0.008 * szMul, darkCol, false, strokeW);
      drawCircle(ctx, w * 0.855 + getCosOffset(48, 0.5), h * 0.47 + getOffset(48, 0.5), dotR * 0.007 * szMul, darkCol, false, strokeW);

      const angle = lerp(0, Math.PI / 2, t) + s.time * 0.2;
      drawCross(ctx, w * 0.68 + getCosOffset(49, 0.3), h * 0.25 + getOffset(49, 0.3), dotR * 0.013 * szMul, angle, darkCol, strokeW);
      drawCross(ctx, w * 0.335 + getCosOffset(50, 0.3), h * 0.755 + getOffset(50, 0.3), dotR * 0.013 * szMul, -angle, darkCol, strokeW);

      drawDots(ctx, w * 0.025, h * 0.37, h * 0.61, 6, lerp(2.5, 3.5, t), darkCol);
      drawDots(ctx, w * 0.97, h * 0.12, h * 0.46, 6, lerp(2.5, 3.5, t), darkCol);
      drawCircle(ctx, w * 0.025, h * 0.715, lerp(2.5, 3.5, t), darkCol, true);

      animRef.current = requestAnimationFrame(render);
    }

    animRef.current = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: -1,
        display: 'block',
        transform: 'translateZ(0)',
      }}
    />
  );
}

function drawCircle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, filled: boolean, sw = 1) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (filled) {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = sw;
    ctx.stroke();
  }
}

function drawCross(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, angle: number, color: string, sw = 1.5) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.strokeStyle = color;
  ctx.lineWidth = sw;
  ctx.beginPath();
  ctx.moveTo(-s / 2, 0);
  ctx.lineTo(s / 2, 0);
  ctx.moveTo(0, -s / 2);
  ctx.lineTo(0, s / 2);
  ctx.stroke();
  ctx.restore();
}

function drawDots(ctx: CanvasRenderingContext2D, x: number, y1: number, y2: number, n: number, r: number, color: string) {
  const gap = (y2 - y1) / (n - 1);
  for (let i = 0; i < n; i++) {
    drawCircle(ctx, x, y1 + gap * i, r, color, true);
  }
}
