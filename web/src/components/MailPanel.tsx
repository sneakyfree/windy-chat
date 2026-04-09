import { useEffect, useRef } from 'react';
import { env } from '../env';

interface MailPanelProps {
  open: boolean;
  onClose: () => void;
  /** Pre-fill compose view with these params */
  compose?: { body?: string; to?: string } | null;
}

export default function MailPanel({ open, onClose, compose }: MailPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  let src = env.windyMailUrl;
  if (compose) {
    const params = new URLSearchParams();
    params.set('compose', 'true');
    if (compose.body) params.set('body', compose.body);
    if (compose.to) params.set('to', compose.to);
    src += '?' + params.toString();
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30 transition-opacity"
        onClick={onClose}
      />

      {/* Slide-over panel */}
      <div
        ref={panelRef}
        className="fixed top-0 right-0 z-50 h-full w-[400px] max-w-full flex flex-col shadow-2xl animate-slide-in-right"
        style={{ background: 'var(--bg-primary)' }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: 'var(--bg-tertiary)', background: 'var(--bg-secondary)' }}>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-sm"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
          >
            ✕
          </button>
          <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>Windy Mail</span>
        </div>

        {/* Iframe */}
        <iframe
          src={src}
          className="flex-1 w-full border-0"
          title="Windy Mail"
          allow="clipboard-write"
        />
      </div>
    </>
  );
}
