import { useColorMode } from '../context/ColorMode';

export default function Background() {
  const { mode } = useColorMode();
  const dark = mode === 'dark';

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: -1,
        overflow: 'hidden',
        background: dark ? '#08080a' : '#f0f0f2',
        transition: 'background 500ms',
      }}
    >
      {/* Main liquid swirl — conic gradient with heavy blur */}
      <div
        style={{
          position: 'absolute',
          inset: '-30%',
          animation: 'bgs-spin 70s linear infinite',
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            borderRadius: '38% 62% 45% 55% / 52% 40% 60% 48%',
            background: dark
              ? `conic-gradient(from 0deg at 50% 50%,
                  rgba(25,70,60,0.25) 0deg,
                  rgba(40,50,90,0.18) 90deg,
                  rgba(20,60,50,0.22) 180deg,
                  rgba(35,45,70,0.15) 270deg,
                  rgba(25,70,60,0.25) 360deg)`
              : `conic-gradient(from 0deg at 50% 50%,
                  rgba(200,205,225,0.35) 0deg,
                  rgba(215,200,210,0.25) 90deg,
                  rgba(195,210,220,0.30) 180deg,
                  rgba(220,205,215,0.20) 270deg,
                  rgba(200,205,225,0.35) 360deg)`,
            filter: 'blur(70px)',
            animation: 'bgs-morph 24s ease-in-out infinite alternate',
          }}
        />
      </div>

      {/* Secondary swirl — opposite rotation, different shape */}
      <div
        style={{
          position: 'absolute',
          inset: '-20%',
          animation: 'bgs-spin-rev 90s linear infinite',
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            borderRadius: '42% 58% 52% 48% / 48% 55% 45% 52%',
            background: dark
              ? `conic-gradient(from 180deg at 50% 50%,
                  rgba(18,45,80,0.12) 0deg,
                  rgba(15,55,45,0.10) 90deg,
                  rgba(25,35,60,0.08) 180deg,
                  rgba(12,50,40,0.12) 270deg,
                  rgba(18,45,80,0.12) 360deg)`
              : `conic-gradient(from 180deg at 50% 50%,
                  rgba(230,220,225,0.20) 0deg,
                  rgba(215,225,235,0.15) 90deg,
                  rgba(225,215,220,0.12) 180deg,
                  rgba(210,225,230,0.18) 270deg,
                  rgba(230,220,225,0.20) 360deg)`,
            filter: 'blur(80px)',
            animation: 'bgs-morph-alt 30s ease-in-out infinite alternate',
          }}
        />
      </div>

      {/* Vignette */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: dark
            ? 'radial-gradient(ellipse 80% 80% at 50% 50%, transparent 25%, rgba(6,6,8,0.50) 100%)'
            : 'radial-gradient(ellipse 80% 80% at 50% 50%, transparent 25%, rgba(240,240,242,0.50) 100%)',
        }}
      />
    </div>
  );
}
