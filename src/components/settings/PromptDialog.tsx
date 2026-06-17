import { useEffect, useRef } from 'react';

export function PromptDialog({
  open, title, placeholder, isPassword, value, onChange, onClose, onSubmit,
}: {
  open: boolean;
  title: string;
  placeholder: string;
  isPassword?: boolean;
  value: string;
  onChange: (val: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') onSubmit();
    else if (e.key === 'Escape') onClose();
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 200,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)',
      WebkitBackdropFilter: 'blur(4px)',
      animation: 'fade-in 140ms var(--ease-out) both',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '90%', maxWidth: 400,
        background: 'var(--glass-bg)', border: '0.5px solid var(--athena-border)',
        borderRadius: 14, padding: '16px 18px',
        boxShadow: '0 20px 40px rgba(0, 0, 0, 0.35)',
        display: 'flex', flexDirection: 'column', gap: 12,
        animation: 'scale-in 180ms var(--ease-spring) both',
      }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--athena-text)' }}>{title}</div>
        <input ref={inputRef} type={isPassword ? 'password' : 'text'} value={value}
          onChange={e => onChange(e.target.value)} placeholder={placeholder}
          onKeyDown={handleKeyDown}
          style={{
            width: '100%', padding: '8px 10px', borderRadius: 8,
            border: '0.5px solid var(--athena-border)',
            background: 'rgba(var(--athena-accent-rgb), 0.02)',
            color: 'var(--athena-text)', fontSize: 11, outline: 'none',
          }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button onClick={onClose} style={{
            padding: '6px 12px', borderRadius: 6, border: '0.5px solid var(--athena-border)',
            background: 'transparent', color: 'var(--athena-text-2)',
            fontSize: 10.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
          }}>Cancel</button>
          <button onClick={onSubmit} disabled={!value.trim()} style={{
            padding: '6px 14px', borderRadius: 6,
            border: '0.5px solid rgba(var(--athena-accent-rgb), 0.35)',
            background: 'rgba(var(--athena-accent-rgb), 0.08)',
            color: 'var(--athena-text)', fontSize: 10.5, fontWeight: 700,
            cursor: 'pointer', fontFamily: 'inherit',
            opacity: value.trim() ? 1 : 0.5,
          }}>Add</button>
        </div>
      </div>
    </div>
  );
}
