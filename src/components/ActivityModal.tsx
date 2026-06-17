import { useState } from 'react';
import type { AgentStep, Source } from '../lib/api';
import { Globe, FileText, Cpu, Sparkles, Search, X, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react';

interface ActivityModalProps {
  open: boolean;
  onClose: () => void;
  steps: AgentStep[];
  sources: Source[];
}

const STEP_ICONS: Record<string, typeof Globe> = {
  plan: FileText,
  search: Globe,
  reason: Cpu,
  'plan-analyze': Cpu,
  analyze: Cpu,
  synthesize: Sparkles,
  extract: FileText,
  'deep-analyze': Search,
  'follow-up': Globe,
  webpage: FileText,
};

const SEARCH_LABELS: Record<string, string> = {
  search: 'Web',
  image: 'Image',
  videos: 'Video',
  news: 'News',
  places: 'Places',
  shopping: 'Shopping',
  scholar: 'Scholar',
  patents: 'Patent',
  autocomplete: 'Suggest',
};

const STEP_LABELS: Record<string, string> = {
  plan: 'Plan',
  search: 'Search',
  reason: 'Reasoning',
  'plan-analyze': 'Plan & Analyze',
  analyze: 'Analyze',
  synthesize: 'Synthesis',
  extract: 'Extract',
  'deep-analyze': 'Deep Analysis',
  'follow-up': 'Follow-up',
  webpage: 'Page',
  answer: 'Answer',
};

function stepDisplay(step: AgentStep): { icon: string; label: string } {
  const t = step.type;
  if (t.startsWith('search:')) {
    const subtype = t.slice(7);
    return { icon: 'search', label: SEARCH_LABELS[subtype] || subtype };
  }
  if (SEARCH_LABELS[t]) {
    return { icon: 'search', label: SEARCH_LABELS[t] };
  }
  return { icon: t, label: STEP_LABELS[t] || t };
}

function StepIcon({ type, size = 11 }: { type: string; size?: number }) {
  const baseType = type.startsWith('search:') ? 'search' : type;
  const Icon = STEP_ICONS[baseType] || Cpu;
  return <Icon size={size} strokeWidth={2} />;
}

function ReasoningBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  if (text.length < 120) {
    return (
      <div style={{ fontSize: 10, color: 'var(--athena-text-3)', lineHeight: 1.5, marginTop: 2 }}>
        {text}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 2 }}>
      <div style={{
        fontSize: 10, color: 'var(--athena-text-3)', lineHeight: 1.5,
        display: '-webkit-box', WebkitLineClamp: expanded ? undefined : 2, WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }}>
        {text}
      </div>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '1px 0', fontSize: 9, color: 'var(--athena-text-3)',
          fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 2,
        }}
      >
        {expanded ? <ChevronDown size={8} /> : <ChevronRight size={8} />}
        {expanded ? 'Less' : 'More'}
      </button>
    </div>
  );
}

function RawContextBlock({ context }: { context: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ marginTop: 4 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: 'none',
          border: '0.5px solid var(--athena-border)',
          borderRadius: 4,
          cursor: 'pointer',
          padding: '2px 6px',
          fontSize: 8.5,
          color: 'var(--athena-text-3)',
          fontFamily: 'inherit',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 2,
        }}
      >
        {open ? <ChevronDown size={8} /> : <ChevronRight size={8} />}
        {open ? 'Hide Raw Context' : 'Show Raw Context'}
      </button>
      {open && (
        <pre style={{
          fontSize: 9,
          background: 'rgba(var(--athena-accent-rgb), 0.02)',
          border: '0.5px solid var(--athena-border)',
          borderRadius: 6,
          padding: 8,
          marginTop: 4,
          overflowX: 'auto',
          maxHeight: 180,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          color: 'var(--athena-text-2)',
          fontFamily: 'monospace',
          lineHeight: 1.3,
        }}>
          {context}
        </pre>
      )}
    </div>
  );
}

export default function ActivityModal({ open, onClose, steps, sources }: ActivityModalProps) {
  if (!open) return null;

  const searchSteps = steps.filter(s => s.type.startsWith('search'));
  const reasonSteps = steps.filter(s => s.type === 'reason' || s.type === 'plan-analyze' || s.type === 'analyze' || s.type === 'plan');

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.3)',
        backdropFilter: 'blur(8px)',
        animation: 'fade-in 160ms var(--ease-out) both',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass-panel"
        style={{
          width: '90%',
          maxWidth: 520,
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          animation: 'scale-in 200ms var(--ease-spring) both',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 18px 12px',
            borderBottom: '0.5px solid var(--athena-border)',
          }}
        >
          <h2
            className="font-outfit"
            style={{
              fontSize: 14,
              fontWeight: 600,
              margin: 0,
              color: 'var(--athena-text)',
            }}
          >
            Research Activity
          </h2>
          <button
            onClick={onClose}
            aria-label="Close activity panel"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--athena-text-3)',
              padding: 4,
              borderRadius: 6,
              display: 'flex',
            }}
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: 'hidden auto', padding: '16px 18px 18px' }}>
          {/* Summary bar */}
          <div style={{
            display: 'flex',
            gap: 12,
            marginBottom: 16,
            flexWrap: 'wrap',
          }}>
            <SummaryChip icon={<Globe size={10} />} label={`${searchSteps.length} searches`} />
            <SummaryChip icon={<Cpu size={10} />} label={`${reasonSteps.length} reasoning steps`} />
            {steps[0]?.model && (
              <SummaryChip icon={<FileText size={10} />} label={steps[0].model} />
            )}
            <SummaryChip icon={<Sparkles size={10} />} label={`${sources.length} sources`} />
          </div>

          {/* Timeline */}
          {steps.length > 0 && (
            <div style={{ position: 'relative' }}>
              {/* Vertical line */}
              <div style={{
                position: 'absolute',
                left: 8,
                top: 12,
                bottom: 12,
                width: 1,
                background: 'var(--athena-border)',
              }} />

              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {steps.map((step, i) => (
                  <div
                    key={i}
                    style={{
                        display: 'flex',
                        gap: 10,
                        padding: '8px 0',
                        position: 'relative',
                        animation: `fade-in 0.2s ${i * 0.03}s var(--ease-out) both`,
                      }}
                    >
                      {/* Timeline dot */}
                      <div style={{
                        width: 17,
                        flexShrink: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                      }}>
                        <div style={{
                          width: 17,
                          height: 17,
                          borderRadius: '50%',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          background: step.type === 'synthesize'
                            ? 'rgba(var(--athena-accent-rgb), 0.12)'
                            : 'rgba(var(--athena-accent-rgb), 0.06)',
                          color: step.type === 'synthesize'
                            ? 'var(--athena-accent)'
                            : 'var(--athena-text-3)',
                          flexShrink: 0,
                          position: 'relative',
                          zIndex: 1,
                        }}>
                          <StepIcon type={step.type} size={8} />
                        </div>
                      </div>

                      {/* Content */}
                      <div style={{ flex: 1, minWidth: 0, paddingTop: 0 }}>
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          flexWrap: 'wrap',
                        }}>
                          <span style={{
                            fontSize: 10.5,
                            fontWeight: 600,
                            color: 'var(--athena-text)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.03em',
                          }}>
                            {stepDisplay(step).label}
                          </span>
                          {step.model && (
                            <span style={{
                              fontSize: 8.5,
                              color: 'var(--athena-text-3)',
                              background: 'rgba(var(--athena-accent-rgb), 0.04)',
                              padding: '1px 5px',
                              borderRadius: 3,
                            }}>
                              {step.model}
                            </span>
                          )}
                          {step.duration_ms !== undefined && (
                            <span style={{
                              fontSize: 8.5,
                              color: 'var(--athena-text-3)',
                              fontVariantNumeric: 'tabular-nums',
                            }}>
                              {(step.duration_ms / 1000).toFixed(2)}s
                            </span>
                          )}
                          {step.result_count !== undefined && (
                            <span style={{
                              fontSize: 8.5,
                              color: 'var(--athena-text-3)',
                            }}>
                              {step.result_count} results
                            </span>
                          )}
                        </div>

                        {step.query && (
                          <div style={{
                            fontSize: 10.5,
                            color: 'var(--athena-text-2)',
                            marginTop: 2,
                            fontStyle: 'italic',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}>
                          {(() => {
                            let displayQ = step.query!;
                            if (step.type === 'webpage') {
                              try { displayQ = new URL(step.query!).hostname; } catch {}
                            }
                            return `"${displayQ}"`;
                          })()}
                          </div>
                        )}

                        {(step.type === 'reason' || step.type === 'plan-analyze' || step.type === 'analyze' || step.type === 'plan') && step.note && (
                          <ReasoningBlock text={step.note} />
                        )}

                        {step.note && step.type !== 'reason' && step.type !== 'plan-analyze' && step.type !== 'analyze' && step.type !== 'plan' && (
                          <div style={{
                            fontSize: 10,
                            color: 'var(--athena-text-3)',
                            marginTop: 2,
                          }}>
                            {step.note}
                          </div>
                        )}

                        {step.context && (
                          <RawContextBlock context={step.context} />
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Sources section */}
          {sources.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div
                className="font-mono"
                style={{
                  fontSize: 9,
                  fontWeight: 500,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: 'var(--athena-text-3)',
                  marginBottom: 8,
                }}
              >
                Sources ({sources.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {sources.map((src, i) => (
                  <a
                    key={i}
                    href={src.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 8px',
                      borderRadius: 6,
                      textDecoration: 'none',
                      fontSize: 11,
                      color: 'var(--athena-text-2)',
                      transition: 'background 120ms',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(var(--athena-accent-rgb), 0.04)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
                  >
                    <span
                      className="font-mono"
                      style={{
                        fontSize: 8.5,
                        color: 'var(--athena-text-3)',
                        flexShrink: 0,
                      }}
                    >
                      {i + 1}.
                    </span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {src.title || src.domain}
                    </span>
                    <ExternalLink size={8} style={{ flexShrink: 0, color: 'var(--athena-text-3)' }} />
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryChip({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '3px 8px',
      borderRadius: 6,
      background: 'rgba(var(--athena-accent-rgb), 0.04)',
      border: '0.5px solid rgba(var(--athena-accent-rgb), 0.08)',
      fontSize: 9.5,
      color: 'var(--athena-text-3)',
    }}>
      {icon}
      {label}
    </div>
  );
}
