import { motion } from 'framer-motion';
import type { ReactNode } from 'react';

/** Standard page frame: title block, then content. One motion vocabulary for
 *  every page so navigation feels like one app, not five. */
export function Page({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-[20px]">
      <motion.div
        className="flex flex-wrap items-end justify-between gap-[12px]"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="flex flex-col gap-[4px]">
          <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
          {description && <p className="text-[13px] text-[var(--gray-600)] max-w-[640px]">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-[8px]">{actions}</div>}
      </motion.div>
      {children}
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--gray-500)]">{children}</h3>
  );
}
