import React from 'react';
import { RotateCw, Trash2, ShieldCheck, Sparkles } from 'lucide-react';

interface HeaderProps {
  onRefreshContext: () => void;
  onClearChat: () => void;
  isRefreshing?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  onRefreshContext,
  onClearChat,
  isRefreshing = false,
}) => {
  return (
    <header className="flex items-center justify-between px-4 py-3 border-b border-gemini-border bg-gemini-bg/95 backdrop-blur-md sticky top-0 z-30 select-none">
      {/* Title & Brand */}
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-gemini-blue via-gemini-purple to-gemini-pink flex items-center justify-center shadow-lg shadow-gemini-purple/20">
          <Sparkles className="w-4 h-4 text-white" />
        </div>
        <div>
          <h1 className="text-sm font-semibold tracking-tight text-white flex items-center gap-1.5">
            Keyboard Warriors
          </h1>
          <div className="flex items-center gap-1 text-[11px] text-emerald-400 font-medium">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span>🔒 Local Privacy Active</span>
          </div>
        </div>
      </div>

      {/* Minimal Action Buttons */}
      <div className="flex items-center gap-1">
        <button
          onClick={onRefreshContext}
          disabled={isRefreshing}
          title="Refresh active tab context"
          className="p-1.5 rounded-lg text-gemini-muted hover:text-white hover:bg-gemini-surface active:scale-95 transition-all disabled:opacity-50"
          aria-label="Refresh Tab Context"
        >
          <RotateCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-gemini-blue' : ''}`} />
        </button>

        <button
          onClick={onClearChat}
          title="Clear conversation"
          className="p-1.5 rounded-lg text-gemini-muted hover:text-white hover:bg-gemini-surface active:scale-95 transition-all"
          aria-label="Clear Conversation"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
