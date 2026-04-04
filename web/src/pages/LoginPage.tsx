import { useState, type FormEvent } from 'react';

interface LoginPageProps {
  onLogin: (jwt: string) => Promise<void>;
}

export default function LoginPage({ onLogin }: LoginPageProps) {
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      // For now, create a simple JWT for dev/demo. In production,
      // this would call the account-server login endpoint.
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Login failed (${res.status})`);
      }
      const data = await res.json();
      await onLogin(data.token || data.jwt || data.access_token);
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
      // Redirect to Windy Pro OAuth or use stored JWT
      const existingJwt = localStorage.getItem('windy_pro_jwt');
      if (existingJwt) {
        await onLogin(existingJwt);
        return;
      }
      // In production, redirect to: https://api.windypro.com/oauth/authorize
      setError('Windy account sign-in: redirect to windypro.com (not yet configured)');
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

        {/* Logo */}
        <div className="text-center mb-8">
          <div className="text-4xl mb-2">🌪️</div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
            Windy Chat
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            Messaging, social, agents — all in one place
          </p>
        </div>

        {/* Windy Sign In Button */}
        <button
          onClick={handleWindySignIn}
          disabled={loading}
          className="w-full py-3 px-4 rounded-xl font-medium text-white mb-4 transition-all hover:opacity-90 disabled:opacity-50"
          style={{ background: 'var(--accent)' }}
        >
          🌪️ Sign in with Windy
        </button>

        <div className="flex items-center gap-3 my-6">
          <div className="flex-1 h-px" style={{ background: 'var(--bg-tertiary)' }} />
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>or continue with email</span>
          <div className="flex-1 h-px" style={{ background: 'var(--bg-tertiary)' }} />
        </div>

        {/* Email/Password Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className="w-full px-4 py-3 rounded-xl text-sm outline-none transition-all"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              border: '1px solid transparent',
            }}
            onFocus={e => e.target.style.borderColor = 'var(--accent)'}
            onBlur={e => e.target.style.borderColor = 'transparent'}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            className="w-full px-4 py-3 rounded-xl text-sm outline-none transition-all"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              border: '1px solid transparent',
            }}
            onFocus={e => e.target.style.borderColor = 'var(--accent)'}
            onBlur={e => e.target.style.borderColor = 'transparent'}
          />

          {error && (
            <div className="text-sm px-3 py-2 rounded-lg" style={{ color: 'var(--danger)', background: 'rgba(248,113,113,0.1)' }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 px-4 rounded-xl font-medium transition-all hover:opacity-90 disabled:opacity-50"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
          >
            {loading ? 'Signing in...' : mode === 'signin' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <p className="text-center text-sm mt-6" style={{ color: 'var(--text-muted)' }}>
          {mode === 'signin' ? (
            <>Don't have an account?{' '}
              <button onClick={() => setMode('register')} className="underline" style={{ color: 'var(--accent)' }}>Register</button>
            </>
          ) : (
            <>Already have an account?{' '}
              <button onClick={() => setMode('signin')} className="underline" style={{ color: 'var(--accent)' }}>Sign in</button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
