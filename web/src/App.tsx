import { useState, useCallback } from 'react';
import { useAuth } from './hooks/useAuth';
import LoginPage from './pages/LoginPage';
import ChatPage from './pages/ChatPage';
import SocialPage from './pages/SocialPage';
import ProfilePage from './pages/ProfilePage';
import SettingsPage from './pages/SettingsPage';

type View = 'chat' | 'social' | 'profile' | 'settings';

function NavButton({ icon, label, active, onClick }: { icon: string; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-1 px-4 py-2 rounded-xl transition-all"
      style={{
        color: active ? 'var(--accent)' : 'var(--text-secondary)',
        background: active ? 'rgba(124,92,255,0.1)' : 'transparent',
      }}
    >
      <span className="text-lg">{icon}</span>
      <span className="text-[10px] font-medium">{label}</span>
    </button>
  );
}

export default function App() {
  const { auth, login, logout } = useAuth();
  const [view, setView] = useState<View>('chat');

  const handleLogin = useCallback(async (jwt: string) => {
    await login(jwt);
  }, [login]);

  if (!auth.isLoggedIn) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <div className="flex h-screen" style={{ background: 'var(--bg-primary)' }}>
      {/* Navigation Rail (left) */}
      <nav className="w-16 shrink-0 flex flex-col items-center py-4 gap-2 border-r"
           style={{ borderColor: 'var(--bg-tertiary)', background: 'var(--bg-secondary)' }}>
        {/* Logo */}
        <div className="text-2xl mb-4 cursor-pointer" onClick={() => setView('chat')}>🌪️</div>

        <NavButton icon="💬" label="Chat" active={view === 'chat'} onClick={() => setView('chat')} />
        <NavButton icon="📝" label="Social" active={view === 'social'} onClick={() => setView('social')} />
        <NavButton icon="👤" label="Profile" active={view === 'profile'} onClick={() => setView('profile')} />

        <div className="flex-1" />

        <NavButton icon="⚙️" label="Settings" active={view === 'settings'} onClick={() => setView('settings')} />
      </nav>

      {/* Main Content */}
      <main className="flex-1 min-w-0">
        {view === 'chat' && <ChatPage userId={auth.matrixUserId} />}
        {view === 'social' && <SocialPage userId={auth.userId} />}
        {view === 'profile' && <ProfilePage userId={auth.userId} />}
        {view === 'settings' && <SettingsPage userId={auth.userId} onLogout={logout} />}
      </main>
    </div>
  );
}
