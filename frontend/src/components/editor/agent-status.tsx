'use client';

import {
  Bot,
  Loader2,
  Search,
  FileSearch,
  Lightbulb,
  Code2,
  Terminal,
  CheckCircle2,
  CircleAlert,
  Ban,
} from 'lucide-react';
import { useAgent, type AgentState } from '@/store/agent';
import type { LucideIcon } from 'lucide-react';

const stateConfig: Record<AgentState, { icon: LucideIcon; label: string; color: string; animate?: boolean }> = {
  idle: { icon: Bot, label: 'Agent Ready', color: 'text-muted-foreground' },
  connecting: { icon: Loader2, label: 'Connecting...', color: 'text-yellow-400', animate: true },
  analyzing: { icon: Search, label: 'Analyzing codebase...', color: 'text-blue-400', animate: true },
  planning: { icon: Lightbulb, label: 'Creating implementation plan...', color: 'text-yellow-400', animate: true },
  awaiting_plan_approval: { icon: FileSearch, label: 'Plan ready — awaiting approval', color: 'text-orange-400' },
  implementing: { icon: Code2, label: 'Implementing changes...', color: 'text-blue-400', animate: true },
  awaiting_change_approval: { icon: FileSearch, label: 'Review proposed changes', color: 'text-orange-400' },
  awaiting_terminal_approval: { icon: Terminal, label: 'Terminal command — awaiting approval', color: 'text-orange-400' },
  running_terminal: { icon: Terminal, label: 'Running terminal command...', color: 'text-blue-400', animate: true },
  complete: { icon: CheckCircle2, label: 'Task complete', color: 'text-emerald-400' },
  error: { icon: CircleAlert, label: 'Error occurred', color: 'text-destructive' },
};

export default function AgentStatusBar() {
  const { agentState, statusDetail, isConnected } = useAgent();
  const config = stateConfig[agentState];
  const Icon = config.icon;
  const isActive = agentState !== 'idle' && agentState !== 'complete' && agentState !== 'error';

  return (
    <div className={`
      flex items-center gap-2 px-3 h-8 border-t shrink-0 text-xs transition-colors
      ${isActive ? 'bg-blue-500/5 border-blue-500/20' : 'bg-background border-border'}
      ${agentState === 'awaiting_terminal_approval' ? 'bg-orange-500/5 border-orange-500/20' : ''}
      ${agentState === 'error' ? 'bg-destructive/5 border-destructive/20' : ''}
      ${agentState === 'complete' ? 'bg-emerald-500/5 border-emerald-500/20' : ''}
    `}>
      {/* Connection indicator */}
      <div className={`h-1.5 w-1.5 rounded-full shrink-0 ${
        isConnected ? 'bg-emerald-500' : 'bg-destructive'
      }`} />

      {/* State icon */}
      <Icon
        className={`h-3.5 w-3.5 shrink-0 ${config.color} ${
          config.animate ? 'animate-spin' : ''
        }`}
        style={config.animate && agentState !== 'connecting' ? { animationDuration: '2s' } : undefined}
      />

      {/* State label */}
      <span className={`${config.color} font-medium`}>{config.label}</span>

      {/* Detail text */}
      {statusDetail && (
        <>
          <span className="text-border">·</span>
          <span className="text-muted-foreground truncate">{statusDetail}</span>
        </>
      )}

      {/* Cancel button when active */}
      {isActive && (
        <button
          className="ml-auto flex items-center gap-1 text-muted-foreground hover:text-destructive transition-colors"
          onClick={() => useAgent.getState().cancelTask()}
        >
          <Ban className="h-3 w-3" />
          Cancel
        </button>
      )}
    </div>
  );
}
