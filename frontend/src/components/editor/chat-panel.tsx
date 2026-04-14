'use client';

import { useState, useRef, useEffect } from 'react';
import {
  Send,
  Trash2,
  Bot,
  User,
  Sparkles,
  Code2,
  ChevronDown,
  ChevronRight,
  Check,
  FileCode,
  Search,
  Wifi,
  WifiOff,
  Plug,
  Settings,
  Cpu,
  CheckCircle2,
  AlertCircle,
  Plus,
  History,
  Eraser,
  Loader2,
  AlertTriangle,
  RefreshCw,
  Square,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { fetchApi } from '@/lib/api-client';
import { useEditor, type ChatMessage, type DiffChange } from '@/store/editor';
import { useAgent, type AgentMessage } from '@/store/agent';
import PlanCard from './plan-card';
import { Button } from '@/components/ui/button';

// ── Types ────────────────────────────────────────────────

interface Turn {
  id: string;
  userMessage: AgentMessage;
  activities: AgentMessage[];
}

function groupActivityIntoTurns(log: AgentMessage[]): Turn[] {
  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;

  for (const item of log) {
    if (item.role === 'user') {
      if (currentTurn) turns.push(currentTurn);
      currentTurn = {
        id: item.id,
        userMessage: item,
        activities: [],
      };
    } else if (currentTurn) {
      currentTurn.activities.push(item);
    }
  }

  if (currentTurn) turns.push(currentTurn);
  return turns;
}

// ── Activity Log Item ────────────────────────────────────

function ActivityItem({ item }: { item: AgentMessage }) {
  const isStatus = item.isStatus;
  const isAssistant = item.role === 'assistant';

  if (isStatus) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] text-muted-foreground/70">
        <div className="h-1 w-1 rounded-full bg-muted-foreground/30 shrink-0" />
        <span className="truncate">{item.content}</span>
      </div>
    );
  }

  return (
    <div className={`flex gap-2.5 px-3 py-2.5 ${isAssistant ? 'bg-background' : 'bg-muted/30'}`}>
      <div className="shrink-0 mt-0.5">
        <div className={`h-6 w-6 rounded-full flex items-center justify-center ${isAssistant ? 'bg-emerald-500/10' : 'bg-primary/10'}`}>
          {isAssistant ? (
            <Bot className="h-3.5 w-3.5 text-emerald-500" />
          ) : (
            <User className="h-3.5 w-3.5 text-primary" />
          )}
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-xs font-medium">{isAssistant ? 'Assistant' : 'You'}</span>
          <span className="text-[10px] text-muted-foreground">
            {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        <div className="text-sm prose prose-sm dark:prose-invert max-w-none prose-p:leading-relaxed prose-pre:bg-muted/50">
          <ReactMarkdown>{item.content}</ReactMarkdown>
        </div>
        
        {/* Historical Plan/Payload Rendering */}
        {item.payload && item.payload.steps && (
          <div className="mt-3 border rounded-lg bg-background/50 overflow-hidden shadow-sm">
            <div className="px-3 py-1.5 bg-muted/30 border-b flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Plan Snapshot
              </span>
            </div>
            <div className="p-2 origin-top scale-[0.9] -m-[5%]">
              <PlanCard plan={item.payload} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Chat Turn Component ──────────────────────────────────

function ChatTurn({ 
  turn, 
  isLast, 
  isAgentActive 
}: { 
  turn: Turn; 
  isLast: boolean; 
  isAgentActive: boolean 
}) {
  const [isExpanded, setIsExpanded] = useState(isLast || isAgentActive);

  // Auto-expand if agent starts working on THIS turn
  useEffect(() => {
    if (isLast && isAgentActive) {
      setIsExpanded(true);
    }
  }, [isLast, isAgentActive]);

  return (
    <div className="border-b border-border/10 last:border-0 overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`w-full flex items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/30 ${!isExpanded ? 'bg-muted/10' : ''}`}
      >
        <div className="shrink-0">
          {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </div>
        <div className="flex-1 min-w-0 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <div className="h-5 w-5 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <User className="h-3 w-3 text-primary" />
            </div>
            <span className={`text-xs font-medium truncate ${!isExpanded ? 'text-foreground' : 'text-muted-foreground'}`}>
              {turn.userMessage.content}
            </span>
          </div>
          <span className="text-[10px] text-muted-foreground whitespace-nowrap opacity-60">
            {new Date(turn.userMessage.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </button>

      {isExpanded && (
        <div className="divide-y divide-border/10 bg-background/40">
          {/* We show the full user message first inside the expanded view for clarity */}
          <ActivityItem item={turn.userMessage} />
          {turn.activities.map(act => (
            <ActivityItem key={act.id} item={act} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Change Review Item ──────────────────────────────────

function ChangeReviewItem({ change }: { change: DiffChange }) {
  const { setDiffView } = useEditor();
  const { acceptChange, rejectChange } = useAgent();

  return (
    <div className="mx-3 my-1.5 rounded-lg border border-border/50 bg-background overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2">
        <button
          className="flex items-center gap-2 text-xs hover:text-foreground text-foreground/80 transition-colors"
          onClick={() => setDiffView(change)}
        >
          <Code2 className="h-3.5 w-3.5 text-orange-400" />
          <span className="font-mono">{change.path}</span>
        </button>
        <div className="flex items-center gap-1">
          {change.accepted && (
            <span className="flex items-center gap-0.5 text-[10px] text-emerald-500 px-1.5 py-0.5 rounded bg-emerald-500/10">
              <Check className="h-3 w-3" /> Accepted
            </span>
          )}
          {change.rejected && (
            <span className="text-[10px] text-destructive px-1.5 py-0.5 rounded bg-destructive/10">
              Rejected
            </span>
          )}
          {!change.accepted && !change.rejected && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[10px] px-2 text-emerald-500 hover:text-emerald-400 hover:bg-emerald-500/10"
                onClick={() => acceptChange(change.id)}
              >
                <Check className="h-3 w-3 mr-0.5" /> Accept
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[10px] px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => rejectChange(change.id)}
              >
                Reject
              </Button>
            </>
          )}
        </div>
      </div>
      {change.description && (
        <div className="px-3 pb-2 text-[10px] text-muted-foreground">
          {change.description}
        </div>
      )}
    </div>
  );
}

// ── Main Chat Panel ─────────────────────────────────────

export default function ChatPanel() {
  const {
    agentState,
    currentPlan,
    activityLog,
    isConnected,
    connect,
    approvePlan,
    rejectPlan,
    sendChat,
    clearActivity,
    currentThought,
    sessions,
    currentSessionId,
    loadSession,
    createSession,
    deleteSession,
    resetAll,
    isCreatingSession,
    sessionsLoaded,
    currentSessionTokens,
    currentSessionCost,
    currentContextTokens,
    maxContextTokens,
  } = useAgent();
  const { pendingChanges } = useEditor();
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [showConnection, setShowConnection] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const { llmSettings, setLLMSettings } = useEditor();
  const [verifyStatus, setVerifyStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const handleVerify = async () => {
    setVerifyStatus('loading');
    setVerifyError(null);
    try {
      const result = await fetchApi<{ success: boolean; error?: string }>('/llm/verify', {
        method: 'POST',
        body: JSON.stringify(llmSettings),
      });
      if (result.success) {
        setVerifyStatus('success');
      } else {
        setVerifyStatus('error');
        setVerifyError(result.error || 'Connection failed');
      }
    } catch (err) {
      setVerifyStatus('error');
      setVerifyError('Request failed');
    }
  };

  // Manual connect only.

  // Auto-scroll to bottom on new activity
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activityLog, currentPlan, pendingChanges, currentThought]);

  const isAgentActive = ['analyzing', 'planning', 'implementing'].includes(agentState);
  const isWaitingApproval = ['awaiting_plan_approval', 'awaiting_change_approval'].includes(agentState);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || isAgentActive) return;
    sendChat(trimmed);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const unresolvedChanges = pendingChanges.filter(c => !c.accepted && !c.rejected);

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-emerald-500" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Agent Chat
          </span>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground/60 border-l pl-2 border-border/50">
              {currentSessionTokens.toLocaleString()} tokens
            </span>
            <span className="text-[10px] text-muted-foreground/60">
              ${currentSessionCost.toFixed(4)}
            </span>
            <span className="text-[10px] text-muted-foreground/60" title="Current Context Window Usage">
              Context: {currentContextTokens.toLocaleString()} / {maxContextTokens ? (maxContextTokens / 1000).toFixed(0) + 'k' : '??'}
            </span>
          </div>
          {unresolvedChanges.length > 0 && (
            <span className="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-orange-500/10 text-orange-500">
              {unresolvedChanges.length} pending
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {isAgentActive && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => useAgent.getState().cancelTask()}
              title="Stop Agent"
            >
              <Square className="h-3 w-3 fill-current" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => {
              const newState = !showSettings;
              setShowSettings(newState);
              setShowConnection(newState);
            }}
            title="Agent Configuration"
          >
            <Settings className={`h-3.5 w-3.5 ${showSettings ? 'text-primary' : ''}`} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-all"
            onClick={clearActivity}
            title="Clear current view (Eraser)"
          >
            <Eraser className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Session Switcher */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b bg-muted/20 shrink-0">
        <div className="flex-1 flex items-center gap-1.5 overflow-hidden">
          <select 
            className="flex-1 bg-background text-foreground text-[10px] font-medium focus:outline-none transition-colors border border-border/50 rounded px-1 h-6 cursor-pointer hover:border-border disabled:opacity-50"
            value={currentSessionId || ''}
            onChange={(e) => loadSession(e.target.value)}
            disabled={!sessionsLoaded}
          >
            {!sessionsLoaded ? (
              <option>Loading sessions...</option>
            ) : sessions.length === 0 ? (
              <option>No sessions</option>
            ) : (
              sessions.map((s, idx) => (
                <option key={s.id} value={s.id} className="bg-background text-foreground">
                  {s.title || `Session ${idx + 1}`}
                </option>
              ))
            )}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <Button 
            variant="ghost" 
            size="icon" 
            className="h-5 w-5 hover:text-emerald-500"
            onClick={() => createSession('New Session')}
            disabled={isCreatingSession}
            title="New Session"
          >
            {isCreatingSession ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Plus className="h-3 w-3" />
            )}
          </Button>
          {sessions.length > 0 && (
            <Button 
              variant="ghost" 
              size="icon" 
              className="h-5 w-5 hover:text-destructive"
              onClick={() => currentSessionId && deleteSession(currentSessionId)}
              title="Delete Session"
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>

      {/* LLM Settings banner */}
      {showSettings && (
        <div className="px-3 py-3 border-b shrink-0 bg-muted/40 space-y-3">
          <div className="space-y-1.5">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              LiteLLM API Key
            </label>
            <input
              type="password"
              value={llmSettings.apiKey}
              onChange={(e) => setLLMSettings({ ...llmSettings, apiKey: e.target.value })}
              placeholder="Leave empty to use server .env"
              className="w-full text-xs px-2 py-1.5 rounded border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              API Base URL
            </label>
            <input
              type="text"
              value={llmSettings.apiBase}
              onChange={(e) => setLLMSettings({ ...llmSettings, apiBase: e.target.value })}
              placeholder="e.g. http://localhost:11434/v1"
              className="w-full text-xs px-2 py-1.5 rounded border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Model Override
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={llmSettings.model}
                onChange={(e) => setLLMSettings({ ...llmSettings, model: e.target.value })}
                placeholder="e.g. gemini/gemini-2.0-flash"
                className="flex-1 text-xs px-2 py-1.5 rounded border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <Button 
                variant="outline" 
                size="sm" 
                className="h-8 text-[10px]"
                onClick={() => setLLMSettings({ ...llmSettings, model: 'gemini/gemini-2.0-flash' })}
              >
                Reset
              </Button>
            </div>
          </div>
          <p className="text-[9px] text-muted-foreground leading-tight">
            Settings are saved locally.
          </p>

          <div className="flex items-center justify-between gap-4 pt-1 border-t border-border/20 mt-1">
            <Button 
              variant="outline" 
              size="sm" 
              className={`h-7 px-2 gap-1.5 text-[10px] ${
                verifyStatus === 'success' ? 'text-emerald-500 border-emerald-500/50 bg-emerald-500/5' :
                verifyStatus === 'error' ? 'text-destructive border-destructive/50 bg-destructive/5' : ''
              }`}
              onClick={handleVerify}
              disabled={verifyStatus === 'loading'}
            >
              {verifyStatus === 'loading' ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : verifyStatus === 'success' ? (
                <CheckCircle2 className="h-3 w-3" />
              ) : verifyStatus === 'error' ? (
                <AlertCircle className="h-3 w-3" />
              ) : (
                <Cpu className="h-3 w-3" />
              )}
              {verifyStatus === 'loading' ? 'Verifying...' : 
               verifyStatus === 'success' ? 'Connected' : 
               verifyStatus === 'error' ? 'Failed' : 'Verify Connection'}
            </Button>
            
            {verifyError && (
              <span className="text-[9px] text-destructive truncate max-w-[150px] italic" title={verifyError}>
                {verifyError}
              </span>
            )}
          </div>

          <div className="pt-2 border-t border-border/20 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">Global Data</span>
              <div className="flex gap-2">
                <Button 
                  variant="ghost" 
                  size="sm" 
                  className="h-6 px-2 text-[9px] hover:bg-destructive/10 hover:text-destructive"
                  onClick={async () => {
                    if (confirm('Are you sure you want to reset all settings?')) {
                      await fetchApi('/settings/llm_settings', { method: 'DELETE' });
                      setLLMSettings({ apiKey: '', model: 'gemini/gemini-2.0-flash', apiBase: '' });
                    }
                  }}
                >
                  Reset Settings
                </Button>
                <Button 
                  variant="ghost" 
                  size="sm" 
                  className="h-6 px-2 text-[9px] text-destructive hover:bg-destructive/10"
                  onClick={() => {
                    if (confirm('DANGER: This will delete all chat history and workspace state. Proceed?')) {
                      resetAll();
                    }
                  }}
                >
                  <AlertTriangle className="h-2.5 w-2.5 mr-1" />
                  Wipe Database
                </Button>
              </div>
            </div>
          </div>
          <div className="pt-2 border-t border-border/20">
            <Button 
              variant="outline" 
              size="sm" 
              className="w-full text-[10px] h-7 gap-2"
              onClick={async () => {
                try {
                  await fetchApi('/settings', {
                    method: 'POST',
                    body: JSON.stringify({ key: 'llm_settings', value: llmSettings })
                  });
                  alert('Codebase re-indexing triggered!');
                } catch (e) {
                  alert('Failed to trigger indexing');
                }
              }}
            >
              <RefreshCw className="h-3 w-3" />
              Re-index Codebase
            </Button>
          </div>
        </div>
      )}

      {/* Connection status & Mode banner */}
      {showConnection && (
        <div className="px-3 py-3 border-b shrink-0 bg-muted/30 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs">
              <Plug className="h-3.5 w-3.5 text-muted-foreground" />
              <div className="flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-destructive'}`} />
                <span className="font-medium">
                  {isConnected ? 'Connected' : 'Disconnected'}
                </span>
              </div>
            </div>
            <Button
              variant={isConnected ? "destructive" : "default"}
              size="sm"
              className="h-7 text-[10px] px-3"
              onClick={() => isConnected ? useAgent.getState().disconnect() : connect()}
            >
              {isConnected ? 'Disconnect' : 'Connect'}
            </Button>
          </div>

        </div>
      )}

      {/* Activity Feed + Plan + Changes */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {activityLog.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-6 text-center text-muted-foreground">
            <div className="h-10 w-10 rounded-full bg-emerald-500/10 flex items-center justify-center mb-3">
              <Bot className="h-5 w-5 text-emerald-500" />
            </div>
            <p className="text-sm font-medium mb-1">Agent Assistant</p>
            <p className="text-xs leading-relaxed mb-3">
              {isConnected
                ? 'Ask me to write, edit, or debug code. I\'ll analyze first, then propose a plan for your approval.'
                : 'Connect to the agent backend to start coding with AI assistance.'}
            </p>
            <div className="mt-1 space-y-1.5 w-full">
              {[
                'Add a health check endpoint',
                'Refactor the config module',
                'Fix error handling in main.py',
              ].map((suggestion, i) => (
                <button
                  key={i}
                  className="w-full text-left text-xs px-3 py-2 rounded-md bg-accent/50 hover:bg-accent transition-colors"
                  onClick={() => {
                    setInput(suggestion);
                    inputRef.current?.focus();
                  }}
                >
                  &ldquo;{suggestion}&rdquo;
                </button>
              ))}
            </div>
            {/* Workflow explanation */}
            <div className="mt-6 w-full text-left space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                How it works
              </p>
              <div className="space-y-1.5 text-[10px]">
                {[
                  { icon: Search, text: 'Agent analyzes your codebase', color: 'text-blue-400' },
                  { icon: Sparkles, text: 'Agent proposes an implementation plan', color: 'text-yellow-400' },
                  { icon: Check, text: 'You approve or reject the plan', color: 'text-emerald-400' },
                  { icon: Code2, text: 'Agent implements the approved changes', color: 'text-orange-400' },
                  { icon: Check, text: 'You review and accept/reject each change', color: 'text-emerald-400' },
                ].map((step, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <step.icon className={`h-3 w-3 ${step.color}`} />
                    <span className="text-muted-foreground">{step.text}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-border/10">
            {(() => {
              const turns = groupActivityIntoTurns(activityLog);
              return turns.map((turn, i) => (
                <ChatTurn 
                  key={turn.id} 
                  turn={turn} 
                  isLast={i === turns.length - 1} 
                  isAgentActive={isAgentActive}
                />
              ));
            })()}

            {/* Plan card */}
            {currentPlan && (
              <div className="px-3 py-2">
                <PlanCard
                  plan={currentPlan}
                  onApprove={approvePlan}
                  onReject={rejectPlan}
                />
              </div>
            )}

            {/* Pending changes */}
            {unresolvedChanges.length > 0 && (
              <div className="px-3 py-2 space-y-1.5">
                <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  <Code2 className="h-3 w-3" />
                  Proposed Changes ({unresolvedChanges.length})
                </div>
                {unresolvedChanges.map(change => (
                  <ChangeReviewItem key={change.id} change={change} />
                ))}
              </div>
            )}

            {/* Accepted/rejected changes summary */}
            {pendingChanges.length > 0 && pendingChanges.every(c => c.accepted || c.rejected) && (
              <div className="px-3 py-1.5">
                <div className="text-[10px] text-muted-foreground">
                  {pendingChanges.filter(c => c.accepted).length} accepted ·{' '}
                  {pendingChanges.filter(c => c.rejected).length} rejected
                </div>
              </div>
            )}

            {/* Live Thinking / Reasoning Block */}
            {currentThought && (
              <div className="mx-3 my-2 p-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 space-y-2 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                  <div className="h-4 w-4 rounded-full bg-emerald-500/20 flex items-center justify-center">
                    <Cpu className="h-2.5 w-2.5 animate-pulse" />
                  </div>
                  Reasoning
                </div>
                <div className="text-xs leading-relaxed text-foreground/90 font-medium">
                  <ReactMarkdown>{currentThought}</ReactMarkdown>
                </div>
              </div>
            )}

            {/* Thinking indicator */}
            {isAgentActive && (
              <div className="flex items-center gap-2 px-3 py-3">
                <Bot className="h-4 w-4 text-emerald-500 animate-pulse" />
                <div className="flex gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="border-t p-3 shrink-0">
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isAgentActive ? 'Agent is working...' :
              isWaitingApproval ? 'Waiting for approval...' :
              'Ask the agent...'
            }
            disabled={isAgentActive || isWaitingApproval}
            rows={1}
            className="flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring min-h-[36px] max-h-[120px] disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              height: 'auto',
              overflow: input.includes('\n') ? 'auto' : 'hidden',
            }}
            onInput={e => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = 'auto';
              target.style.height = Math.min(target.scrollHeight, 120) + 'px';
            }}
          />
          <Button
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={handleSend}
            disabled={!input.trim() || isAgentActive || isWaitingApproval}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
