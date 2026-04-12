'use client';

import { useState, useEffect } from 'react';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import FileTree from './file-tree';
import CodeEditor from './code-editor';
import DiffView from './diff-view';
import ChatPanel from './chat-panel';
import AgentStatusBar from './agent-status';
import PlanDocument from './plan-document';
import TerminalPanel from './terminal-panel';
import { useEditor, PLAN_TAB_ID } from '@/store/editor';
import { useAgent } from '@/store/agent';
import { useFileSystem } from '@/store/file-system';
import { Button } from '@/components/ui/button';
import {
  PanelLeftClose,
  PanelLeftOpen,
  MessageSquare,
  Terminal,
  FileCode,
  Lightbulb,
  Circle,
  X,
  MoreVertical,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export default function EditorLayout() {
  const initFileSystem = useFileSystem(state => state.init);
  
  useEffect(() => {
    initFileSystem();
  }, [initFileSystem]);

  const activeDiff = useEditor(state => state.activeDiff);
  const { activeTab, openTabs, closeTab, closeAllTabs, closeSavedTabs, setActiveTab, pendingChanges } = useEditor();
  const { agentState, currentPlan, terminalCommands, showTerminal } = useAgent();
  const [showFileTree, setShowFileTree] = useState(true);
  const [showChat, setShowChat] = useState(true);

  const isAgentActive = ['analyzing', 'planning', 'implementing', 'awaiting_terminal_approval', 'running_terminal'].includes(agentState);
  const hasPlan = !!currentPlan && (currentPlan.status === 'pending' || currentPlan.status === 'approved');
  const hasTerminalCmds = terminalCommands.length > 0 || showTerminal;
  const isPlanTabActive = activeTab === PLAN_TAB_ID;
  const showPlan = hasPlan && isPlanTabActive;

  // Main editor content: diff > plan > code editor
  const editorContent = activeDiff ? (
    <DiffView diff={activeDiff} />
  ) : showPlan ? (
    <PlanDocument />
  ) : (
    <CodeEditor />
  );

  // Build the file tree panel
  const treePanel = showFileTree && (
    <ResizablePanel defaultSize={20} minSize={15} maxSize={40} order={1}>
      <FileTree />
    </ResizablePanel>
  );

  // Build the editor panel (with optional terminal split)
  const editorPanel = (
    <ResizablePanel defaultSize={showChat ? 50 : 80} minSize={25} order={showFileTree ? 2 : 1}>
      {/* Tab bar */}
      {openTabs.length > 0 && (
        <div className="flex items-center border-b shrink-0 overflow-x-auto bg-muted/20 scrollbar-thin">
          {openTabs.map(tabId => {
            const isActive = activeTab === tabId;
            const isPlan = tabId === PLAN_TAB_ID;
            const fileName = isPlan
              ? (currentPlan?.title || 'Plan')
              : tabId.split('/').pop() || tabId;
            const filePath = isPlan ? '' : tabId;

            return (
              <div
                key={tabId}
                className={`
                  group flex items-center gap-1.5 px-3 h-8 text-xs cursor-pointer
                  border-r border-border/50 shrink-0 min-w-0 max-w-[180px]
                  transition-colors select-none
                  ${isActive
                    ? 'bg-background text-foreground border-b-2 border-b-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'
                  }
                  ${isPlan && isActive ? 'font-medium' : ''}
                `}
                onClick={() => setActiveTab(tabId)}
              >
                {isPlan ? (
                  <Lightbulb className={`h-3 w-3 shrink-0 ${isActive ? 'text-primary fill-primary' : 'text-primary/60'}`} />
                ) : (
                  <FileCode className="h-3 w-3 shrink-0 opacity-50" />
                )}
                <span className="truncate">{fileName}</span>
                {filePath && (
                  <span className="text-[10px] text-muted-foreground/60 truncate hidden group-hover:inline">
                    {filePath.includes('/') ? ` — ${filePath.split('/').slice(-2, -1).pop()}` : ''}
                  </span>
                )}
                <button
                  className={`
                    ml-auto shrink-0 rounded p-0.5 hover:bg-foreground/10
                    ${isActive ? 'opacity-60 hover:opacity-100' : 'opacity-0 group-hover:opacity-60 hover:!opacity-100'}
                  `}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tabId);
                  }}
                >
                  {useFileSystem.getState().isUnsaved(tabId) ? (
                    <Circle className="h-2 w-2 fill-yellow-500 text-yellow-500" />
                  ) : (
                    <X className="h-3 w-3" />
                  )}
                </button>
              </div>
            );
          })}
          <div className="flex items-center px-1 border-l ml-auto shrink-0 bg-background/50">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7">
                  <MoreVertical className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={closeSavedTabs}>
                  Close Saved Tabs
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={closeAllTabs} className="text-destructive">
                  Close All Tabs
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}

      {/* Pending changes indicator */}
      {pendingChanges.length > 0 && !activeDiff && !showPlan && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-orange-500/5 border-b shrink-0">
          <Circle className="h-2 w-2 fill-orange-500 text-orange-500" />
          <span className="text-xs text-orange-600 dark:text-orange-400">
            {pendingChanges.filter(c => !c.accepted && !c.rejected).length} pending change{pendingChanges.length > 1 ? 's' : ''}
          </span>
        </div>
      )}

      {/* Editor content */}
      {hasTerminalCmds ? (
        <ResizablePanelGroup direction="vertical">
          <ResizablePanel defaultSize={showPlan ? 65 : 80} minSize={20}>
            {editorContent}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={showPlan ? 35 : 20} minSize={10} maxSize={60}>
            <TerminalPanel />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        editorContent
      )}
    </ResizablePanel>
  );

  // Build the chat panel
  const chatPanel = showChat && (
    <ResizablePanel defaultSize={30} minSize={20} maxSize={45} order={showFileTree ? 3 : 2}>
      <ChatPanel />
    </ResizablePanel>
  );

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-background">
      {/* Top bar */}
      <header className="flex items-center justify-between px-3 h-9 border-b shrink-0 bg-muted/30">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setShowFileTree(!showFileTree)}
          >
            {showFileTree ? (
              <PanelLeftClose className="h-3.5 w-3.5" />
            ) : (
              <PanelLeftOpen className="h-3.5 w-3.5" />
            )}
          </Button>
          <span className="text-sm font-medium">Agentic Code Editor</span>

          {/* Quick plan access button in header — visible when plan exists */}
          {hasPlan && !isPlanTabActive && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2.5 text-[10px] gap-1.5 border-primary/20 hover:border-primary/40 hover:bg-primary/5"
              onClick={() => useEditor.getState().openPlanTab()}
            >
              <Lightbulb className="h-3 w-3 text-primary/70" />
              View Plan
            </Button>
          )}

          {/* View mode indicators */}
          {showPlan && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-primary/10 text-primary font-medium">
              Plan View
            </span>
          )}
          {activeDiff && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-orange-500/10 text-orange-400 font-medium">
              <FileCode className="h-3 w-3" />
              Diff View
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Terminal toggle */}
          {terminalCommands.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => useAgent.getState().toggleTerminal()}
              title={showTerminal ? 'Hide terminal' : 'Show terminal'}
            >
              <Terminal className="h-3.5 w-3.5" />
            </Button>
          )}
          {openTabs.length > 0 && (
            <span className="text-[10px] text-muted-foreground">
              {openTabs.length} tab{openTabs.length > 1 ? 's' : ''}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setShowChat(!showChat)}
          >
            {showChat ? (
              <X className="h-3.5 w-3.5" />
            ) : (
              <MessageSquare className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </header>

      {/* Main panels */}
      <div className="flex-1 min-h-0">
        <ResizablePanelGroup direction="horizontal">
          {treePanel}
          {showFileTree && <ResizableHandle withHandle />}
          {editorPanel}
          {showChat && <ResizableHandle withHandle />}
          {chatPanel}
        </ResizablePanelGroup>
      </div>

      {/* Agent status bar */}
      {(isAgentActive || agentState === 'awaiting_plan_approval' || agentState === 'awaiting_change_approval' || agentState === 'awaiting_terminal_approval' || agentState === 'complete' || agentState === 'error')
        && <AgentStatusBar />
      }

      {/* Status bar */}
      <footer className="flex items-center justify-between px-3 h-6 border-t shrink-0 bg-muted/50 text-[10px] text-muted-foreground mt-auto">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <Circle className="h-1.5 w-1.5 fill-emerald-500 text-emerald-500" />
            Ready
          </span>
          <span>Monaco Editor</span>
        </div>
        <div className="flex items-center gap-3">
          <span>UTF-8</span>
          <span>Spaces: 2</span>
        </div>
      </footer>
    </div>
  );
}
