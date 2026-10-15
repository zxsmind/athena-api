import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogModel } from '../lib/api';

/**
 * A model picker that behaves like a picker.
 *
 * This replaces a native `datalist` on a text input, which looked like a text
 * field and behaved like one: the suggestion list appeared only after typing,
 * could not be searched, and offered a few hundred bare ids with no way to see
 * which one a mode already used. The field is the one place an operator names a
 * model, and the catalog behind it is large enough that scrolling it by hand is
 * not an option — typing three letters is.
 *
 * What it deliberately does not do is decide for the operator. The list is
 * whatever the selected provider serves, and a model typed by hand is kept:
 * providers outside the catalog publish no model list at all, so refusing
 * anything not in this array would make them unconfigurable from here. An id
 * outside the list is marked instead of rejected.
 */
export interface ModelOption {
  id: string;
  label?: string;
  /** What the catalog knows about it, shown under the id. */
  detail?: string;
}

export function ModelCombobox({
  value,
  options,
  placeholder,
  disabled,
  label,
  emptyNote,
  onChange,
}: {
  value: string;
  options: ModelOption[];
  placeholder?: string;
  disabled?: boolean;
  label: string;
  /** Shown under the field when the value is not among the options. */
  emptyNote?: string;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => setQuery(value), [value]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const pool = needle ? options.filter((option) => option.id.toLowerCase().includes(needle)) : options;
    /* The current value first when it is not in the filtered set: it is the one
       the operator is looking at, and hiding it makes the field look empty. */
    const exact = pool.find((option) => option.id === value);
    if (exact) return pool;
    if (!needle || value.toLowerCase().includes(needle)) return [{ id: value }, ...pool];
    return pool;
  }, [options, query, value]);

  const known = options.some((option) => option.id === value);
  const unknown = value.trim().length > 0 && !known;

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const commit = (id: string) => {
    onChange(id);
    setQuery(id);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setHighlight((current) => {
        const next = event.key === 'ArrowDown' ? current + 1 : current - 1;
        return Math.max(0, Math.min(matches.length - 1, next));
      });
      return;
    }
    if (event.key === 'Enter') {
      if (open && matches[highlight]) commit(matches[highlight].id);
      else setOpen(false);
      return;
    }
    if (event.key === 'Escape') setOpen(false);
  };

  return (
    <div className="flex flex-col gap-[4px] min-w-0" ref={root}>
      <div className="relative">
        <input
          type="text"
          aria-label={label}
          value={open ? query : value}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setHighlight(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          onBlur={() => setOpen(false)}
          className="w-full h-[36px] px-[10px] pr-[30px] rounded-[var(--radius-1)] border border-[var(--border-strong)] bg-[var(--background)] text-[13px] font-mono outline-none focus:border-[var(--accent)] disabled:opacity-50"
        />
        <button
          type="button"
          aria-label={`${label}: open list`}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setOpen((current) => !current);
            setQuery(value);
          }}
          className="absolute right-[8px] top-1/2 -translate-y-1/2 text-[11px] text-[var(--gray-500)] hover:text-[var(--foreground)] disabled:opacity-40"
        >
          ▼
        </button>
        {open && !disabled && (
          <div className="absolute z-20 mt-[4px] w-full max-h-[260px] overflow-y-auto rounded-[var(--radius-1)] border border-[var(--border-strong)] bg-[var(--background)] shadow-lg">
            {matches.length === 0 ? (
              <div className="px-[10px] py-[10px] text-[12px] text-[var(--gray-500)]">
                No model matches “{query.trim()}”.
              </div>
            ) : (
              matches.slice(0, 200).map((option, index) => (
                <button
                  key={option.id}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => commit(option.id)}
                  onMouseEnter={() => setHighlight(index)}
                  className={`w-full text-left px-[10px] py-[7px] flex flex-col gap-[2px] ${
                    index === highlight ? 'bg-[var(--background-200)]' : ''
                  }`}
                >
                  <span className="text-[12px] font-mono">{option.id}</span>
                  {option.label || option.detail ? (
                    <span className="text-[11px] text-[var(--gray-500)]">
                      {[option.label, option.detail].filter(Boolean).join(' · ')}
                    </span>
                  ) : null}
                </button>
              ))
            )}
          </div>
        )}
      </div>
      {unknown && (
        <span className="text-[11px] text-[var(--warn)]">
          {emptyNote ?? 'This model is not in the provider’s served list.'}
        </span>
      )}
    </div>
  );
}

/** Catalog rows reduced to what the picker shows: the id, and what it costs. */
export function toModelOptions(models: CatalogModel[]): ModelOption[] {
  return models.map((model) => ({
    id: model.id,
    label: model.name && model.name !== model.id ? model.name : undefined,
    detail: model.context ? `${Math.round(model.context / 1000)}k ctx` : undefined,
  }));
}