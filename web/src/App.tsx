import { useState, useCallback } from 'react';
import { useAuth } from './hooks/useAuth';
import LandingPage from './pages/LandingPage';
import LoginPage from './pages/LoginPage';
import ChatPage from './pages/ChatPage';
import SocialPage from './pages/SocialPage';
import ContactsPage from './pages/ContactsPage';
import SettingsPage from './pages/SettingsPage';

type View = 'chat' | 'social' | 'contacts' | 'settings';
type AuthScreen = 'landing' | 'signin' | 'register';

function NavButton({ icon, label, active, onClick, badge }: {
  icon: string; label: string; active: boolean; onClick: () => void; badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-xl transition-all relative"
      style={{
        color: active ? 'var(--accent)' : 'var(--text-secondary)',
        background: active ? 'rgba(124,92,255,0.1)' : 'transparent',
      }}
    >
      <span className="text-lg leading-none">{icon}</span>
      <span className="text-[10px] font-medium">{label}</span>
      {badge != null && badge > 0 && (
        <span className="absolute -top-0.5 right-1 w-4 h-4 rounded-full text-[9px] flex items-center justify-center text-white"
              style={{ background: 'var(--danger)' }}>
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </button>
  );
}

export default function App() {
  const { auth, login, logout } = useAuth();
  const [view, setView] = useState<View>('chat');
  const [authScreen, setAuthScreen] = useState<AuthScreen>('landing');

  const handleLogin = useCallback(async (jwt: string) => {
    await login(jwt);
  }, [login]);

  // ── Unauthenticated: Landing → SignIn/Register ──
  if (!auth.isLoggedIn) {
    if (authScreen === 'landing') {
      return (
        <LandingPage
          onSignIn={() => setAuthScreen('signin')}
          onRegister={() => setAuthScreen('register')}
        />
      );
    }
    return (
      <LoginPage
        onLogin={handleLogin}
        mode={authScreen === 'register' ? 'register' : 'signin'}
        onToggleMode={() => setAuthScreen(s => s === 'signin' ? 'register' : 'signin')}
        onBack={() => setAuthScreen('landing')}
      />
    );
  }

  // ── Authenticated: Main App ──
  return (
    <div className="flex flex-col md:flex-row h-screen" style={{ background: 'var(--bg-primary)' }}>
      {/* Desktop Navigation Rail (left side, hidden on mobile) */}
      <nav className="hidden md:flex w-16 shrink-0 flex-col items-center py-4 gap-2 border-r"
           style={{ borderColor: 'var(--bg-tertiary)', background: 'var(--bg-secondary)' }}>
        <div className="text-2xl mb-4 cursor-pointer" onClick={() => setView('chat')}>🌪️</div>
        <NavButton icon="💬" label="Chat" active={view === 'chat'} onClick={() => setView('chat')} />
        <NavButton icon="📝" label="Social" active={view === 'social'} onClick={() => setView('social')} />
        <NavButton icon="👥" label="Contacts" active={view === 'contacts'} onClick={() => setView('contacts')} />
        <div className="flex-1" />
        <NavButton icon="⚙️" label="Settings" active={view === 'settings'} onClick={() => setView('settings')} />
      </nav>

      {/* Main Content */}
      <main className="flex-1 min-w-0 min-h-0">
        {view === 'chat' && <ChatPage userId={auth.matrixUserId} />}
        {view === 'social' && <SocialPage userId={auth.userId} />}
        {view === 'contacts' && <ContactsPage userId={auth.userId} />}
        {view === 'settings' && <SettingsPage userId={auth.userId} onLogout={logout} />}
      </main>

      {/* Mobile Bottom Tabs (visible on mobile only) */}
      <nav className="flex md:hidden items-center justify-around py-2 border-t safe-bottom"
           style={{ borderColor: 'var(--bg-tertiary)', background: 'var(--bg-secondary)' }}>
        <NavButton icon="💬" label="Chat" active={view === 'chat'} onClick={() => setView('chat')} />
        <NavButton icon="📝" label="Social" active={view === 'social'} onClick={() => setView('social')} />
        <NavButton icon="👥" label="Contacts" active={view === 'contacts'} onClick={() => setView('contacts')} />
        <NavButton icon="⚙️" label="Settings" active={view === 'settings'} onClick={() => setView('settings')} />
      </nav>
    </div>
  );
}
