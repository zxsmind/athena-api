import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Copy, Loader2, X } from 'lucide-react';

/* ── Button ─────────────────────────────────────────────────────────────── */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

const buttonBase =
  'inline-flex w-fit items-center justify-center gap-[6px] font-medium whitespace-nowrap ' +
  'transition-[background,border-color,color,opacity] duration-120 ' +
  'disabled:opacity-50 disabled:pointer-events-none select-none';

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-[var(--accent)] text-[var(--accent-foreground)] border border-[var(--accent)] hover:bg-[var(--accent-hover)] hover:border-[var(--accent-hover)]',
  secondary: 'bg-[var(--background-100)] border border-[var(--border-strong)] hover:border-[var(--foreground)] hover:bg-[var(--background-200)]',
  ghost: 'bg-transparent border border-transparent hover:bg-[var(--background-200)] text-[var(--gray-700)] hover:text-[var(--foreground)]',
  danger: 'bg-transparent border border-[var(--danger)] text-[var(--danger)] hover:bg-[var(--danger)] hover:text-white',
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: 'h-[32px] px-[10px] text-[13px] rounded-[var(--radius-1)]',
  md: 'h-[40px] px-[16px] text-[14px] rounded-[var(--radius-1)]',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; loading?: boolean }) {
  return (
    <button
      className={`${buttonBase} ${buttonVariants[variant]} ${buttonSizes[size]} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Loader2 size={14} className="animate-spin" />}
      {children}
    </button>
  );
}

/* ── Inputs ─────────────────────────────────────────────────────────────── */

const fieldBase =
  'w-full bg-[var(--background-100)] border border-[var(--border-strong)] rounded-[var(--radius-1)] ' +
  'px-[10px] text-[14px] transition-[border-color,box-shadow] duration-120 ' +
  'placeholder:text-[var(--gray-500)] focus:border-[var(--foreground)] focus:outline-none ' +
  'focus:shadow-[0_0_0_3px_var(--gray-100)]';

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${fieldBase} h-[40px] ${className}`} {...rest} />;
}

export function Textarea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${fieldBase} py-[8px] min-h-[80px] resize-y ${className}`} {...rest} />;
}

export function Select({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${fieldBase} h-[40px] pr-[8px] cursor-pointer ${className}`} {...rest}>
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-[6px]">
      <label htmlFor={id} className="text-[13px] font-medium text-[var(--gray-700)]">
        {label}
      </label>
      {children(id)}
      {hint && <p className="text-[13px] text-[var(--gray-500)]">{hint}</p>}
    </div>
  );
}

/* ── Card ───────────────────────────────────────────────────────────────── */

export function Card({
  className = '',
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`bg-[var(--background-100)] border border-[var(--border)] rounded-[var(--radius-2)] shadow-[var(--shadow-1)] ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-[16px] px-[20px] pt-[16px] pb-[12px] border-b border-[var(--border)]">
      <div className="flex flex-col gap-[2px]">
        <h2 className="text-[14px] font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-[13px] text-[var(--gray-600)]">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-[8px] shrink-0">{actions}</div>}
    </div>
  );
}

/* ── Badge ──────────────────────────────────────────────────────────────── */

type BadgeTone = 'neutral' | 'live' | 'ok' | 'warn' | 'danger';

const badgeTones: Record<BadgeTone, string> = {
  neutral: 'text-[var(--gray-700)] border-[var(--border-strong)]',
  live: 'text-[var(--live)] border-[var(--live)]',
  ok: 'text-[var(--ok)] border-[var(--ok)]',
  warn: 'text-[var(--warn)] border-[var(--warn)]',
  danger: 'text-[var(--danger)] border-[var(--danger)]',
};

export function Badge({
  tone = 'neutral',
  pulse = false,
  children,
}: {
  tone?: BadgeTone;
  pulse?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-[5px] h-[22px] px-[7px] rounded-full border text-[12px] font-medium font-mono ${badgeTones[tone]}`}
    >
      {pulse && (
        <span
          className="w-[6px] h-[6px] rounded-full bg-current"
          style={{ animation: 'pulse-live 1.4s ease-in-out infinite' }}
        />
      )}
      {children}
    </span>
  );
}

/* ── Tabs (segmented) ───────────────────────────────────────────────────── */

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (value: T) => void;
  tabs: Array<{ id: T; label: string }>;
}) {
  return (
    <div className="inline-flex items-center p-[2px] gap-[2px] bg-[var(--background-200)] border border-[var(--border)] rounded-[var(--radius-1)]">
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={`relative h-[28px] px-[12px] text-[13px] font-medium rounded-[4px] transition-colors duration-120 ${
              active ? 'text-[var(--foreground)]' : 'text-[var(--gray-600)] hover:text-[var(--foreground)]'
            }`}
          >
            {active && (
              <motion.span
                layoutId="tab-pill"
                className="absolute inset-0 bg-[var(--background-100)] border border-[var(--border-strong)] rounded-[4px] shadow-[var(--shadow-1)]"
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              />
            )}
            <span className="relative z-1">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ── Table ──────────────────────────────────────────────────────────────── */

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-[var(--border)]">
            {head.map((cell, i) => (
              <th
                key={i}
                className="text-left font-medium text-[var(--gray-600)] px-[16px] py-[10px] whitespace-nowrap"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Tr({
  children,
  className = '',
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={`border-b border-[var(--border)] last:border-0 hover:bg-[var(--background-200)] transition-colors duration-120 ${className}`}
      {...rest}
    >
      {children}
    </tr>
  );
}

export function Td({
  children,
  mono = false,
  className = '',
}: {
  children: ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <td className={`px-[16px] py-[10px] ${mono ? 'font-mono text-[12px]' : ''} ${className}`}>{children}</td>
  );
}

/* ── Dialog ─────────────────────────────────────────────────────────────── */

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-[24px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
        >
          <div className="absolute inset-0 bg-[rgba(0,0,0,0.4)]" onClick={onClose} />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className="relative w-full max-w-[480px] bg-[var(--background-100)] border border-[var(--border)] rounded-[var(--radius-2)] shadow-[var(--shadow-3)]"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 4 }}
            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          >
            <div className="flex items-start justify-between gap-[16px] px-[20px] pt-[18px]">
              <div className="flex flex-col gap-[2px]">
                <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
                {description && <p className="text-[13px] text-[var(--gray-600)]">{description}</p>}
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="p-[6px] rounded-[var(--radius-1)] text-[var(--gray-500)] hover:text-[var(--foreground)] hover:bg-[var(--background-200)] transition-colors duration-120"
              >
                <X size={16} />
              </button>
            </div>
            <div className="px-[20px] py-[16px]">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ── Copy button ────────────────────────────────────────────────────────── */

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }, [value]);

  return (
    <Button size="sm" variant="ghost" onClick={copy} aria-label={`${label} to clipboard`}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? 'Copied' : label}
    </Button>
  );
}

/* ── Code block ─────────────────────────────────────────────────────────── */

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  return (
    <div className="relative rounded-[var(--radius-1)] border border-[var(--border)] bg-[var(--background-200)]">
      {language && (
        <span className="absolute top-[8px] left-[12px] text-[11px] font-mono uppercase tracking-wider text-[var(--gray-500)]">
          {language}
        </span>
      )}
      <pre className="overflow-x-auto px-[14px] py-[14px] text-[12px] font-mono leading-relaxed">
        <code>{code}</code>
      </pre>
      <div className="absolute top-[6px] right-[8px]">
        <CopyButton value={code} />
      </div>
    </div>
  );
}

/* ── Progress / budget gauge ────────────────────────────────────────────── */

export function Gauge({
  used,
  limit,
  label,
  unit,
}: {
  used: number | null;
  limit: number | null;
  label: string;
  unit?: string;
}) {
  const share = used !== null && limit !== null && limit > 0 ? Math.min(1, used / limit) : 0;
  const hot = share >= 0.85;
  return (
    <div className="flex flex-col gap-[5px] min-w-0">
      <div className="flex items-baseline justify-between gap-[8px] text-[12px]">
        <span className="text-[var(--gray-600)] truncate">{label}</span>
        <span className="font-mono tabular-nums text-[var(--gray-700)]">
          {used ?? '—'}
          <span className="text-[var(--gray-500)]"> / {limit ?? '∞'}{unit ? ` ${unit}` : ''}</span>
        </span>
      </div>
      <div className="h-[4px] rounded-full bg-[var(--gray-200)] overflow-hidden">
        <motion.div
          className="h-full rounded-full"
          style={{ background: hot ? 'var(--warn)' : 'var(--foreground)' }}
          initial={{ width: 0 }}
          animate={{ width: `${share * 100}%` }}
          transition={{ type: 'spring', stiffness: 120, damping: 20 }}
        />
      </div>
    </div>
  );
}

/* ── Spinner ────────────────────────────────────────────────────────────── */

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-[8px] text-[13px] text-[var(--gray-600)]">
      <Loader2 size={14} className="animate-spin" />
      {label}
    </span>
  );
}

/* ── Empty state ────────────────────────────────────────────────────────── */

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-[6px] py-[48px] text-center">
      <p className="text-[14px] font-medium text-[var(--gray-700)]">{title}</p>
      {hint && <p className="text-[13px] text-[var(--gray-500)] max-w-[360px]">{hint}</p>}
    </div>
  );
}

/* ── Key/value row ──────────────────────────────────────────────────────── */

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-[16px] py-[8px] border-b border-[var(--border)] last:border-0">
      <span className="text-[13px] text-[var(--gray-600)] shrink-0">{label}</span>
      <span className="text-[13px] font-mono text-right min-w-0 break-all">{children}</span>
    </div>
  );
}

/* ── Toast ──────────────────────────────────────────────────────────────── */

interface Toast {
  id: number;
  message: string;
  tone: 'neutral' | 'danger';
}

const ToastContext = createContext<(message: string, tone?: Toast['tone']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const push = useCallback((message: string, tone: Toast['tone'] = 'neutral') => {
    const id = next.current++;
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4200);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="fixed bottom-[20px] right-[20px] z-60 flex flex-col gap-[8px] items-end pointer-events-none">
        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, y: 12, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              className="pointer-events-auto flex items-center gap-[10px] max-w-[420px] px-[14px] py-[10px] rounded-[var(--radius-2)] border border-[var(--border)] bg-[var(--background-100)] shadow-[var(--shadow-3)] text-[13px]"
            >
              <span
                className="w-[6px] h-[6px] rounded-full shrink-0"
                style={{ background: toast.tone === 'danger' ? 'var(--danger)' : 'var(--ok)' }}
              />
              {toast.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
