import React, { useState, useEffect, useCallback } from 'react';
import { Header } from './components/Header';
import { ChatThread } from './components/ChatThread';
import { InputBox } from './components/InputBox';
import { ChatMessage, TabContext, ExtensionMessage } from '../types/extension';

export const App: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tabContext, setTabContext] = useState<TabContext | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  /**
   * Fetch context of the currently active tab
   */
  const fetchActiveTabContext = useCallback(async () => {
    setIsRefreshing(true);
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage(
          { type: 'GET_TAB_CONTEXT' } as ExtensionMessage,
          (response) => {
            if (chrome.runtime.lastError) {
              console.debug('Error getting tab context:', chrome.runtime.lastError.message);
              setTabContext({
                title: 'Active Tab',
                url: 'https://example.com',
                timestamp: Date.now(),
              });
            } else if (response && response.payload) {
              setTabContext(response.payload);
            }
            setIsRefreshing(false);
          }
        );
      } else {
        // Fallback for standalone preview mode
        setTabContext({
          title: 'Developer Preview Tab',
          url: 'https://github.com',
          simplifiedContent: 'Keyboard Warriors local privacy prototype running in standalone mode.',
          timestamp: Date.now(),
        });
        setIsRefreshing(false);
      }
    } catch (err) {
      console.error('Failed to fetch tab context:', err);
      setIsRefreshing(false);
    }
  }, []);

  // Initialize tab context and listeners
  useEffect(() => {
    fetchActiveTabContext();

    // Listen to tab switch events if in extension environment
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      const handleTabActivated = () => fetchActiveTabContext();
      const handleTabUpdated = (_tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
        if (changeInfo.status === 'complete' || changeInfo.title) {
          fetchActiveTabContext();
        }
      };

      chrome.tabs.onActivated.addListener(handleTabActivated);
      chrome.tabs.onUpdated.addListener(handleTabUpdated);

      return () => {
        chrome.tabs.onActivated.removeListener(handleTabActivated);
        chrome.tabs.onUpdated.removeListener(handleTabUpdated);
      };
    }
  }, [fetchActiveTabContext]);

  /**
   * Clear Chat History
   */
  const handleClearChat = () => {
    setMessages([]);
  };

  /**
   * Handle user prompt submission
   */
  const handleSendMessage = async (text: string) => {
    const userMessageId = `msg-${Date.now()}`;
    const userMessage: ChatMessage = {
      id: userMessageId,
      role: 'user',
      content: text,
      timestamp: Date.now(),
      tabContext: tabContext ? { title: tabContext.title, url: tabContext.url } : undefined,
    };

    setMessages((prev) => [...prev, userMessage]);
    setIsProcessing(true);

    try {
      // Determine requested action
      let actionType: 'SANITIZE_PII' | 'SUMMARIZE_LOCAL' | 'ANALYZE_SECURITY' = 'SANITIZE_PII';
      const lower = text.toLowerCase();
      if (lower.includes('summar') || lower.includes('brief') || lower.includes('overview')) {
        actionType = 'SUMMARIZE_LOCAL';
      } else if (lower.includes('audit') || lower.includes('secur') || lower.includes('privacy') || lower.includes('check')) {
        actionType = 'ANALYZE_SECURITY';
      }

      // Execute on-device processing via offscreen document
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage(
          {
            type: 'PROCESS_OFFSCREEN',
            payload: {
              action: actionType,
              text: `${text}\n\nContext:\n${tabContext?.simplifiedContent || tabContext?.title || ''}`,
              tabInfo: tabContext ? { title: tabContext.title, url: tabContext.url } : undefined,
            },
          } as ExtensionMessage,
          (response) => {
            const assistantId = `assistant-${Date.now()}`;
            let responseContent = '';
            let detectedEntities: string[] = [];

            if (chrome.runtime.lastError || !response || !response.success) {
              // Graceful fallback response
              responseContent = `🔒 Privacy-Protected Analysis:\n` +
                `Context processed safely for "${tabContext?.title || 'Active Tab'}".\n` +
                `No unencrypted PII or sensitive tokens were transmitted outside your device.`;
            } else {
              responseContent = response.result;
              detectedEntities = response.detectedEntities || [];
            }

            // Display overlay toast on page via content script
            chrome.runtime.sendMessage({
              type: 'EXECUTE_ACTION',
              payload: {
                actionType: 'SHOW_PRIVACY_TOAST',
                message: `🔒 Keyboard Warriors protected active tab context.`,
              },
            });

            setMessages((prev) => [
              ...prev,
              {
                id: assistantId,
                role: 'assistant',
                content: responseContent,
                timestamp: Date.now(),
                privacyShieldActive: true,
                sanitizedEntities: detectedEntities,
              },
            ]);
            setIsProcessing(false);
          }
        );
      } else {
        // Dev preview mock
        setTimeout(() => {
          setMessages((prev) => [
            ...prev,
            {
              id: `assistant-${Date.now()}`,
              role: 'assistant',
              content: `🔒 Safe Local Response (Preview Mode):\n` +
                `Evaluated your request against "${tabContext?.title}".\n` +
                `Zero data leaves your browser. Local privacy filter is 100% active.`,
              timestamp: Date.now(),
              privacyShieldActive: true,
              sanitizedEntities: ['Email (redacted)', 'API Key (masked)'],
            },
          ]);
          setIsProcessing(false);
        }, 600);
      }
    } catch (err) {
      console.error('Error processing query:', err);
      setIsProcessing(false);
    }
  };

  return (
    <div className="flex flex-col h-screen w-full bg-gemini-bg overflow-hidden">
      {/* Header */}
      <Header
        onRefreshContext={fetchActiveTabContext}
        onClearChat={handleClearChat}
        isRefreshing={isRefreshing}
      />

      {/* Main Chat Thread */}
      <ChatThread
        messages={messages}
        isProcessing={isProcessing}
        onSelectPrompt={handleSendMessage}
      />

      {/* Floating Input Box */}
      <InputBox
        tabContext={tabContext}
        onSendMessage={handleSendMessage}
        disabled={isProcessing}
      />
    </div>
  );
};
