import { useEffect } from 'react';

export default function DiagramOverlay({ svg, onClose }: { svg: string; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 999999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.65)',
        backdropFilter: 'blur(24px) saturate(140%)',
        WebkitBackdropFilter: 'blur(24px) saturate(140%)',
        padding: '5vh 5vw',
        cursor: 'zoom-out',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="diagram-overlay-box"
        style={{
          width: '100%', height: '100%',
          maxWidth: '95vw', maxHeight: '90vh',
          overflow: 'auto',
          background: 'var(--athena-bg)',
          borderRadius: 16,
          padding: 24,
          boxShadow: '0 32px 80px rgba(0,0,0,0.5)',
          cursor: 'default',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}
