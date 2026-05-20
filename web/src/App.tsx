import { useState, useCallback, useEffect } from 'react';
import { useAuth } from './hooks/useAuth';
import LandingPage from './pages/LandingPage';
import LoginPage from './pages/LoginPage';
import ChatPage from './pages/ChatPage';
import SocialPage from './pages/SocialPage';
import ContactsPage from './pages/ContactsPage';
import DiscoverPage from './pages/DiscoverPage';
import SettingsPage from './pages/SettingsPage';
import PrivacyPage from './pages/PrivacyPage';
import TermsPage from './pages/TermsPage';
import WelcomeOverlay from './components/WelcomeOverlay';
import MailPanel from './components/MailPanel';

type View = 'chat' | 'social' | 'contacts' | 'discover' | 'settings' | 'privacy' | 'terms';
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
  const [showWelcome, setShowWelcome] = useState(false);
  const [mailOpen, setMailOpen] = useState(false);
  const [mailCompose, setMailCompose] = useState<{ body?: string; to?: string } | null>(null);

  const handleLogin = useCallback(async (jwt: string) => {
    const state = await login(jwt);
    // Show welcome for new users (no previous session)
    if (state.isLoggedIn && !localStorage.getItem('windy_chat_onboarded')) {
      setShowWelcome(true);
      localStorage.setItem('windy_chat_onboarded', '1');
    }
  }, [login]);

  // Check if user arrived from windy go (hatch flow) — skip to agent DM
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const agentRoom = params.get('agent_room');
    if (agentRoom && auth.isLoggedIn) {
      setView('chat');
      // The ChatPage will pick up the room from the URL param
    }
  }, [auth.isLoggedIn]);

  // SSO handoff from the ecosystem dashboard. When a logged-in user
  // clicks "Open Windy Chat" on the Windy Word dashboard, the
  // dashboard appends `#token=<pro_jwt>` to the URL so this app can
  // skip the login screen and exchange the Pro JWT for a Matrix
  // access_token directly. The fragment is stripped from the URL
  // immediately so it doesn't linger in history.
  //
  // This is a tactical bridge while account.windyword.ai/oauth/authorize
  // (the proper OAuth endpoint, currently 404) is in-flight. URL
  // fragments aren't sent to servers, so the JWT stays browser-local.
  // Pro JWTs are short-lived (15min TTL per the account-server config),
  // so brief exposure in browser history is an acceptable trade.
  useEffect(() => {
    if (auth.isLoggedIn) return;
    const hash = window.location.hash;
    if (!hash || !hash.startsWith('#')) return;
    const params = new URLSearchParams(hash.slice(1));
    const token = params.get('token');
    if (!token) return;
    // Clear the fragment immediately so the JWT doesn't sit in history
    // longer than necessary.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    // Hand off to the normal login flow — calls unifiedLogin internally
    // and stores the Matrix access_token.
    handleLogin(token).catch((err) => {
      console.warn('SSO handoff failed; falling back to login screen', err);
    });
  }, [auth.isLoggedIn, handleLogin]);

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
      {/* Desktop Navigation Rail */}
      <nav className="hidden md:flex w-16 shrink-0 flex-col items-center py-4 gap-2 border-r"
           style={{ borderColor: 'var(--bg-tertiary)', background: 'var(--bg-secondary)' }}>
        <div className="text-2xl mb-4 cursor-pointer" onClick={() => setView('chat')}>🌪️</div>
        <NavButton icon="💬" label="Chat" active={view === 'chat'} onClick={() => setView('chat')} />
        <NavButton icon="📝" label="Social" active={view === 'social'} onClick={() => setView('social')} />
        <NavButton icon="🪰" label="Discover" active={view === 'discover'} onClick={() => setView('discover')} />
        <NavButton icon="👥" label="Contacts" active={view === 'contacts'} onClick={() => setView('contacts')} />
        <NavButton icon="✉️" label="Mail" active={mailOpen} onClick={() => { setMailCompose(null); setMailOpen(true); }} />
        <div className="flex-1" />
        <NavButton icon="⚙️" label="Settings" active={view === 'settings'} onClick={() => setView('settings')} />
      </nav>

      {/* Main Content */}
      <main className="flex-1 min-w-0 min-h-0">
        {view === 'chat' && <ChatPage userId={auth.matrixUserId} onEmailMessage={(body, to) => { setMailCompose({ body, to }); setMailOpen(true); }} onNavigate={setView} />}
        {view === 'social' && <SocialPage userId={auth.userId} onNavigateToChat={() => setView('chat')} />}
        {view === 'discover' && <DiscoverPage onNavigateToChat={() => setView('chat')} />}
        {view === 'contacts' && <ContactsPage userId={auth.userId} />}
        {view === 'settings' && <SettingsPage userId={auth.userId} onLogout={logout} onNavigate={(v: string) => setView(v as View)} />}
        {view === 'privacy' && <PrivacyPage />}
        {view === 'terms' && <TermsPage />}
      </main>

      {/* Mobile Bottom Tabs */}
      <nav className="flex md:hidden items-center justify-around py-2 border-t"
           style={{ borderColor: 'var(--bg-tertiary)', background: 'var(--bg-secondary)' }}>
        <NavButton icon="💬" label="Chat" active={view === 'chat'} onClick={() => setView('chat')} />
        <NavButton icon="📝" label="Social" active={view === 'social'} onClick={() => setView('social')} />
        <NavButton icon="🪰" label="Discover" active={view === 'discover'} onClick={() => setView('discover')} />
        <NavButton icon="👥" label="Contacts" active={view === 'contacts'} onClick={() => setView('contacts')} />
        <NavButton icon="✉️" label="Mail" active={mailOpen} onClick={() => { setMailCompose(null); setMailOpen(true); }} />
        <NavButton icon="⚙️" label="Settings" active={view === 'settings'} onClick={() => setView('settings')} />
      </nav>

      {/* Mail slide-over panel */}
      <MailPanel open={mailOpen} onClose={() => setMailOpen(false)} compose={mailCompose} />

      {/* Welcome overlay for new users (Task 3) */}
      {showWelcome && (
        <WelcomeOverlay
          displayName={auth.displayName}
          onDismiss={() => setShowWelcome(false)}
          onNavigate={(v) => { setShowWelcome(false); setView(v as View); }}
        />
      )}
    </div>
  );
}
