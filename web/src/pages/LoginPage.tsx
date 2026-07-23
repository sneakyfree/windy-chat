import { useState, type FormEvent } from 'react';
import { env } from '../env';
import { beginWindySignIn } from '../lib/sso';

interface LoginPageProps {
  onLogin: (jwt: string, refreshToken?: string | null) => Promise<void>;
  mode: 'signin' | 'register';
  onToggleMode: () => void;
  onBack: () => void;
  /** Seed the error banner (e.g. an SSO callback failure surfaced by App). */
  initialError?: string;
}

export default function LoginPage({ onLogin, mode, onToggleMode, onBack, initialError }: LoginPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState(initialError || '');
  const [needsVerification, setNeedsVerification] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setNeedsVerification(false);
    setLoading(true);
    try {
      if (mode === 'register') {
        // Register new account via account-server. The endpoint's required
        // field is `name` — sending only `display_name` fails validation with
        // "name Required", so email sign-up never completed from the web app.
        const regRes = await fetch(`${env.accountServerUrl}/api/v1/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, name: displayName, display_name: displayName }),
        });
        if (!regRes.ok) {
          const data = await regRes.json().catch(() => ({}));
          // Prefer the field-level detail over the generic "Validation failed"
          // so the message a new user sees is actionable, not dev jargon.
          const detail = Array.isArray(data.details) && data.details[0]
            ? `${data.details[0].field}: ${data.details[0].message}`
            : null;
          throw new Error(data.error && detail ? `${data.error} — ${detail}` : (data.error || detail || `Registration failed (${regRes.status})`));
        }
        const regData = await regRes.json();
        await onLogin(regData.token || regData.jwt || regData.access_token, regData.refreshToken || regData.refresh_token || null);
      } else {
        // Sign in via account-server
        const res = await fetch(`${env.accountServerUrl}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          // Unverified-email 403: without guidance this is a dead end — the
          // login page has no resend control. Point at the Windy Word app,
          // which owns the verify + resend flow.
          if (res.status === 403 && /verify/i.test(data.error || '')) {
            setNeedsVerification(true);
            throw new Error(data.error || 'Please verify your email before logging in.');
          }
          throw new Error(data.error || `Login failed (${res.status})`);
        }
        const data = await res.json();
        await onLogin(data.token || data.jwt || data.access_token, data.refreshToken || data.refresh_token || null);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleWindySignIn() {
    setError('');
    setLoading(true);
    try {
      const existingJwt = localStorage.getItem('windy_pro_jwt');
      if (existingJwt) {
        await onLogin(existingJwt);
        return;
      }
      // Full OAuth authorization-code + PKCE flow. The account-server shows
      // its own login page when the user isn't signed in, then sends the
      // browser back to /auth/callback (handled in App.tsx on boot).
      await beginWindySignIn();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4"
         style={{ background: 'var(--bg-primary)' }}>
      <div className="w-full max-w-md rounded-2xl p-8"
           style={{ background: 'var(--bg-secondary)', border: '1px solid var(--bg-tertiary)' }}>

        {/* Back button */}
        <button onClick={onBack} className="text-sm mb-6 flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}>
          ← Back
        </button>

        {/* Logo */}
        <div className="text-center mb-8">
          <div className="text-4xl mb-2">🌪️</div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
            {mode === 'signin' ? 'Welcome back' : 'Create your account'}
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            {mode === 'signin' ? 'Sign in to Windy Chat' : 'Join the conversation'}
          </p>
        </div>

        {/* Windy Sign In Button */}
        <button
          onClick={handleWindySignIn}
          disabled={loading}
          className="w-full py-3 px-4 rounded-xl font-medium text-white mb-4 transition-all hover:opacity-90 disabled:opacity-50"
          style={{ background: 'var(--accent)' }}
        >
          🌪️ {mode === 'signin' ? 'Sign in with Windy' : 'Register with Windy'}
        </button>

        <div className="flex items-center gap-3 my-6">
          <div className="flex-1 h-px" style={{ background: 'var(--bg-tertiary)' }} />
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>or continue with email</span>
          <div className="flex-1 h-px" style={{ background: 'var(--bg-tertiary)' }} />
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'register' && (
            <input
              type="text"
              placeholder="Display name"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              required
              className="w-full px-4 py-3 rounded-xl text-sm outline-none"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
            />
          )}
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className="w-full px-4 py-3 rounded-xl text-sm outline-none"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            minLength={8}
            className="w-full px-4 py-3 rounded-xl text-sm outline-none"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
          />

          {error && (
            <div className="text-sm px-3 py-2 rounded-lg" style={{ color: 'var(--danger)', background: 'rgba(248,113,113,0.1)' }}>
              {error}
              {needsVerification && (
                <div className="mt-2" style={{ color: 'var(--text-secondary)' }}>
                  Check your inbox for the verification email. Need a new one?{' '}
                  <a
                    href="https://account.windyword.ai"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                    style={{ color: 'var(--accent)' }}
                  >
                    Verify at account.windyword.ai
                  </a>
                  {' '}— sign in there and it walks you through it.
                </div>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 px-4 rounded-xl font-medium transition-all hover:opacity-90 disabled:opacity-50"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
          >
            {loading ? (mode === 'signin' ? 'Signing in...' : 'Creating account...') : (mode === 'signin' ? 'Sign In' : 'Create Account')}
          </button>
        </form>

        <p className="text-center text-sm mt-6" style={{ color: 'var(--text-muted)' }}>
          {mode === 'signin' ? (
            <>Don't have an account?{' '}
              <button onClick={onToggleMode} className="underline" style={{ color: 'var(--accent)' }}>Register</button>
            </>
          ) : (
            <>Already have an account?{' '}
              <button onClick={onToggleMode} className="underline" style={{ color: 'var(--accent)' }}>Sign in</button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
