import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

interface ModeDropdownProps {
  value: 'instant' | 'deep';
  setDeepMode: (v: boolean) => void;
}

export default function ModeDropdown({ value, setDeepMode }: ModeDropdownProps) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const hoverRef = useRef(false);

  const doClose = useCallback(() => {
    setClosing(true);
    setTimeout(() => { setClosing(false); setOpen(false); }, 120);
  }, []);

  useEffect(() => {
    if (!open || closing) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node) &&
          btnRef.current && !btnRef.current.contains(e.target as Node)) {
        doClose();
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, closing, doClose]);

  const handleOpen = () => {
    if (open) { doClose(); return; }
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const panelHeight = 80; // estimated
      const spaceBelow = window.innerHeight - r.bottom;
      const spaceAbove = r.top;
      
      // Show above if not enough space below
      const showAbove = spaceBelow < panelHeight && spaceAbove > spaceBelow;
      
      setPos({ 
        top: showAbove ? r.top - panelHeight - 4 : r.bottom + 4, 
        right: window.innerWidth - r.right 
      });
    }
    setOpen(true);
  };

  const options = [
    { key: 'instant', label: 'Instant' },
    { key: 'deep', label: 'Deep' },
  ] as const;

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleOpen}
        style={{
          display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0,
          background: 'none', border: 'none',
          cursor: 'pointer', padding: '3px 4px', borderRadius: 6,
          color: value === 'deep' || open ? 'var(--athena-accent)' : 'var(--athena-text-2)',
          fontSize: 9.5, fontWeight: 600, fontFamily: 'inherit',
          transition: 'color 140ms var(--ease-out)',
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLElement).style.color = 'var(--athena-accent)';
          hoverRef.current = true;
        }}
        onMouseLeave={e => {
          if (!open) (e.currentTarget as HTMLElement).style.color = 'var(--athena-text-2)';
          hoverRef.current = false;
          setTimeout(() => { if (!hoverRef.current && open) doClose(); }, 200);
        }}
      >
        {value === 'instant' ? 'Instant' : 'Deep'}
        <ChevronDown size={9} style={{ opacity: 0.5 }} />
      </button>
      {(open || closing) && createPortal(
        <div
          ref={panelRef}
          onMouseEnter={() => { hoverRef.current = true; }}
          onMouseLeave={() => {
            hoverRef.current = false;
            setTimeout(() => { if (!hoverRef.current) doClose(); }, 200);
          }}
          style={{
            position: 'fixed', top: pos.top, right: pos.right,
            minWidth: 100, padding: 4, borderRadius: 8,
            background: 'var(--glass-bg-strong)',
            backdropFilter: 'var(--blur-glass-strong)',
            WebkitBackdropFilter: 'var(--blur-glass-strong)',
            boxShadow: 'var(--glass-shadow)',
            zIndex: 9999,
            animation: closing ? 'scale-out 100ms var(--ease-out) both' : 'scale-in 100ms var(--ease-out) both',
          }}
        >
          {options.map(opt => (
            <button
              key={opt.key}
              onClick={() => { setDeepMode(opt.key === 'deep'); doClose(); }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center',
                gap: 6, padding: '6px 10px', border: 'none', borderRadius: 6,
                background: value === opt.key ? 'rgba(var(--athena-accent-rgb), 0.08)' : 'none',
                cursor: 'pointer',
                fontSize: 10.5, fontWeight: value === opt.key ? 600 : 500,
                color: value === opt.key ? 'var(--athena-text)' : 'var(--athena-text-2)',
                fontFamily: 'inherit', textAlign: 'left',
                transition: 'background 100ms',
              }}
              onMouseEnter={e => { if (value !== opt.key) (e.currentTarget as HTMLElement).style.background = 'rgba(var(--athena-accent-rgb), 0.04)'; }}
              onMouseLeave={e => { if (value !== opt.key) (e.currentTarget as HTMLElement).style.background = 'none'; }}
            >
              {opt.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}
