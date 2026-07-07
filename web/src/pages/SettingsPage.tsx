import { useState, useEffect, useCallback } from 'react';
import { env } from '../env';
import {
  type PushStatus,
  disableWebPush,
  enableWebPush,
  pushState,
} from '../lib/push';

interface SettingsPageProps {
  userId: string | null;
  onLogout: () => void;
  onNavigate?: (view: string) => void;
}

type ServiceStatus = 'connected' | 'not_connected' | 'connecting' | 'unknown';

interface ServiceState {
  word: ServiceStatus;
  mail: ServiceStatus;
  cloud: ServiceStatus;
  eternitas: ServiceStatus;
  error?: string;
}

export default function SettingsPage({ userId, onLogout, onNavigate }: SettingsPageProps) {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [language, setLanguage] = useState('en');
  // Real web-push state (the old boolean was a decorative toggle that
  // controlled nothing — grandma's closed tab stayed silent).
  const [push, setPush] = useState<PushStatus>(() => pushState());
  const [pushBusy, setPushBusy] = useState(false);

  const pushHint =
    push === 'unsupported'
      ? 'Not supported in this browser'
      : push === 'denied'
        ? 'Blocked — allow notifications in your browser settings'
        : push === 'unavailable'
          ? 'Not switched on for this server yet'
          : push === 'error'
            ? "Couldn't turn on — try again"
            : null;

  const togglePush = async () => {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      if (push === 'enabled') {
        await disableWebPush();
        setPush('disabled');
      } else {
        setPush(await enableWebPush());
      }
    } finally {
      setPushBusy(false);
    }
  };
  const [services, setServices] = useState<ServiceState>({
    // Word is always "connected" — auth itself flows through Windy Word
    // (Pro account-server). Other three start at unknown until the
    // ecosystem-status call returns.
    word: 'connected',
    mail: 'unknown',
    cloud: 'unknown',
    eternitas: 'unknown',
  });
  const [connectError, setConnectError] = useState<Record<string, string>>({});

  const refreshServices = useCallback(async () => {
    const token = localStorage.getItem('windy_jwt');
    if (!token) return;
    try {
      const res = await fetch(`${env.accountServerUrl}/api/v1/identity/ecosystem-status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      const products = (data.products as Record<string, { status?: string }>) || {};
      const statusOf = (key: string): ServiceStatus => {
        const s = products[key]?.status;
        if (s === 'active') return 'connected';
        if (s === 'pending' || s === 'inactive' || !s) return 'not_connected';
        return 'unknown';
      };
      setServices(prev => ({
        ...prev,
        word: 'connected',
        mail: statusOf('windy_mail'),
        cloud: statusOf('windy_cloud'),
        // Eternitas connected if the user holds OR operates an active passport.
        eternitas: products['eternitas']?.status === 'active' ? 'connected' : 'not_connected',
      }));
    } catch { /* non-fatal — leave as unknown */ }
  }, []);

  useEffect(() => { refreshServices(); }, [refreshServices]);

  const connectMail = useCallback(async () => {
    const token = localStorage.getItem('windy_jwt');
    if (!token) return;
    setConnectError(s => ({ ...s, mail: '' }));
    setServices(s => ({ ...s, mail: 'connecting' }));
    try {
      const res = await fetch(`${env.accountServerUrl}/api/v1/identity/mail/provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}',
      });
      const detail = await res.text().catch(() => '');
      if (!res.ok) {
        setConnectError(s => ({ ...s, mail: `Provision failed (${res.status})` }));
        setServices(s => ({ ...s, mail: 'not_connected' }));
        return;
      }
      setServices(s => ({ ...s, mail: 'connected' }));
      // Surface the assigned address briefly so the user knows it worked.
      try {
        const data = JSON.parse(detail);
        if (data?.mail_address) {
          setConnectError(s => ({ ...s, mail: `Mailbox ${data.mail_address} ready.` }));
        }
      } catch { /* ignore */ }
      refreshServices();
    } catch (err: any) {
      setConnectError(s => ({ ...s, mail: err?.message || 'Could not connect.' }));
      setServices(s => ({ ...s, mail: 'not_connected' }));
    }
  }, [refreshServices]);

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="mb-8">
      <h3 className="text-sm font-medium uppercase tracking-wider mb-4" style={{ color: 'var(--text-muted)' }}>{title}</h3>
      <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-secondary)' }}>
        {children}
      </div>
    </div>
  );

  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex items-center justify-between px-4 py-3.5 border-b last:border-0"
         style={{ borderColor: 'var(--bg-tertiary)' }}>
      <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{label}</span>
      {children}
    </div>
  );

  // ConnectionStatus renders the right-hand cell of a "Connected services"
  // row: a green pill if active, a "Connect now" button if not, or
  // "Connecting…" while the provision call is in flight. For services
  // without a direct user-side provision endpoint (Cloud, Eternitas), we
  // route the click to an external setup surface instead of failing.
  const ConnectionStatus = ({ status, onConnect, externalUrl, label }: {
    status: ServiceStatus;
    onConnect?: () => void;
    externalUrl?: string;
    label: string;
  }) => {
    if (status === 'connected') {
      return (
        <span className="text-xs px-2 py-1 rounded" style={{ background: 'rgba(52,211,153,0.15)', color: 'var(--success)' }}>
          ✓ Connected
        </span>
      );
    }
    if (status === 'connecting') {
      return (
        <span className="text-xs px-2 py-1 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
          Connecting…
        </span>
      );
    }
    if (onConnect) {
      return (
        <button
          type="button"
          onClick={onConnect}
          aria-label={`Connect ${label}`}
          className="text-xs px-3 py-1.5 rounded-lg font-medium transition-opacity hover:opacity-90"
          style={{ background: 'var(--accent)', color: 'white' }}
        >
          Connect now
        </button>
      );
    }
    if (externalUrl) {
      return (
        <a
          href={externalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs px-3 py-1.5 rounded-lg font-medium"
          style={{ background: 'var(--accent)', color: 'white' }}
        >
          Set up ↗
        </a>
      );
    }
    return (
      <span className="text-xs px-2 py-1 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
        Not connected
      </span>
    );
  };

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      <h1 className="text-2xl font-bold mb-8" style={{ color: 'var(--text-primary)' }}>Settings</h1>

      <Section title="Account">
        <Row label="User ID">
          <span className="text-sm font-mono" style={{ color: 'var(--text-secondary)' }}>{userId || 'Not logged in'}</span>
        </Row>
        <Row label="Matrix ID">
          <span className="text-sm font-mono" style={{ color: 'var(--text-secondary)' }}>
            {localStorage.getItem('matrix_user_id') || 'Not connected'}
          </span>
        </Row>
      </Section>

      <Section title="Appearance">
        <Row label="Theme">
          <select
            value={theme}
            onChange={e => setTheme(e.target.value as 'dark' | 'light')}
            className="text-sm px-3 py-1.5 rounded-lg outline-none"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
          >
            <option value="dark">Dark</option>
            <option value="light">Light (coming soon)</option>
          </select>
        </Row>
      </Section>

      <Section title="Language">
        <Row label="Preferred language">
          <select
            value={language}
            onChange={e => setLanguage(e.target.value)}
            className="text-sm px-3 py-1.5 rounded-lg outline-none"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
          >
            <option value="en">English</option>
            <option value="es">Español</option>
            <option value="fr">Français</option>
            <option value="de">Deutsch</option>
            <option value="ja">日本語</option>
            <option value="zh">中文</option>
            <option value="ko">한국어</option>
            <option value="pt">Português</option>
            <option value="ar">العربية</option>
          </select>
        </Row>
        <Row label="Auto-translate messages">
          <span className="text-xs px-2 py-1 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
            via Windy Traveler
          </span>
        </Row>
      </Section>

      <Section title="Notifications">
        <Row label="Push notifications">
          <div className="flex items-center gap-2">
            {pushHint && (
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {pushHint}
              </span>
            )}
            <button
              onClick={togglePush}
              disabled={pushBusy || push === 'unsupported' || push === 'denied'}
              className="w-11 h-6 rounded-full relative transition-colors"
              style={{
                background: push === 'enabled' ? 'var(--accent)' : 'var(--bg-tertiary)',
                opacity: push === 'unsupported' || push === 'denied' ? 0.5 : 1,
              }}
            >
              <div
                className="w-5 h-5 rounded-full absolute top-0.5 transition-all"
                style={{
                  background: 'white',
                  left: push === 'enabled' ? '22px' : '2px',
                }}
              />
            </button>
          </div>
        </Row>
      </Section>

      <Section title="Connected Platforms">
        <Row label="Telegram, WhatsApp & more">
          <button
            type="button"
            onClick={() => onNavigate?.('platforms')}
            aria-label="Manage connected platforms"
            className="text-xs px-3 py-1.5 rounded-lg font-medium transition-opacity hover:opacity-90"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            Manage
          </button>
        </Row>
        <div className="px-4 py-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          Link your other chat apps to see all your conversations in one place.
        </div>
      </Section>

      <Section title="Connected Services">
        <Row label="Windy Word">
          <ConnectionStatus status={services.word} label="Windy Word" />
        </Row>
        <Row label="Windy Mail">
          <ConnectionStatus status={services.mail} onConnect={connectMail} label="Windy Mail" />
        </Row>
        {connectError.mail && (
          <div className="px-4 py-2 text-xs" style={{ color: connectError.mail.startsWith('Mailbox') ? 'var(--success)' : 'var(--danger)' }}>
            {connectError.mail}
          </div>
        )}
        <Row label="Windy Cloud">
          <ConnectionStatus status={services.cloud} externalUrl="https://cloud.windycloud.com" label="Windy Cloud" />
        </Row>
        <Row label="Eternitas">
          <ConnectionStatus status={services.eternitas} externalUrl="https://eternitas.ai/get-started" label="Eternitas" />
        </Row>
      </Section>

      <Section title="Legal">
        <Row label="Privacy Policy">
          <button onClick={() => onNavigate?.('privacy')} className="text-xs underline" style={{ color: 'var(--accent)' }}>View</button>
        </Row>
        <Row label="Terms of Service">
          <button onClick={() => onNavigate?.('terms')} className="text-xs underline" style={{ color: 'var(--accent)' }}>View</button>
        </Row>
      </Section>

      <button
        onClick={onLogout}
        className="w-full py-3 rounded-xl text-sm font-medium transition-all"
        style={{ background: 'rgba(248,113,113,0.1)', color: 'var(--danger)' }}
      >
        Sign Out
      </button>
    </div>
  );
}
