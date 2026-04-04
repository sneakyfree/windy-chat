/** Task 3: Onboarding welcome flow for new users */
import { useState } from 'react';

interface WelcomeOverlayProps {
  displayName: string | null;
  onDismiss: () => void;
  onNavigate: (view: string) => void;
}

export default function WelcomeOverlay({ displayName, onDismiss, onNavigate }: WelcomeOverlayProps) {
  const [step] = useState(0);

  const name = displayName || 'there';

  if (step === 0) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onDismiss}>
        <div className="absolute inset-0 bg-black/60" />
        <div
          className="relative w-full max-w-lg rounded-2xl p-8 shadow-2xl"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--bg-tertiary)' }}
          onClick={e => e.stopPropagation()}
        >
          <div className="text-center mb-6">
            <div className="text-5xl mb-4">🌪️</div>
            <h1 className="text-2xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
              Welcome to Windy Chat, {name}!
            </h1>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Here's what you can do:
            </p>
          </div>

          <div className="space-y-3 mb-8">
            <button
              onClick={() => { onDismiss(); onNavigate('chat'); }}
              className="w-full flex items-center gap-4 p-4 rounded-xl transition-all text-left"
              style={{ background: 'var(--bg-tertiary)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
            >
              <span className="text-2xl">💬</span>
              <div>
                <h3 className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>Chat with friends</h3>
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>Send messages, share media, voice chat</p>
              </div>
            </button>

            <button
              onClick={() => { onDismiss(); onNavigate('discover'); }}
              className="w-full flex items-center gap-4 p-4 rounded-xl transition-all text-left"
              style={{ background: 'var(--bg-tertiary)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
            >
              <span className="text-2xl">🪰</span>
              <div>
                <h3 className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>Discover AI agents</h3>
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>Browse verified bots with Eternitas passports</p>
              </div>
            </button>

            <button
              onClick={() => { onDismiss(); onNavigate('social'); }}
              className="w-full flex items-center gap-4 p-4 rounded-xl transition-all text-left"
              style={{ background: 'var(--bg-tertiary)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
            >
              <span className="text-2xl">📝</span>
              <div>
                <h3 className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>Post on the social feed</h3>
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>Share updates, follow people, discover trending topics</p>
              </div>
            </button>
          </div>

          <button
            onClick={onDismiss}
            className="w-full py-3 rounded-xl text-sm font-medium"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            Get Started
          </button>
        </div>
      </div>
    );
  }

  return null;
}

/** Mic button tooltip — shown once to teach users about voice input */
export function MicTooltip({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 px-3 py-2 rounded-lg text-xs whitespace-nowrap shadow-lg"
      style={{ background: 'var(--accent)', color: 'white' }}
    >
      Tap to speak instead of type!
      <button onClick={onDismiss} className="ml-2 opacity-70 hover:opacity-100">&times;</button>
      <div className="absolute top-full left-1/2 -translate-x-1/2 w-2 h-2 rotate-45"
           style={{ background: 'var(--accent)', marginTop: '-4px' }} />
    </div>
  );
}
