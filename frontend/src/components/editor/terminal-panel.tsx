'use client';

import { useRef, useEffect } from 'react';
import {
  Terminal,
  Check,
  X,
  ChevronRight,
  Clock,
  Circle,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { useAgent, type TerminalCommand } from '@/store/agent';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

function CommandItem({ cmd }: { cmd: TerminalCommand }) {
  const { approveTerminal, rejectTerminal } = useAgent();

  const isPending = cmd.status === 'pending_approval';
  const isRunning = cmd.status === 'running';
  const isCompleted = cmd.status === 'completed';
  const isFailed = cmd.status === 'failed';
  const isRejected = cmd.status === 'rejected';

  return (
    <div className={`border rounded-md overflow-hidden mb-2 ${
      isPending ? 'border-orange-500/50 ring-1 ring-orange-500/20' :
      isRunning ? 'border-blue-500/30' :
      isFailed ? 'border-destructive/30' :
      isRejected ? 'border-muted/50' :
      'border-border/50'
    }`}>
      {/* Command header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
        {isPending && <Circle className="h-3 w-3 text-orange-400 fill-orange-400 shrink-0" />}
        {isRunning && <Loader2 className="h-3 w-3 text-blue-400 shrink-0 animate-spin" />}
        {isCompleted && <Check className="h-3 w-3 text-emerald-400 shrink-0" />}
        {isFailed && <AlertCircle className="h-3 w-3 text-destructive shrink-0" />}
        {isRejected && <X className="h-3 w-3 text-muted-foreground shrink-0" />}

        <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
        <code className="text-xs font-mono text-foreground flex-1 truncate">
          {cmd.command}
        </code>

        {cmd.durationMs != null && (
          <span className="text-[10px] text-muted-foreground flex items-center gap-0.5 shrink-0">
            <Clock className="h-2.5 w-2.5" />
            {(cmd.durationMs / 1000).toFixed(1)}s
          </span>
        )}
        {cmd.exitCode != null && cmd.exitCode !== 0 && (
          <span className="text-[10px] font-mono text-destructive shrink-0">
            exit {cmd.exitCode}
          </span>
        )}
      </div>

      {/* Approval buttons — prominent when pending */}
      {isPending && (
        <div className="flex items-center gap-2 px-3 py-2.5 bg-orange-500/10 border-t border-orange-500/20">
          <AlertCircle className="h-3.5 w-3.5 text-orange-400 shrink-0" />
          <span className="text-xs text-orange-400 flex-1">
            Run this command?
          </span>
          <Button
            size="sm"
            className="h-7 text-xs px-3 bg-emerald-600 hover:bg-emerald-700 text-white"
            onClick={() => approveTerminal(cmd.id)}
          >
            <Check className="h-3 w-3 mr-1" /> Run
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs px-3 text-muted-foreground hover:text-destructive"
            onClick={() => rejectTerminal(cmd.id)}
          >
            <X className="h-3 w-3 mr-1" /> Skip
          </Button>
        </div>
      )}

      {/* Description */}
      {cmd.description && (
        <div className="px-3 py-1 text-[10px] text-muted-foreground border-t border-border/30 bg-muted/10">
          {cmd.description}
        </div>
      )}

      {/* Output — always shown when available */}
      {(isCompleted || isFailed) && (cmd.stdout || cmd.stderr) && (
        <div className="border-t">
          {cmd.stdout && (
            <pre className="px-3 py-2 text-[11px] font-mono text-foreground/80 bg-[#0d1117] whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
              {cmd.stdout}
            </pre>
          )}
          {cmd.stderr && (
            <pre className="px-3 py-2 text-[11px] font-mono text-red-400 bg-red-500/5 whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
              {cmd.stderr}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default function TerminalPanel() {
  const { terminalCommands } = useAgent();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new commands or output
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [terminalCommands]);

  const pendingCount = terminalCommands.filter(c => c.status === 'pending_approval').length;
  const failedCount = terminalCommands.filter(c => c.status === 'failed').length;
  const completedCount = terminalCommands.filter(c => c.status === 'completed').length;

  return (
    <div className="flex flex-col h-full border-t border-border bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-b shrink-0">
        <div className="flex items-center gap-2">
          <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">Terminal</span>
          {terminalCommands.length > 0 && (
            <span className="text-[10px] text-muted-foreground">
              {terminalCommands.length} cmd{terminalCommands.length !== 1 ? 's' : ''}
            </span>
          )}
          {pendingCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-orange-500/10 text-orange-400 text-[10px] font-medium animate-pulse">
              {pendingCount} awaiting approval
            </span>
          )}
          {failedCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-destructive/10 text-destructive text-[10px] font-medium">
              {failedCount} failed
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {completedCount > 0 && <span className="text-emerald-400">✓ {completedCount} done</span>}
        </div>
      </div>

      {/* Commands list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 min-h-0">
        {terminalCommands.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
            <Terminal className="h-8 w-8 mb-2 opacity-20" />
            <p className="text-xs">No terminal commands yet</p>
            <p className="text-[10px] mt-1 opacity-60">Commands run by the agent will appear here</p>
          </div>
        ) : (
          terminalCommands.map(cmd => (
            <CommandItem key={cmd.id} cmd={cmd} />
          ))
        )}
      </div>
    </div>
  );
}
