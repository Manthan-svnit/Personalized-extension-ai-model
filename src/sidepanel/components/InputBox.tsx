import React, { useState, useRef, useEffect } from 'react';
import { ArrowUp, Globe, ShieldAlert } from 'lucide-react';
import { TabContext } from '../../types/extension';

interface InputBoxProps {
  tabContext: TabContext | null;
  onSendMessage: (text: string) => void;
  disabled?: boolean;
}

export const InputBox: React.FC<InputBoxProps> = ({
  tabContext,
  onSendMessage,
  disabled = false,
}) => {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const displayTabTitle = tabContext?.title?.trim() || 'Active Tab';

  // Auto-resize textarea based on content
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 140)}px`;
    }
  }, [input]);

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || disabled) return;

    onSendMessage(trimmed);
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="p-3 bg-gemini-bg border-t border-gemini-border/70 select-none">
      {/* Context Pill showing target tab name */}
      <div className="mb-2 flex items-center justify-between">
        <div 
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gemini-surface border border-gemini-border text-xs text-gemini-muted max-w-full"
          title={`Active tab: ${tabContext?.url || 'No URL'}`}
        >
          <Globe className="w-3 h-3 text-gemini-blue shrink-0" />
          <span className="truncate max-w-[240px]">
            Sharing &ldquo;<strong className="text-gemini-text font-normal">{displayTabTitle}</strong>&rdquo;
          </span>
        </div>
      </div>

      {/* Floating Textarea Container */}
      <form onSubmit={handleSubmit} className="relative flex items-end">
        <div className="relative w-full rounded-2xl bg-gemini-surface border border-gemini-border focus-within:border-gemini-blue/60 focus-within:ring-1 focus-within:ring-gemini-blue/30 transition-all shadow-inner">
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            placeholder="Ask Keyboard Warriors or draft a prompt..."
            className="w-full resize-none bg-transparent px-4 py-3 pr-12 text-sm text-white placeholder-gemini-muted focus:outline-none max-h-36 leading-relaxed"
          />

          {/* Clean Submit Button (Strictly No Mic/Audio) */}
          <div className="absolute right-2 bottom-2">
            <button
              type="submit"
              disabled={!input.trim() || disabled}
              className={`p-2 rounded-xl flex items-center justify-center transition-all ${
                input.trim() && !disabled
                  ? 'bg-gemini-blue text-white shadow-md shadow-gemini-blue/30 hover:bg-gemini-blue/90 active:scale-95'
                  : 'bg-gemini-elevated text-gemini-muted cursor-not-allowed opacity-50'
              }`}
              aria-label="Send message"
            >
              <ArrowUp className="w-4 h-4 stroke-[2.5]" />
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};
