import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { inputStyle, selectStyle } from './SharedComponents';
import type { ModelReference } from './types';
import { PROVIDER_OPTIONS } from './types';

export function CustomSelect({
  value, options, placeholder, onChange, style,
}: {
  value: string;
  options: { value: string; label: string }[];
  placeholder?: string;
  onChange: (val: string) => void;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });

  const doClose = useCallback(() => {
    setClosing(true);
    setTimeout(() => { setClosing(false); setOpen(false); }, 100);
  }, []);

  const updatePosition = useCallback(() => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const panelHeight = Math.min(200, options.length * 30 + 10);
      const spaceBelow = window.innerHeight - r.bottom;
      const spaceAbove = r.top;
      const showAbove = spaceBelow < panelHeight && spaceAbove > spaceBelow;
      setPos({
        top: showAbove ? r.top - panelHeight - 4 : r.bottom + 4,
        left: r.left,
        width: r.width,
      });
    }
  }, [options.length]);

  useEffect(() => {
    if (!open || closing) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node) &&
          btnRef.current && !btnRef.current.contains(e.target as Node)) {
        doClose();
      }
    }
    function handleReposition() { updatePosition(); }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('scroll', handleReposition, { capture: true });
    window.addEventListener('resize', handleReposition);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('scroll', handleReposition, { capture: true });
      window.removeEventListener('resize', handleReposition);
    };
  }, [open, closing, doClose, updatePosition]);

  const handleOpen = () => {
    if (open) { doClose(); return; }
    updatePosition();
    setOpen(true);
  };

  const selectedOption = options.find(o => o.value === value);
  const displayLabel = selectedOption ? selectedOption.label : placeholder || value || 'Select option';

  return (
    <>
      <button ref={btnRef} onClick={handleOpen} style={{
        ...selectStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 6, cursor: 'pointer', textAlign: 'left', width: '100%', ...style,
      }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {displayLabel}
        </span>
        <span style={{ opacity: 0.5, flexShrink: 0 }}>▼</span>
      </button>

      {(open || closing) && createPortal(
        <div ref={panelRef} style={{
          position: 'fixed', top: pos.top, left: pos.left, width: pos.width,
          maxHeight: 200, overflowY: 'auto', padding: 4, borderRadius: 8,
          background: 'var(--glass-bg-strong)',
          backdropFilter: 'var(--blur-glass-strong)',
          WebkitBackdropFilter: 'var(--blur-glass-strong)',
          border: '0.5px solid var(--athena-border)',
          boxShadow: 'var(--glass-shadow)', zIndex: 99999,
          animation: closing ? 'scale-out 100ms var(--ease-out) both' : 'scale-in 100ms var(--ease-out) both',
        }}>
          {options.map(opt => (
            <button key={opt.value} onClick={() => { onChange(opt.value); doClose(); }} style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 8px', border: 'none', borderRadius: 5,
              background: value === opt.value ? 'rgba(var(--athena-accent-rgb), 0.08)' : 'transparent',
              cursor: 'pointer', fontSize: 10.5,
              fontWeight: value === opt.value ? 600 : 500,
              color: value === opt.value ? 'var(--athena-text)' : 'var(--athena-text-2)',
              fontFamily: 'inherit', textAlign: 'left', transition: 'background 100ms',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
              onMouseEnter={e => { if (value !== opt.value) (e.currentTarget as HTMLElement).style.background = 'rgba(var(--athena-accent-rgb), 0.04)'; }}
              onMouseLeave={e => { if (value !== opt.value) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
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

export function ModelReferenceRow({
  label, value, onChange, onRemove, providers,
}: {
  label: string;
  value: ModelReference;
  onChange: (value: ModelReference) => void;
  onRemove?: () => void;
  providers: Record<string, { enabled: boolean; models: string[]; label: string }>;
}) {
  const allModels = React.useMemo(() => {
    if (value.providerId) return providers[value.providerId]?.models || [];
    return Object.values(providers).filter(p => p.enabled).flatMap(p => p.models);
  }, [value.providerId, providers]);

  const hasModels = allModels.length > 0;
  const providerOptions = React.useMemo(() => [
    { value: '', label: 'Any provider' },
    ...PROVIDER_OPTIONS,
  ], []);

  const modelOptions = React.useMemo(() => [
    { value: '', label: 'Select a model' },
    ...allModels.map(m => ({ value: m, label: m })),
    ...(value.model && !allModels.includes(value.model) ? [{ value: value.model, label: `${value.model} (custom)` }] : []),
  ], [allModels, value.model]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '76px 120px minmax(0, 1fr) auto', gap: 6, alignItems: 'center' }}>
      <span style={{ fontSize: 9.5, color: 'var(--athena-text-3)' }}>{label}</span>
      <CustomSelect value={value.providerId} options={providerOptions} placeholder="Any provider"
        onChange={nextProvider => onChange({ ...value, providerId: nextProvider })} />
      {hasModels ? (
        <CustomSelect value={value.model} options={modelOptions} placeholder="Select a model"
          onChange={nextModel => onChange({ ...value, model: nextModel })} />
      ) : (
        <input value={value.model} onChange={e => onChange({ ...value, model: e.target.value })}
          placeholder="model name" style={inputStyle} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {onRemove && (
          <button onClick={onRemove} style={{ width: 20, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: '0.5px solid var(--athena-border)', background: 'rgba(var(--athena-accent-rgb), 0.03)', color: 'var(--athena-text-3)', cursor: 'pointer', opacity: 1 }}>
            <span>✕</span>
          </button>
        )}
      </div>
    </div>
  );
}

export function ModelRouteEditor({
  route, providers, onChange, onAddFallback, onRemoveFallback,
}: {
  route: { primary: ModelReference; fallback: ModelReference[] };
  providers: Record<string, { enabled: boolean; models: string[]; label: string }>;
  onChange: (route: { primary: ModelReference; fallback: ModelReference[] }) => void;
  onAddFallback: () => void;
  onRemoveFallback: (idx: number) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <ModelReferenceRow label="Primary" value={route.primary} providers={providers}
        onChange={next => onChange({ ...route, primary: next })} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
        <span style={{ fontSize: 9.5, color: 'var(--athena-text-3)' }}>Fallbacks</span>
        <button onClick={onAddFallback} style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--athena-accent)', fontSize: 9.5, padding: '2px 0', fontFamily: 'inherit',
        }}>
          <span>+</span> Add fallback
        </button>
      </div>
      {route.fallback.length === 0 ? (
        <div style={{ fontSize: 9.5, color: 'var(--athena-text-3)', padding: '2px 0 0' }}>
          No fallback configured
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {route.fallback.map((item, idx) => (
            <ModelReferenceRow key={`${item.providerId}-${item.model}-${idx}`} label={`Fallback ${idx + 1}`}
              value={item} providers={providers}
              onChange={next => {
                const fallback = route.fallback.map((current, i) => (i === idx ? next : current));
                onChange({ ...route, fallback });
              }}
              onRemove={() => onRemoveFallback(idx)} />
          ))}
        </div>
      )}
    </div>
  );
}
