import React from 'react';
import {
  Inbox, Star, Clock, Send, FileText, AlertTriangle, Trash2,
  Bot, MessageSquare, ShieldCheck, Mic, Sparkles, CheckCircle2,
  Bookmark, Mail, Bell
} from 'lucide-react';

export default function Sidebar({
  activeView,
  setActiveView,
  activeFolder,
  setActiveFolder,
  selectedCategory,
  setSelectedCategory,
  unreadCount = 12,
  urgentCount = 5,
  folderCounts = {},
  user,
  onOpenAISummary,
  onOpenPhishingCenter,
  onOpenSmartReply,
  onOpenVoiceCommand,
  onOpenReminders,
  reminderCount = 0,
  isOpen = false,
  onClose
}) {
  const folders = [
    { id: 'all', label: 'All Mail', icon: Mail, count: folderCounts.all, badgeColor: 'bg-slate-700 text-white' },
    { id: 'inbox', label: 'Inbox', icon: Inbox, count: folderCounts.inbox ?? unreadCount, badgeColor: 'bg-indigo-600 text-white' },
    { id: 'important', label: 'Important', icon: Bookmark, count: folderCounts.urgent ?? urgentCount, badgeColor: 'bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300' },
    { id: 'snoozed', label: 'Snoozed', icon: Clock },
    { id: 'sent', label: 'Sent', icon: Send, count: folderCounts.sent },
    { id: 'drafts', label: 'Drafts', icon: FileText, count: folderCounts.drafts },
    { id: 'spam', label: 'Spam', icon: AlertTriangle, count: folderCounts.spam, badgeColor: 'bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300' },
    { id: 'trash', label: 'Trash', icon: Trash2, count: folderCounts.trash },
  ];

  const userEmail = user?.email || "user@gmail.com";

  return (
    <>
    {isOpen && (
      <button
        className="fixed inset-0 z-40 bg-slate-950/45 md:hidden"
        onClick={onClose}
        aria-label="Close navigation menu"
      />
    )}
    <aside className={`${isOpen ? 'translate-x-0' : '-translate-x-full'} fixed inset-y-0 left-0 z-50 flex h-[100dvh] w-[min(18rem,85vw)] shrink-0 flex-col justify-between border-r border-slate-200 bg-white p-3 transition-transform duration-200 dark:border-slate-800/80 dark:bg-[#0B0F19] md:static md:z-auto md:h-auto md:w-64 md:translate-x-0`}>
      <div className="space-y-6 overflow-y-auto pr-1">
        
        {/* Mailboxes Section */}
        <div>
          <nav className="space-y-1">
            {folders.map((folder) => {
              const Icon = folder.icon;
              const isActive = activeView === 'inbox' && activeFolder === folder.id && !selectedCategory;
              return (
                <button
                  key={folder.id}
                  onClick={() => {
                    setActiveView('inbox');
                    setActiveFolder(folder.id);
                    setSelectedCategory(null);
                    onClose?.();
                  }}
                  className={`w-full flex items-center justify-between px-3.5 py-2 rounded-xl text-xs font-semibold transition ${
                    isActive
                      ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/20'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-3">
                    <Icon className={`w-4 h-4 ${isActive ? 'text-white' : 'text-slate-500 dark:text-slate-400'}`} />
                    <span>{folder.label}</span>
                  </div>
                  {folder.count !== undefined && folder.count > 0 && (
                    <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full ${isActive ? 'bg-white/20 text-white' : (folder.badgeColor || 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300')}`}>
                      {folder.count}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* AI Tools Section */}
        <div>
          <div className="px-3 pb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
            AI Tools
          </div>
          <nav className="space-y-1">
            <button
              onClick={onOpenAISummary}
              className="w-full flex items-center space-x-3 px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 hover:text-indigo-600 dark:hover:text-indigo-300 transition"
            >
              <Bot className="w-4 h-4 text-indigo-500" />
              <span>Summarize</span>
            </button>

            <button
              onClick={onOpenSmartReply}
              className="w-full flex items-center space-x-3 px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-purple-50 dark:hover:bg-purple-950/40 hover:text-purple-600 dark:hover:text-purple-300 transition"
            >
              <MessageSquare className="w-4 h-4 text-purple-500" />
              <span>Reply Assistant</span>
            </button>

            <button
              onClick={onOpenPhishingCenter}
              className="w-full flex items-center space-x-3 px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 hover:text-rose-600 dark:hover:text-rose-300 transition"
            >
              <ShieldCheck className="w-4 h-4 text-rose-500" />
              <span>Phishing Detection</span>
            </button>

            <button
              onClick={onOpenVoiceCommand}
              className="w-full flex items-center space-x-3 px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 hover:text-blue-600 dark:hover:text-blue-300 transition"
            >
              <Mic className="w-4 h-4 text-blue-500" />
              <span>Voice Command</span>
            </button>

            <button
              onClick={onOpenReminders}
              className="w-full flex items-center space-x-3 px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 hover:text-emerald-600 dark:hover:text-emerald-300 transition"
            >
              <Bell className="w-4 h-4 text-emerald-500" />
              <span className="flex-1 text-left">Reminders</span>
              {reminderCount > 0 && (
                <span className="rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                  {reminderCount}
                </span>
              )}
            </button>
          </nav>
        </div>
      </div>

      {/* Connected Account Footer */}
      <div className="pt-3 border-t border-slate-200 dark:border-slate-800">
        <div className="flex items-center space-x-2 px-2 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 text-[11px] font-medium text-slate-600 dark:text-slate-300">
          <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
          </svg>
          <span className="truncate flex-1 font-mono text-[10px]">{userEmail}</span>
          <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" title="Connected"></span>
        </div>
      </div>
    </aside>
    </>
  );
}
