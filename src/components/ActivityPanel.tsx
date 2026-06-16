import { Check, Globe, FileText, Cpu, Sparkles } from 'lucide-react';

export type ActivityStep = {
  type: 'search' | 'extract' | 'analyze' | 'synthesize' | 'plan';
  label: string;
  detail: string;
};

interface ActivityPanelProps {
  steps: ActivityStep[];
  activeIndex: number;
  done: boolean;
}

const ICONS: Record<ActivityStep['type'], typeof Globe> = {
  search: Globe,
  extract: FileText,
  analyze: Cpu,
  synthesize: Sparkles,
  plan: FileText,
};

export default function ActivityPanel({
  steps,
  activeIndex,
  done,
}: ActivityPanelProps) {
  const current = done
    ? steps[steps.length - 1]
    : steps[Math.min(activeIndex, steps.length - 1)];
  const CurrentIcon = current ? ICONS[current.type] : Globe;
  const progress = done ? 100 : Math.round(((activeIndex + 1) / steps.length) * 100);

  return (
    <div
      className="glass-activity"
      style={{
        padding: '10px 14px',
        animation: 'fade-in 260ms var(--ease-out) both',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          position: 'relative',
          zIndex: 3,
        }}
      >
        {/* Status dot / check */}
        <div
          style={{
            width: 26,
            height: 26,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            background: done
              ? 'rgba(var(--athena-accent-rgb), 0.10)'
              : 'rgba(var(--athena-accent-rgb), 0.06)',
            border: `0.5px solid ${
              done
                ? 'rgba(var(--athena-accent-rgb), 0.16)'
                : 'rgba(var(--athena-accent-rgb), 0.10)'
            }`,
          }}
        >
          {done ? (
            <Check size={12} strokeWidth={2.5} color="var(--athena-text-2)" />
          ) : (
            <CurrentIcon size={12} strokeWidth={2} color="var(--athena-text-2)" />
          )}
        </div>

        {/* Text */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="font-mono"
            style={{
              fontSize: 9,
              fontWeight: 500,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--athena-text-3)',
              marginBottom: 2,
            }}
          >
            {done ? 'Complete' : `${current?.label ?? 'Working'}…`}
          </div>
          <div
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: 'var(--athena-text-2)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              lineHeight: 1.4,
            }}
          >
            {done ? 'Answer ready' : current?.detail ?? ''}
          </div>
        </div>

        {/* Counter */}
        <div
          className="font-mono"
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--athena-text-3)',
            flexShrink: 0,
          }}
        >
          {done ? (
            <span style={{ color: 'var(--athena-text-2)' }}>Done</span>
          ) : (
            <span>{activeIndex + 1}/{steps.length}</span>
          )}
        </div>
      </div>

      {/* Subtle progress bar */}
      <div
        style={{
          position: 'relative',
          zIndex: 3,
          height: 2,
          borderRadius: 99,
          marginTop: 10,
          overflow: 'hidden',
          background: 'rgba(var(--athena-accent-rgb), 0.05)',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${progress}%`,
            borderRadius: 99,
            background: 'rgba(var(--athena-accent-rgb), 0.22)',
            transition: 'width 400ms var(--ease-out)',
          }}
        />
        {!done && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              width: '40%',
              background:
                'linear-gradient(90deg, transparent, rgba(var(--athena-accent-rgb), 0.18), transparent)',
              animation: 'progress-shimmer 1.8s ease-in-out infinite',
            }}
          />
        )}
      </div>
    </div>
  );
}
