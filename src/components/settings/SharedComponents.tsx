import React from 'react';

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div className="font-mono" style={{
        fontSize: 9, fontWeight: 500, letterSpacing: '0.14em',
        textTransform: 'uppercase', color: 'var(--athena-text-3)', marginBottom: 10,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

export function InputRow({
  icon, label, value, onChange, placeholder,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {icon && <span style={{ flexShrink: 0, color: 'var(--athena-text-3)', display: 'flex' }}>{icon}</span>}
      <span style={{ flexShrink: 0, fontSize: 10.5, color: 'var(--athena-text-2)', width: 92 }}>
        {label}
      </span>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          flex: 1, minWidth: 0, padding: '6px 8px', borderRadius: 6, border: '0.5px solid var(--athena-border)',
          background: 'var(--glass-bg)', color: 'var(--athena-text)', fontSize: 10.5,
          fontFamily: 'inherit', outline: 'none',
        }}
      />
    </div>
  );
}

export function ListSection({
  icon, label, items, onAdd, onRemove, emptyText, maskItems = false,
}: {
  icon?: React.ReactNode;
  label: string;
  items: string[];
  onAdd: () => void;
  onRemove: (idx: number) => void;
  emptyText: string;
  maskItems?: boolean;
}) {
  const [collapsed, setCollapsed] = React.useState(true);
  const visibleItems = collapsed ? items.slice(0, 2) : items;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {icon && <span style={{ color: 'var(--athena-text-3)', display: 'flex' }}>{icon}</span>}
          <span style={{ fontSize: 10.5, color: 'var(--athena-text-2)' }}>
            {label} {items.length > 0 && <span style={{ color: 'var(--athena-text-3)' }}>({items.length})</span>}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {items.length > 2 && (
            <button onClick={() => setCollapsed(!collapsed)} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--athena-text-3)', fontSize: 9.5, padding: '2px 6px',
              borderRadius: 4, fontFamily: 'inherit',
            }}>
              {collapsed ? 'Show all' : 'Collapse'}
            </button>
          )}
          <button onClick={onAdd} style={{
            display: 'flex', alignItems: 'center', gap: 3,
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--athena-accent)', fontSize: 9.5, padding: '2px 6px',
            borderRadius: 4, fontFamily: 'inherit',
          }}>
            <span>+</span> Add
          </button>
        </div>
      </div>
      {items.length === 0 ? (
        <div style={{ fontSize: 10, color: 'var(--athena-text-3)', padding: '4px 0' }}>
          {emptyText}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginLeft: 18 }}>
          {visibleItems.map((item, idx) => {
            const display = maskItems ? maskSecret(item) : item;
            return (
              <div key={`${item}-${idx}`} style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '4px 6px', borderRadius: 5,
                background: 'rgba(var(--athena-accent-rgb), 0.03)',
                border: '0.5px solid var(--athena-border)',
              }}>
                <span style={{
                  flex: 1, minWidth: 0, fontSize: 9.5, fontFamily: '"JetBrains Mono", monospace',
                  color: 'var(--athena-text-2)', overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {display.length > 44 ? display.slice(0, 42) + '...' : display}
                </span>
                <button onClick={() => onRemove(idx)} style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--athena-text-3)', padding: 2, borderRadius: 3, display: 'flex',
                  flexShrink: 0,
                }}>
                  <span>✕</span>
                </button>
              </div>
            );
          })}
          {collapsed && items.length > 2 && (
            <div style={{ fontSize: 9, color: 'var(--athena-text-3)', padding: '2px 6px' }}>
              +{items.length - 2} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function maskSecret(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function InfoPanel({ icon, title, text }: { icon?: React.ReactNode; title: string; text: string }) {
  return (
    <div style={{
      display: 'flex', gap: 9,
      padding: '10px 12px', borderRadius: 10,
      border: '0.5px solid var(--athena-border)',
      background: 'rgba(var(--athena-accent-rgb), 0.035)',
      color: 'var(--athena-text-2)',
    }}>
      {icon && <span style={{ color: 'var(--athena-text-3)', display: 'flex', marginTop: 1 }}>{icon}</span>}
      <div>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--athena-text)', marginBottom: 3 }}>{title}</div>
        <div style={{ fontSize: 10, lineHeight: 1.55 }}>{text}</div>
      </div>
    </div>
  );
}

export function CapabilityGrid({ items }: { items: [string, string][] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
      {items.map(([title, detail]) => (
        <div key={title} style={{
          padding: '10px 11px', borderRadius: 10,
          border: '0.5px solid var(--athena-border)',
          background: 'rgba(var(--athena-accent-rgb), 0.025)',
        }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--athena-text)', marginBottom: 4 }}>
            {title}
          </div>
          <div style={{ fontSize: 9.5, lineHeight: 1.45, color: 'var(--athena-text-3)' }}>
            {detail}
          </div>
        </div>
      ))}
    </div>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export const inputStyle: React.CSSProperties = {
  minWidth: 0,
  padding: '6px 8px',
  borderRadius: 6,
  border: '0.5px solid var(--athena-border)',
  background: 'var(--glass-bg)',
  color: 'var(--athena-text)',
  fontSize: 10.5,
  fontFamily: 'inherit',
  outline: 'none',
};

// eslint-disable-next-line react-refresh/only-export-components
export const selectStyle: React.CSSProperties = {
  ...inputStyle,
  appearance: 'none',
};
