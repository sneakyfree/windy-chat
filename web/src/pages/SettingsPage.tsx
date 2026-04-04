import { useState } from 'react';

interface SettingsPageProps {
  userId: string | null;
  onLogout: () => void;
}

export default function SettingsPage({ userId, onLogout }: SettingsPageProps) {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [language, setLanguage] = useState('en');
  const [notifications, setNotifications] = useState(true);

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
          <button
            onClick={() => setNotifications(!notifications)}
            className="w-11 h-6 rounded-full relative transition-colors"
            style={{ background: notifications ? 'var(--accent)' : 'var(--bg-tertiary)' }}
          >
            <div
              className="w-5 h-5 rounded-full absolute top-0.5 transition-all"
              style={{
                background: 'white',
                left: notifications ? '22px' : '2px',
              }}
            />
          </button>
        </Row>
      </Section>

      <Section title="Connected Services">
        <Row label="Windy Pro">
          <span className="text-xs px-2 py-1 rounded" style={{ background: 'rgba(52,211,153,0.15)', color: 'var(--success)' }}>Connected</span>
        </Row>
        <Row label="Windy Mail">
          <span className="text-xs px-2 py-1 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>Not connected</span>
        </Row>
        <Row label="Windy Cloud">
          <span className="text-xs px-2 py-1 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>Not connected</span>
        </Row>
        <Row label="Eternitas">
          <span className="text-xs px-2 py-1 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>Not connected</span>
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
