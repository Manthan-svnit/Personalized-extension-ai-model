import React, { useEffect, useRef } from 'react';
import { ChatMessage } from '../../types/extension';
import { Sparkles, Shield, Copy, Check, FileText, Lock, EyeOff } from 'lucide-react';

interface ChatThreadProps {
  messages: ChatMessage[];
  isProcessing: boolean;
  onSelectPrompt: (promptText: string) => void;
}

export const ChatThread: React.FC<ChatThreadProps> = ({
  messages,
  isProcessing,
  onSelectPrompt,
}) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [copiedId, setCopiedId] = React.useState<string | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isProcessing]);

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const starterPrompts = [
    {
      title: 'Summarize page safely',
      desc: 'Strip sensitive data and summarize active tab locally',
      icon: <FileText className="w-4 h-4 text-gemini-blue" />,
      action: 'Summarize this page content without exposing sensitive information.',
    },
    {
      title: 'Audit page security',
      desc: 'Inspect HTTPS status, trackers & form risks',
      icon: <Lock className="w-4 h-4 text-emerald-400" />,
      action: 'Run a security and privacy audit on the current URL.',
    },
    {
      title: 'Scrub PII from text',
      desc: 'Mask emails, tokens, keys & phone numbers',
      icon: <EyeOff className="w-4 h-4 text-gemini-purple" />,
      action: 'Scan the active page selection for PII and redact all sensitive entities.',
    },
  ];

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
      {messages.length === 0 ? (
        <div className="h-full flex flex-col justify-center items-center text-center max-w-sm mx-auto my-auto pt-6 select-none">
          <div className="w-12 h-12 rounded-2xl bg-gemini-surface border border-gemini-border flex items-center justify-center mb-4 shadow-xl shadow-gemini-purple/5">
            <Sparkles className="w-6 h-6 text-gemini-purple animate-pulse" />
          </div>

          <h2 className="text-xl font-semibold tracking-tight text-white mb-1">
            <span className="gemini-gradient-text">Private AI Assistant</span>
          </h2>
          <p className="text-xs text-gemini-muted mb-8 leading-relaxed max-w-xs">
            Zero-leakage browser copilot. Content is sanitized in an offscreen sandboxed runtime before processing.
          </p>

          <div className="w-full space-y-2.5 text-left">
            {starterPrompts.map((item, idx) => (
              <button
                key={idx}
                onClick={() => onSelectPrompt(item.action)}
                className="w-full p-3 rounded-xl bg-gemini-surface/60 hover:bg-gemini-surface border border-gemini-border/70 hover:border-gemini-blue/40 transition-all text-left group flex items-start gap-3"
              >
                <div className="p-2 rounded-lg bg-gemini-elevated border border-gemini-border/50 group-hover:scale-105 transition-transform">
                  {item.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-gemini-text group-hover:text-white transition-colors">
                    {item.title}
                  </div>
                  <div className="text-[11px] text-gemini-muted truncate mt-0.5">
                    {item.desc}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : (
        messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col ${
              msg.role === 'user' ? 'items-end' : 'items-start'
            } space-y-1.5`}
          >
            {/* Sender Badge */}
            {msg.role === 'assistant' && (
              <div className="flex items-center gap-1.5 text-[11px] text-gemini-muted pl-1">
                <Sparkles className="w-3.5 h-3.5 text-gemini-purple" />
                <span className="font-medium text-gemini-text">Keyboard Warriors</span>
                {msg.privacyShieldActive && (
                  <span className="flex items-center gap-0.5 text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded-full text-[10px] font-mono border border-emerald-500/20">
                    <Shield className="w-2.5 h-2.5" /> On-Device
                  </span>
                )}
              </div>
            )}

            {/* Bubble */}
            <div
              className={`relative group max-w-[92%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-gemini-elevated text-white border border-gemini-border rounded-br-sm'
                  : 'bg-gemini-surface/90 text-gemini-text border border-gemini-border/70 rounded-bl-sm shadow-md'
              }`}
            >
              <div className="whitespace-pre-wrap break-words selection:bg-gemini-purple/30">
                {msg.content}
              </div>

              {/* Sanitize badge if entities redacted */}
              {msg.sanitizedEntities && msg.sanitizedEntities.length > 0 && (
                <div className="mt-2.5 pt-2 border-t border-gemini-border/60 flex flex-wrap gap-1">
                  <span className="text-[10px] text-gemini-muted uppercase tracking-wider font-semibold mr-1 flex items-center">
                    Redacted:
                  </span>
                  {msg.sanitizedEntities.map((entity, i) => (
                    <span
                      key={i}
                      className="text-[10px] bg-gemini-elevated text-gemini-muted px-1.5 py-0.5 rounded border border-gemini-border/50"
                    >
                      {entity}
                    </span>
                  ))}
                </div>
              )}

              {/* Action buttons (copy) for assistant */}
              {msg.role === 'assistant' && (
                <div className="mt-2 flex items-center justify-between text-[11px] text-gemini-muted pt-1">
                  <span>{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  <button
                    onClick={() => handleCopy(msg.id, msg.content)}
                    className="p-1 rounded hover:bg-gemini-elevated text-gemini-muted hover:text-white transition-colors"
                    title="Copy response"
                  >
                    {copiedId === msg.id ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))
      )}

      {/* Processing State with glowing shimmer */}
      {isProcessing && (
        <div className="flex flex-col items-start space-y-1.5 pl-1">
          <div className="flex items-center gap-1.5 text-[11px] text-gemini-muted">
            <Sparkles className="w-3.5 h-3.5 text-gemini-blue animate-spin" />
            <span className="font-medium text-gemini-text">Sanitizing & Analyzing...</span>
          </div>
          <div className="w-full max-w-[85%] rounded-2xl p-4 bg-gemini-surface border border-gemini-border/60 rounded-bl-sm">
            <div className="h-3 w-3/4 rounded-full gemini-shimmer mb-2.5" />
            <div className="h-3 w-1/2 rounded-full gemini-shimmer" />
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
};
