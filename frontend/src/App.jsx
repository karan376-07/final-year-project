import React, { useState, useEffect, useRef } from 'react';
import Navbar from './components/Navbar';
import Sidebar from './components/Sidebar';
import EmailList from './components/EmailList';
import EmailDetail from './components/EmailDetail';
import AIAssistantPanel from './components/AIAssistantPanel';
import VoiceCommandModal from './components/VoiceCommandModal';
import PhishingDetectionModal from './components/PhishingDetectionModal';
import ReminderPanel from './components/ReminderPanel';
import ReminderModal from './components/ReminderModal';
import AISummaryModal from './components/AISummaryModal';
import OCRScanner from './components/OCRScanner';
import AnalyticsDashboard from './components/AnalyticsDashboard';
import ComposeModal from './components/ComposeModal';
import SettingsModal from './components/SettingsModal';
import LandingPage from './pages/LandingPage';
import LoginPage from './pages/LoginPage';
import { emailsAPI, authAPI, remindersAPI } from './services/api';
import { parseVoiceCommand } from './utils/voiceCommands';

export default function App() {
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem('smart_email_user');
    return saved ? JSON.parse(saved) : null;
  });

  const [showLandingPage, setShowLandingPage] = useState(() => (
    !Boolean(localStorage.getItem('smart_email_user'))
  ));
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [loginError, setLoginError] = useState('');

  // Theme & Language State
  const [theme, setTheme] = useState(() => localStorage.getItem('smart_email_theme') || 'light');
  const [language, setLanguage] = useState(() => localStorage.getItem('smart_email_language') || 'en');

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
      document.documentElement.classList.remove('light');
    } else {
      document.documentElement.classList.remove('dark');
      document.documentElement.classList.add('light');
    }
    localStorage.setItem('smart_email_theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => (prev === 'dark' ? 'light' : 'dark'));
  };

  const toggleLanguage = () => {
    const nextLang = language === 'en' ? 'ta' : 'en';
    setLanguage(nextLang);
    localStorage.setItem('smart_email_language', nextLang);
    showToast(nextLang === 'ta' ? "மொழி தமிழாக மாற்றப்பட்டது (Tamil Language Active)" : "Language switched to English");
  };

  // View States
  const [activeView, setActiveView] = useState('inbox');
  const [activeFolder, setActiveFolder] = useState('all');
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  // Reminders: the badge count lives here so the sidebar can render it without
  // the panel being mounted, and the panel pushes updates back up after a
  // reminder is set, completed or dismissed.
  const [isRemindersOpen, setIsRemindersOpen] = useState(false);
  const [reminderCount, setReminderCount] = useState(0);
  // Which message the "remind me" dialog is open for, and any reminder already
  // on it so the dialog opens in edit mode rather than creating a duplicate.
  const [reminderTarget, setReminderTarget] = useState(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Email Data
  const [emails, setEmails] = useState([]);
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [isLoadingEmails, setIsLoadingEmails] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [serverCounts, setServerCounts] = useState(null);
  const initialSyncStarted = useRef(false);

  // Modals & Feature Dialogs
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAISummaryOpen, setIsAISummaryOpen] = useState(false);
  const [summaryEmails, setSummaryEmails] = useState([]);
  const [isPhishingOpen, setIsPhishingOpen] = useState(false);
  const [isVoiceCommandOpen, setIsVoiceCommandOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState(null);

  const showToast = (msg) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  const loadCounts = async () => {
    try {
      const counts = await emailsAPI.getCounts();
      if (counts) setServerCounts(counts);
    } catch (e) {
      console.error("Failed to fetch counts:", e);
    }
  };

  // Sidebar badge. Best-effort: a failure here must not break the mailbox, and
  // the ReminderPanel surfaces real errors when it is actually open.
  useEffect(() => {
    let cancelled = false;
    remindersAPI.getPendingCount()
      .then((n) => { if (!cancelled) setReminderCount(n); })
      .catch(() => { if (!cancelled) setReminderCount(0); });
    return () => { cancelled = true; };
  }, [activeUser?.email]);

  // Fetch emails from API backend
  const loadEmails = async (overrideFolder = null) => {
    setIsLoadingEmails(true);
    const targetFolder = overrideFolder || activeFolder;
    try {
      const data = await emailsAPI.getEmails({
        folder: targetFolder,
        category: selectedCategory,
        search: searchQuery || undefined,
      });
      const nextEmails = Array.isArray(data) ? data : [];
      setEmails(nextEmails);
      if (nextEmails.length > 0) {
        if (!selectedEmail || !nextEmails.some(e => e.id === selectedEmail.id)) {
          setSelectedEmail(nextEmails[0]);
        }
      }
      await loadCounts();
    } catch (e) {
      console.error('Failed to load emails:', e);
    } finally {
      setIsLoadingEmails(false);
    }
  };

  useEffect(() => {
    if (activeView === 'inbox') {
      loadEmails();
    }
  }, [user, activeFolder, selectedCategory, searchQuery, activeView]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!user || initialSyncStarted.current || params.has('token') || params.has('error')) return;

    initialSyncStarted.current = true;
    setIsSyncing(true);
    emailsAPI.syncInbox()
      .then(async (result) => {
        await loadEmails('all');
        await loadCounts();
        if (result?.status === 'success') {
          showToast(result.message || 'Inbox synchronized with Gmail.');
        }
      })
      .catch((error) => {
        const detail = error.response?.data?.detail || error.message || 'Unknown Gmail error';
        if (error.response?.status === 401) {
          localStorage.removeItem('smart_email_token');
          localStorage.removeItem('smart_email_user');
          setUser(null);
          setShowLandingPage(true);
          setShowLoginModal(true);
          setLoginError('Your session expired. Sign in with Google again.');
          return;
        }
        showToast(`Gmail sync failed: ${detail}`);
      })
      .finally(() => setIsSyncing(false));
  }, []);

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      const res = await emailsAPI.syncInbox();
      await loadEmails();
      await loadCounts();
      showToast(res?.message || "Inbox synchronized with AI categorization!");
    } catch (e) {
      const detail = e.response?.data?.detail || e.message || "Unknown Gmail error";
      console.error("Gmail sync failed:", detail, e);
      showToast(detail.includes("Gmail API has not been used")
        ? "Enable the Gmail API in your Google Cloud project, then retry."
        : `Gmail sync failed: ${detail}`);
    } finally {
      setIsSyncing(false);
    }
  };

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');
    const error = urlParams.get('error');
    if (token) {
      localStorage.setItem('smart_email_token', token);
      window.history.replaceState({}, document.title, '/');
      authAPI.getMe().then((userData) => {
        if (!userData?.email) {
          throw new Error('The returned session did not include a user profile.');
        }
        return handleLoginSuccess(userData);
      }).catch((e) => {
        console.error("Error loading user profile:", e);
        localStorage.removeItem('smart_email_token');
        localStorage.removeItem('smart_email_user');
        setUser(null);
        setShowLandingPage(true);
        setShowLoginModal(true);
        setLoginError(e.response?.data?.detail || 'Google sign-in returned, but the session could not be validated. Check the Supabase FRONTEND_URL and API configuration.');
      });
    } else if (error) {
      setShowLandingPage(true);
      setShowLoginModal(true);
      const callbackErrors = {
        access_denied: 'Google sign-in was canceled before consent completed. Start again and approve the requested access.',
        auth_failed: 'Google returned to the app, but the backend could not exchange the authorization code. Check GOOGLE_CLIENT_SECRET and confirm the registered redirect URI exactly matches the configured callback.',
        invalid_client: 'Google rejected the OAuth client credentials. Confirm GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET belong to the same OAuth client.',
        invalid_grant: 'Google rejected the authorization code. Check the exact redirect URI and restart sign-in; authorization codes expire and can only be used once.',
        invalid_request: 'Google rejected the token request. Confirm the configured redirect URI exactly matches the URI used to start sign-in.',
        oauth_not_configured: 'Google OAuth is not configured on the local API. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then restart the backend.',
        token_exchange_failed: 'Google could not exchange the authorization code. Check the OAuth client secret and exact redirect URI.',
        unauthorized_client: 'This OAuth client is not allowed to use the requested sign-in flow. Check its Google Cloud OAuth settings.',
        userinfo_failed: 'Google sign-in succeeded, but Google did not return the account profile. Check the requested email/profile scopes.',
        callback_error: 'The local OAuth callback failed unexpectedly. Check the backend terminal for its diagnostic message.',
        cancelled: 'Google sign-in was canceled before consent completed. Start again and approve the requested access.',
      };
      setLoginError(callbackErrors[error] || `Google sign-in failed (${error}). Check the OAuth client configuration and try again.`);
      window.history.replaceState({}, document.title, '/');
    }
  }, []);

  const handleLoginSuccess = async (userObj) => {
    setUser(userObj);
    localStorage.setItem('smart_email_user', JSON.stringify(userObj));
    setShowLandingPage(false);
    setShowLoginModal(false);
    setIsSyncing(true);
    try {
      await emailsAPI.syncInbox();
      await loadEmails('all');
      await loadCounts();
      showToast(`Welcome back, ${userObj.name || 'User'}! Inbox synchronized.`);
    } catch (error) {
      const detail = error.response?.data?.detail || error.message || "Unknown Gmail error";
      console.error('Initial inbox sync failed:', detail, error);
      await loadEmails('all');
      await loadCounts();
      showToast(detail.includes("Gmail API has not been used")
        ? "Signed in. Enable the Gmail API in Google Cloud, then retry Sync."
        : `Signed in, but Gmail sync failed: ${detail}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleLogout = () => {
    authAPI.logout();
    localStorage.removeItem('smart_email_user');
    localStorage.removeItem('smart_email_token');
    setUser(null);
    setEmails([]);
    setSelectedEmail(null);
    setShowLandingPage(true);
    setShowLoginModal(true);
    showToast("Signed out successfully.");
  };

  const handleExecuteVoiceCommand = async (cmdText) => {
    const command = parseVoiceCommand(cmdText);
    if (command.type === 'empty' || command.type === 'unknown') {
      showToast("I couldn't match that command. Try a folder, search, summary, or reply request.");
      return;
    }

    setActiveView('inbox');
    if (command.type === 'folder') {
      setActiveFolder(command.folder);
      setSelectedCategory(null);
      setSearchQuery('');
      setMobileDetailOpen(false);
      showToast(`Showing ${command.folder === 'all' ? 'all mail' : command.folder} emails.`);
      return;
    }

    if (command.type === 'search') {
      setActiveFolder('all');
      setSelectedCategory(null);
      setSearchQuery(command.query);
      setMobileDetailOpen(false);
      showToast(`Searching emails for "${command.query}".`);
      return;
    }

    if (command.type === 'phishing') {
      setIsPhishingOpen(true);
      return;
    }

    if (command.type === 'summarize') {
      try {
        const mailboxEmails = await emailsAPI.getEmails({ folder: 'all' });
        setSummaryEmails(mailboxEmails);
        setIsAISummaryOpen(true);
      } catch (error) {
        console.error('Could not load email for voice summary:', error);
        showToast('Could not load your email for a summary. Please try again.');
      }
      return;
    }

    if (command.type === 'reply' || command.type === 'open-selected') {
      if (!selectedEmail) {
        showToast('Open an email first, then ask me to reply or read it.');
        return;
      }
      setMobileDetailOpen(true);
      showToast(command.type === 'reply' ? 'Opened the selected email to reply.' : 'Opened the selected email.');
    }
  };

  const activeUser = user;

  const folderCounts = {
    all: serverCounts?.all ?? emails.length,
    inbox: serverCounts?.inbox ?? emails.filter(e => e.folder === 'inbox').length,
    urgent: serverCounts?.urgent ?? emails.filter(e => e.priority === 'High' || e.is_starred).length,
    sent: serverCounts?.sent ?? emails.filter(e => e.folder === 'sent').length,
    drafts: serverCounts?.drafts ?? 0,
    spam: serverCounts?.spam ?? emails.filter(e => e.folder === 'spam' || e.is_spam).length,
    trash: serverCounts?.trash ?? emails.filter(e => e.folder === 'trash' || e.is_trash).length,
  };

  if (showLandingPage && !user) {
    if (showLoginModal) {
      return <LoginPage onLoginSuccess={handleLoginSuccess} authError={loginError} />;
    }
    return (
      <LandingPage
        onConnectGmail={() => setShowLoginModal(true)}
        onQuickAccess={() => setShowLoginModal(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    );
  }

  return (
    <div className="h-[100dvh] min-h-0 w-full bg-[#F8FAFC] dark:bg-[#090D16] text-slate-800 dark:text-slate-100 flex flex-col overflow-hidden font-sans transition-colors duration-200">
      
      {/* Top Navbar */}
      <Navbar
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        onSync={handleSync}
        isSyncing={isSyncing}
        onOpenCompose={() => setIsComposeOpen(true)}
        onOpenSettings={() => setIsSettingsOpen(true)}
        unreadCount={serverCounts?.unread ?? emails.filter(e => !e.is_read).length}
        urgentCount={serverCounts?.urgent ?? emails.filter(e => e.priority === 'High').length}
        user={activeUser}
        onLogout={handleLogout}
        theme={theme}
        onToggleTheme={toggleTheme}
        language={language}
        onToggleLanguage={toggleLanguage}
        onOpenVoiceCommand={() => setIsVoiceCommandOpen(true)}
        onOpenMenu={() => setMobileSidebarOpen(true)}
      />

      {/* Main 3-Column Workspace Layout */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden pb-[env(safe-area-inset-bottom)]">
        
        {/* Left Sidebar */}
        <Sidebar
          isOpen={mobileSidebarOpen}
          onClose={() => setMobileSidebarOpen(false)}
          activeView={activeView}
          setActiveView={(view) => {
            setActiveView(view);
            setMobileSidebarOpen(false);
            setMobileDetailOpen(false);
          }}
          activeFolder={activeFolder}
          setActiveFolder={(folder) => {
            setActiveFolder(folder);
            setMobileDetailOpen(false);
          }}
          selectedCategory={selectedCategory}
          setSelectedCategory={setSelectedCategory}
          unreadCount={serverCounts?.unread ?? emails.filter(e => !e.is_read).length}
          urgentCount={serverCounts?.urgent ?? emails.filter(e => e.priority === 'High').length}
          folderCounts={folderCounts}
          user={activeUser}
          onOpenAISummary={() => { setIsAISummaryOpen(true); setMobileSidebarOpen(false); }}
          onOpenPhishingCenter={() => { setIsPhishingOpen(true); setMobileSidebarOpen(false); }}
          onOpenSmartReply={() => { showToast("Select an email thread to view AI Smart Reply"); setMobileSidebarOpen(false); }}
          onOpenVoiceCommand={() => { setIsVoiceCommandOpen(true); setMobileSidebarOpen(false); }}
          onOpenReminders={() => { setIsRemindersOpen(true); setMobileSidebarOpen(false); }}
          reminderCount={reminderCount}
        />

        {/* Center Stage Email Workspace */}
        {activeView === 'inbox' && (
          <div className="flex min-w-0 flex-1 overflow-hidden">
            {/* Center Email List Feed */}
            <div className={`${mobileDetailOpen ? 'hidden md:flex' : 'flex'} w-full min-w-0 md:w-[42%] xl:w-[34%] flex-shrink-0 flex-col h-full border-r border-slate-200 dark:border-slate-800/80`}>
              <EmailList
                activeFolder={activeFolder}
                emails={emails}
                selectedEmail={selectedEmail}
                onSelectEmail={(e) => {
                  setSelectedEmail(e);
                  setMobileDetailOpen(true);
                }}
                onToggleStar={async (id) => {
                  await emailsAPI.toggleStar(id);
                  loadEmails();
                }}
                onToggleRead={async (id) => {
                  await emailsAPI.toggleRead(id);
                  loadEmails();
                }}
                onDeleteEmail={async (id) => {
                  await emailsAPI.deleteEmail(id);
                  loadEmails();
                  showToast("Moved to Trash");
                }}
                isLoading={isLoadingEmails}
              />
            </div>

            {/* Email Detail / Smart Reply View */}
            <div className="hidden md:flex min-w-0 flex-1 flex-col h-full border-r border-slate-200 dark:border-slate-800/80">
              <EmailDetail
                email={selectedEmail}
                currentUser={activeUser}
                onBack={() => setMobileDetailOpen(false)}
                onSendReply={async (payload) => {
                  await emailsAPI.composeEmail(payload);
                  loadEmails();
                  showToast(`Reply sent to ${payload.recipient || 'recipient'}!`);
                }}
                language={language}
                onToggleLanguage={toggleLanguage}
                onOpenVoiceCommand={() => setIsVoiceCommandOpen(true)}
              />
            </div>
            {mobileDetailOpen && (
              <div className="absolute inset-0 z-20 flex min-w-0 flex-col bg-[#F8FAFC] dark:bg-[#090D17] md:hidden">
                <EmailDetail
                  email={selectedEmail}
                  currentUser={activeUser}
                  onBack={() => setMobileDetailOpen(false)}
                  onSendReply={async (payload) => {
                    await emailsAPI.composeEmail(payload);
                    await loadEmails();
                    showToast(`Reply sent to ${payload.recipient || 'recipient'}!`);
                  }}
                  language={language}
                  onToggleLanguage={toggleLanguage}
                  onOpenVoiceCommand={() => setIsVoiceCommandOpen(true)}
                />
              </div>
            )}
          </div>
        )}

        {activeView === 'ocr' && (
          <OCRScanner onBack={() => setActiveView('inbox')} />
        )}

        {activeView === 'analytics' && (
          <AnalyticsDashboard onBack={() => setActiveView('inbox')} />
        )}

        {/* Right AI Assistant Widget Column */}
        {activeView === 'inbox' && (
          <AIAssistantPanel
            className="hidden xl:flex"
            user={activeUser}
            totalEmails={serverCounts?.all ?? emails.length}
            importantCount={serverCounts?.important ?? emails.filter(e => e.priority === 'High' || e.is_starred).length}
            unreadCount={serverCounts?.unread ?? emails.filter(e => !e.is_read).length}
            onOpenAISummary={() => setIsAISummaryOpen(true)}
            onOpenPhishingCenter={() => setIsPhishingOpen(true)}
            onOpenSmartReply={() => showToast("Smart Reply assistant active in email detail pane.")}
            onOpenVoiceCommand={() => setIsVoiceCommandOpen(true)}
          />
        )}
      </div>

      {/* Feature Modals & Overlays */}
      {isRemindersOpen && (
        <ReminderPanel
          onCountChange={setReminderCount}
          onOpenEmail={(id) => {
            setIsRemindersOpen(false);
            setActiveFolder('all');
            const match = emails.find((e) => e.id === id);
            if (match) setSelectedEmail(match);
            else showToast('Open the inbox to read that message.');
          }}
        />
      )}

      {reminderTarget && (
        <ReminderModal
          email={reminderTarget}
          existing={reminderTarget.__reminder || null}
          onClose={() => setReminderTarget(null)}
          onSaved={() => {
            setReminderTarget(null);
            remindersAPI.getPendingCount()
              .then(setReminderCount)
              .catch(() => {
                /* the badge is best-effort; the panel reports real errors */
              });
          }}
        />
      )}

      <VoiceCommandModal
        isOpen={isVoiceCommandOpen}
        onClose={() => setIsVoiceCommandOpen(false)}
        onExecuteCommand={handleExecuteVoiceCommand}
        language={language}
      />

      <PhishingDetectionModal
        isOpen={isPhishingOpen}
        onClose={() => setIsPhishingOpen(false)}
        onMarkAsSpam={() => showToast("Email marked as phishing spam.")}
      />

      <AISummaryModal
        isOpen={isAISummaryOpen}
        onClose={() => setIsAISummaryOpen(false)}
        emails={summaryEmails}
      />

      <ComposeModal
        isOpen={isComposeOpen}
        onClose={() => setIsComposeOpen(false)}
        onEmailSent={async (sentEmail) => {
          await loadEmails();
          showToast("Email sent successfully!");
        }}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        user={activeUser}
        theme={theme}
        onToggleTheme={toggleTheme}
        onLogout={handleLogout}
      />

      {/* Toast Alert */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 bg-slate-900 border border-indigo-500/50 text-white text-xs font-semibold px-4 py-3 rounded-2xl shadow-2xl flex items-center space-x-2 animate-fade-in animate-slide-in-from-bottom-3">
          <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
          <span>{toastMessage}</span>
        </div>
      )}
    </div>
  );
}
