import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';
import type {
  AgentState,
  AgentEvent,
  ClientCommand,
  AgentPlanEvent,
  AgentFileChangeEvent,
  AgentFileReadEvent,
  AgentTerminalCommandEvent,
  AgentTerminalOutputEvent,
  AgentStepUpdateEvent,
} from '@/lib/api-client';
import { fetchApi } from '@/lib/api-client';
export type { AgentState };
import { useEditor, type DiffChange } from '@/store/editor';
import { useFileSystem } from '@/store/file-system';

// Connection config
const AGENT_PORT = 8000;

// ── Types ────────────────────────────────────────────────

export interface PlanStep {
  id: string;
  description: string;
  files: string[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  detail?: string;
}

export interface ImplementationPlan {
  id: string;
  title: string;
  description: string;
  reasoning: string;
  steps: PlanStep[];
  status: 'pending' | 'approved' | 'rejected';
}

export interface TerminalCommand {
  id: string;
  command: string;
  description: string;
  workingDir: string;
  status: 'pending_approval' | 'running' | 'completed' | 'rejected' | 'failed';
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  timestamp: number;
}

export interface FileReadActivity {
  path: string;
  reason?: string;
  timestamp: number;
}

export interface AgentMessage {
  id: string;
  content: string;
  timestamp: number;
  isStatus?: boolean;
  role?: 'user' | 'assistant';
  payload?: any;
}

// ── Store ────────────────────────────────────────────────

interface AgentStore {
  socket: Socket | null;
  isConnected: boolean;

  // Workflow state
  agentState: AgentState;
  statusDetail: string;

  // Plan
  currentPlan: ImplementationPlan | null;

  // Terminal
  terminalCommands: TerminalCommand[];
  showTerminal: boolean;

  // Activity feed
  activityLog: AgentMessage[];
  readFiles: FileReadActivity[];
  currentThought: string | null;

  // Actions
  connect: () => void;
  disconnect: () => void;
  refreshFileSystem: () => Promise<void>;

  // Send commands
  sendChat: (message: string) => void;
  approvePlan: () => void;
  rejectPlan: (reason?: string) => void;
  acceptChange: (changeId: string) => void;
  rejectChange: (changeId: string) => void;
  approveTerminal: (commandId: string) => void;
  rejectTerminal: (commandId: string) => void;
  cancelTask: () => void;

  // Terminal toggle
  toggleTerminal: () => void;

  // Sessions
  sessions: any[];
  currentSessionId: string | null;
  loadSession: (sessionId: string) => Promise<void>;
  createSession: (title: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  updateSessionState: () => Promise<void>;

  // Internal
  sendCommand: (command: ClientCommand) => void;
  handleEvent: (event: AgentEvent) => Promise<void>;
  addActivity: (content: string, isStatus?: boolean, role?: 'user' | 'assistant', payload?: any) => void;
  clearActivity: () => void;
  resetAll: () => Promise<void>;
  
  // Status
  isInitializing: boolean;
  isConnecting: boolean;
  isCreatingSession: boolean;
  sessionsLoaded: boolean;
  
  // Metrics
  currentSessionTokens: number;
  currentSessionCost: number;
  currentContextTokens: number;
  maxContextTokens: number | null;
}

export const useAgent = create<AgentStore>((set, get) => ({
  socket: null,
  isConnected: false,
  isInitializing: false,
  isConnecting: false,
  isCreatingSession: false,
  sessionsLoaded: false,
  agentState: 'idle',
  statusDetail: '',
  currentPlan: null,
  terminalCommands: [],
  showTerminal: false,
  activityLog: [],
  readFiles: [],
  currentThought: null,
  currentSessionTokens: 0,
  currentSessionCost: 0,
  currentContextTokens: 0,
  maxContextTokens: null,

  connect: () => {
    const { socket, isConnecting } = get();
    if (isConnecting) return;
    set({ isConnecting: true });

    if (socket?.connected) {
      socket.disconnect();
    }

    set({ agentState: 'connecting', statusDetail: `Connecting to agent service...` });

    const port = AGENT_PORT;
    const modeLabel = 'agent service (FastAPI)';
    
    // We explicitly point to the specific port to avoid auto-fallback confusing the user
    const isDev = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
    const socketUrl = isDev ? `http://${window.location.hostname}:${port}` : (process.env.NEXT_PUBLIC_WS_URL || window.location.origin);

    const newSocket = io(socketUrl, {
      transports: ['websocket'],
      reconnection: false, // NO AUTO-FALLBACK or silent retry for mode selection
      forceNew: true,
    });

    newSocket.on('connect', async () => {
      set({ isConnected: true, agentState: 'idle', statusDetail: '' });
      get().addActivity(`Connected to ${modeLabel}`, true);

      // Prevent concurrent initialization
      if (get().isInitializing) return;
      set({ isInitializing: true });

      // Fetch persistent sessions
      try {
        set({ sessionsLoaded: false });
        
        // Wait specifically for FileSystem to be loaded
        let retries = 0;
        while (!useFileSystem.getState().isLoaded && retries < 20) {
          await new Promise(r => setTimeout(r, 200));
          retries++;
        }

        const workspacePath = useFileSystem.getState().currentWorkspacePath;
        if (!workspacePath) {
           console.warn('Workspace path not available during initialization.');
           // If we have a saved session, we might still want to try loading it 
           // but we really need the workspace path for the API.
           return;
        }

        const normalizedWs = workspacePath.replace(/\/$/, '');
        const sessions = await fetchApi<any[]>(`/sessions?workspace=${encodeURIComponent(normalizedWs)}`);
        set({ sessions, sessionsLoaded: true });
        
        // Auto-load latest session or create new
        const savedSessionId = window.localStorage.getItem('current_session_id');
        
        // Try to find the session in the filtered list first
        let sessionToLoad = sessions.find(s => s.id === savedSessionId);
        
        // Fallback: If not found in filtered list but we HAVE a saved ID, 
        // try to fetch it directly to see if it still exists (handles resolution mismatches)
        if (!sessionToLoad && savedSessionId) {
          try {
            const directSession = await fetchApi<any>(`/sessions/${savedSessionId}`);
            if (directSession && directSession.workspace_path.replace(/\/$/, '') === normalizedWs) {
              sessionToLoad = directSession;
              // Add to the local list so UI shows it
              set(s => ({ sessions: [directSession, ...s.sessions.filter(x => x.id !== directSession.id)] }));
            }
          } catch (e) {
            console.debug('Saved session not found on server:', savedSessionId);
          }
        }
        
        if (sessionToLoad) {
          await get().loadSession(sessionToLoad.id);
        } else if (sessions.length > 0) {
          await get().loadSession(sessions[0].id);
        } else {
          set({ currentSessionId: null });
        }

      } catch (err) {
        console.error('Failed to restore persistent session:', err);
      } finally {
        set({ isInitializing: false, isConnecting: false });
      }
    });

    newSocket.on('connect_error', (err) => {
      set({ isConnected: false, isConnecting: false, agentState: 'idle', statusDetail: '' });
      get().addActivity(`Failed to connect to ${modeLabel}: ${err.message}`, true);
      alert(`Connection Error: Could not reach the ${modeLabel} on ${socketUrl}. Make sure the backend is running.`);
    });

    newSocket.on('disconnect', () => {
      set(s => {
        const nextState = {
          isConnected: false,
          agentState: 'idle',
          statusDetail: '',
          currentThought: null,
        } as Partial<AgentStore>;

        // Preserve currentPlan but update step status if needed
        if (s.currentPlan) {
          nextState.currentPlan = {
            ...s.currentPlan,
            steps: s.currentPlan.steps.map(step =>
              step.status === 'running'
                ? { ...step, status: 'failed' as const, detail: 'Connection lost' }
                : step
            ),
          };
        }
        return nextState;
      });
      get().addActivity('Agent disconnected (Attempting to reconnect...)', true);
    });

    // The unified event channel
    newSocket.on('agent:event', async (event: AgentEvent) => {
      await get().handleEvent(event);
    });

    set({ socket: newSocket });
  },

  approvePlan: async () => {
    const { socket, currentPlan } = get();
    if (!socket || !currentPlan) return;
    
    // 1. Optimistic UI updates
    set({ 
      currentThought: null,
      agentState: 'implementing',
      statusDetail: 'Implementing approved plan...',
      showTerminal: true,
      currentPlan: { ...currentPlan, status: 'approved' }
    });
    get().updateSessionState();
    get().addActivity('Plan approved — agent is implementing...', true);

    // 2. Try to get fresh content from the filesystem store before approving
    let plan_md = '';
    let task_md = '';
    try {
      const { useFileSystem } = await import('./file-system');
      const fs = useFileSystem.getState();
      plan_md = fs.getFileByPath('implementation_plan.md')?.content || '';
      task_md = fs.getFileByPath('task_list.md')?.content || '';
    } catch (e) {
      console.warn('Could not read review files from filesystem store', e);
    }

    // 3. Send command
    socket.emit('client:command', {
      type: 'approve_plan',
      payload: { 
        plan_id: currentPlan.id,
        plan: currentPlan,
        plan_md,
        task_md 
      },
    });
  },

  rejectPlan: async (reason?: string) => {
    const { socket, currentPlan } = get();
    if (!socket || !currentPlan) return;

    // 1. Optimistic UI updates
    set({ 
      currentThought: null,
      agentState: 'idle',
      statusDetail: reason || 'Plan rejected',
      currentPlan: { ...currentPlan, status: 'rejected' }
    });
    get().updateSessionState();
    get().addActivity(`Plan rejected${reason ? `: ${reason}` : ''}`, true);

    // 2. Send command
    socket.emit('client:command', {
      type: 'reject_plan',
      payload: { plan_id: currentPlan.id, reason },
    });
  },

  disconnect: () => {
    const socket = get().socket;
    if (socket) {
      socket.disconnect();
      set({ socket: null, isConnected: false, agentState: 'idle' });
    }
  },

  sendCommand: (command: ClientCommand) => {
    const socket = get().socket;
    if (socket?.connected) {
      socket.emit('client:command', command);
    } else {
      console.warn('Cannot send command: agent not connected');
    }
  },

  sendChat: async (message: string) => {
    const { llmSettings } = useEditor.getState();
    const { socket, isConnected, connect, sendCommand } = get();

    // 1. Log visually immediately
    get().addActivity(message);

    // 2. Save to DB
    try {
      const { currentSessionId } = get();
      if (currentSessionId) {
        await fetchApi('/messages', {
          method: 'POST',
          body: JSON.stringify({ session_id: currentSessionId, role: 'user', content: message })
        });
      }
    } catch (err) {
      console.warn('Failed to persist user message:', err);
    }

    // 3. Clear stale thoughts from previous runs
    set({ currentThought: null });

    // 3. Auto-reconnect if needed
    if (!socket || !isConnected) {
      console.log('Agent disconnected. Attempting auto-reconnect before sending chat...');
      connect();
      
      // Wait for connection (simple polling for demonstration, better to use a promise)
      let retries = 0;
      while (retries < 10) {
        await new Promise(r => setTimeout(r, 500));
        if (get().isConnected) break;
        retries++;
      }
    }

    // 4. Send the command
    get().sendCommand({ 
      type: 'chat', 
      payload: { 
        message,
        session_id: get().currentSessionId,
        llm_settings: {
          api_key: llmSettings.apiKey,
          model: llmSettings.model,
          api_base: llmSettings.apiBase
        }
      } 
    });
  },

  acceptChange: (changeId: string) => {
    const pendingChanges = useEditor.getState().pendingChanges;
    const change = pendingChanges.find(c => c.id === changeId);
    if (change) {
      useFileSystem.getState().updateContent(change.path, change.modified);
      useEditor.getState().acceptChange(changeId);
      get().addActivity(`Change accepted: ${change.path}`, true);
    }
    get().sendCommand({ type: 'accept_change', payload: { change_id: changeId } });
  },

  rejectChange: (changeId: string) => {
    useEditor.getState().rejectChange(changeId);
    const pendingChanges = useEditor.getState().pendingChanges;
    const change = pendingChanges.find(c => c.id === changeId);
    get().addActivity(`Change rejected: ${change?.path || changeId}`, true);
    get().sendCommand({ type: 'reject_change', payload: { change_id: changeId } });
  },

  approveTerminal: (commandId: string) => {
    set(s => ({
      terminalCommands: s.terminalCommands.map(cmd =>
        cmd.id === commandId ? { ...cmd, status: 'running' } : cmd
      ),
      agentState: 'running_terminal',
      statusDetail: 'Running terminal command...',
    }));
    get().addActivity(`Terminal command approved: executing...`, true);
    get().sendCommand({ type: 'approve_terminal', payload: { command_id: commandId } });
  },

  rejectTerminal: (commandId: string) => {
    set(s => ({
      terminalCommands: s.terminalCommands.map(cmd =>
        cmd.id === commandId ? { ...cmd, status: 'rejected' } : cmd
      ),
      agentState: 'implementing',
      statusDetail: 'Terminal command rejected — agent continuing...',
    }));
    get().addActivity('Terminal command rejected', true);
    get().sendCommand({ type: 'reject_terminal', payload: { command_id: commandId } });
  },

  cancelTask: () => {
    set({
      agentState: 'idle',
      statusDetail: 'Task cancelled',
      currentPlan: null,
    });
    get().updateSessionState();
    get().addActivity('Task cancelled', true);
    get().sendCommand({ type: 'cancel' });
  },

  toggleTerminal: () => set(s => ({ showTerminal: !s.showTerminal })),
  
  refreshFileSystem: async () => {
    try {
      const fs = (await import('./file-system')).useFileSystem.getState();
      await fs.refresh();
    } catch (err) {
      console.warn('Auto-refresh failed:', err);
    }
  },

  handleEvent: async (event: AgentEvent) => {
    const { type, payload } = event;

    switch (type) {
      case 'status': {
        const { state, detail, context_tokens, context_limit } = payload as { state: AgentState; detail?: string; context_tokens?: number; context_limit?: number };
        const oldState = get().agentState;
        set({ 
          agentState: state, 
          statusDetail: detail || '',
          currentContextTokens: context_tokens || get().currentContextTokens,
          maxContextTokens: context_limit || get().maxContextTokens
        });
        if (detail) get().addActivity(detail, true);
        
        // Proactive file refresh if agent idles or completes
        if (state === 'idle' || state === 'complete') {
          import('./file-system').then(m => m.useFileSystem.getState().refresh());
        }

        if (state !== oldState || state === 'idle' || state === 'complete' || state === 'error') {
          // Clear current thought whenever a new phase starts
          set({ currentThought: null });
        }
        // When agent finishes or idles, reset any frozen "running" steps so UI isn't stuck
        if (state === 'idle' || state === 'complete' || state === 'error') {
          set(s => ({
            currentPlan: s.currentPlan ? {
              ...s.currentPlan,
              steps: s.currentPlan.steps.map(step =>
                step.status === 'running' ? { ...step, status: 'failed' as const, detail: 'Step did not complete (agent disconnected or errored)' } : step
              ),
            } : null,
          }));
        }
        break;
      }

      case 'thought': {
        const { content } = payload as { content: string };
        set({ currentThought: content });
        break;
      }

      case 'message': {
        const { content } = payload as { content: string };
        get().addActivity(content, false, 'assistant');
        
        // Save assistant message to DB
        try {
          const { currentSessionId } = get();
          if (currentSessionId) {
            await fetchApi('/messages', {
              method: 'POST',
              body: JSON.stringify({ session_id: currentSessionId, role: 'assistant', content })
            });
          }
        } catch (err) {
          console.warn('Failed to persist assistant message:', err);
        }
        break;
      }

      case 'plan': {
        const planPayload = payload as AgentPlanEvent['payload'];
        const plan: ImplementationPlan = {
          id: planPayload.id,
          title: planPayload.title,
          description: planPayload.description,
          reasoning: (planPayload as Record<string, unknown>).reasoning as string || '',
          steps: planPayload.steps.map(s => ({ ...s, status: 'pending' as const })),
          status: 'pending',
        };
        set({
          currentPlan: plan,
          agentState: 'awaiting_plan_approval',
          statusDetail: 'Waiting for plan approval...',
        });
        // Expand folders for any files mentioned in the plan
        const fs = useFileSystem.getState();
        fs.expandPath('implementation_plan.md');
        fs.expandPath('task_list.md');

        for (const step of planPayload.steps) {
          for (const filePath of step.files) {
            fs.expandPath(filePath);
          }
        }
        
        const content = `Proposed a plan with ${plan.steps.length} steps`;
        get().addActivity(content, true, 'assistant', plan);

        // Save plan message to DB
        try {
          const { currentSessionId } = get();
          if (currentSessionId) {
            await fetchApi('/messages', {
              method: 'POST',
              body: JSON.stringify({ 
                session_id: currentSessionId, 
                role: 'assistant', 
                content,
                payload: plan 
              })
            });
          }
        } catch (err) {
          console.warn('Failed to persist plan message:', err);
        }
        // Open plan as a tab in the editor
        useEditor.getState().openPlanTab();
        break;
      }

      case 'plan_sync': {
        // Lightweight update: sync step IDs/descriptions after approval WITHOUT resetting status
        // This ensures step_update events can match correctly
        const { steps } = payload as { id: string; steps: Array<{ id: string; description: string; files: string[] }> };
        set(s => ({
          currentPlan: s.currentPlan
            ? {
                ...s.currentPlan,
                steps: steps.map(newStep => {
                  // Preserve existing status if step already exists
                  const existing = s.currentPlan!.steps.find(old => old.id === newStep.id);
                  return existing
                    ? existing
                    : { ...newStep, status: 'pending' as const };
                }),
              }
            : null,
        }));
        break;
      }

      case 'file_read': {
        const fr = payload as AgentFileReadEvent['payload'];
        set(s => ({
          readFiles: [...s.readFiles, { path: fr.path, reason: fr.reason, timestamp: Date.now() }],
        }));
        get().addActivity(`Reading ${fr.path}${fr.reason ? ` — ${fr.reason}` : ''}`, true);
        break;
      }

      case 'file_change': {
        const fc = payload as AgentFileChangeEvent['payload'];
        const diffChange: DiffChange = {
          id: fc.id,
          path: fc.path,
          original: fc.original,
          modified: fc.modified,
          description: fc.description,
        };
        const editor = useEditor.getState();
        editor.addPendingChange(diffChange);
        editor.setDiffView(diffChange); // Auto-open the diff view

        const isWaitingApproval = get().agentState === 'awaiting_plan_approval' || get().agentState === 'awaiting_change_approval';
        set({ agentState: 'awaiting_change_approval', statusDetail: 'Review proposed changes...' });
        get().addActivity(`Proposed change: ${fc.path} — ${fc.description}`, true);
        
        // Proactively refresh if it's already accepted (happens in some internal tools)
        if (get().agentState !== 'awaiting_change_approval') {
          get().refreshFileSystem();
        }
        break;
      }

      case 'terminal_command': {
        const tc = payload as AgentTerminalCommandEvent['payload'];
        const cmd: TerminalCommand = {
          id: tc.id,
          command: tc.command,
          description: tc.description,
          workingDir: tc.working_dir,
          status: 'pending_approval',
          timestamp: Date.now(),
        };
        set(s => ({
          terminalCommands: [...s.terminalCommands, cmd],
          agentState: 'awaiting_terminal_approval',
          statusDetail: `Terminal command pending approval: ${tc.command}`,
          showTerminal: true,
        }));
        get().addActivity(`Terminal command queued: \`${tc.command}\``, true);
        break;
      }

      case 'terminal_output': {
        const to = payload as AgentTerminalOutputEvent['payload'];
        set(s => ({
          terminalCommands: s.terminalCommands.map(cmd =>
            cmd.id === to.command_id
              ? {
                  ...cmd,
                  status: to.exit_code === 0 ? 'completed' as const : 'failed' as const,
                  exitCode: to.exit_code,
                  stdout: to.stdout,
                  stderr: to.stderr,
                  durationMs: to.duration_ms,
                }
              : cmd
          ),
          ...(s.agentState === 'running_terminal' ? { agentState: 'implementing' as const, statusDetail: 'Implementing...' } : {}),
        }));
        const exitMsg = to.exit_code === 0 ? '✓ succeeded' : `✗ failed (exit ${to.exit_code})`;
        get().addActivity(`Command ${exitMsg} in ${(to.duration_ms / 1000).toFixed(1)}s`, true);
        break;
      }

      case 'step_update': {
        const su = payload as AgentStepUpdateEvent['payload'];
        set(s => ({
          currentPlan: s.currentPlan
            ? {
                ...s.currentPlan,
                steps: s.currentPlan.steps.map(step =>
                  step.id === su.step_id
                    ? { ...step, status: su.status, detail: su.detail }
                    : step
                ),
              }
            : null,
        }));
        get().updateSessionState();
        if (su.status === 'completed') {
           get().refreshFileSystem();
        }
        break;
      }

      case 'complete': {
        set({ agentState: 'complete', statusDetail: 'Task complete' });
        get().addActivity('Agent finished!', true);
        break;
      }

      case 'error': {
        const { detail } = payload as { detail: string };
        set({ agentState: 'error', statusDetail: detail, currentThought: null });
        get().addActivity(`Error: ${detail}`, true);
        break;
      }
      
      case 'usage': {
        const { prompt_tokens, completion_tokens, cost } = payload as { prompt_tokens: number; completion_tokens: number; cost: number };
        set(s => ({
          currentSessionTokens: s.currentSessionTokens + prompt_tokens + completion_tokens,
          currentSessionCost: s.currentSessionCost + cost
        }));
        break;
      }
    }
  },

  addActivity: (content, isStatus, role, payload) =>
    set(state => ({
      activityLog: [
        ...state.activityLog,
        {
          id: crypto.randomUUID(),
          content,
          timestamp: Date.now(),
          isStatus,
          role: role || (isStatus ? undefined : 'user'),
          payload,
        },
      ],
    })),

  clearActivity: () => set({ 
    activityLog: [],
    currentPlan: null,
    readFiles: [],
    terminalCommands: [],
    agentState: 'idle' as const,
    currentThought: null
  }),

  // ---------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------

  sessions: [],
  currentSessionId: null,

  loadSession: async (sessionId: string) => {
    try {
      set({ currentSessionId: sessionId });
      window.localStorage.setItem('current_session_id', sessionId);

      const [sessionData, messages] = await Promise.all([
        fetchApi<any>(`/sessions/${sessionId}`),
        fetchApi<any[]>(`/sessions/${sessionId}/messages`),
      ]);

      // Update Activity Log and hard-reset operational flags
      set({
        currentThought: null,
        currentPlan: null,
        terminalCommands: [],
        readFiles: [],
        agentState: 'idle' as const,
        statusDetail: '',
        activityLog: messages.map(m => ({
          id: m.id.toString(),
          role: m.role,
          content: m.content,
          timestamp: new Date(m.timestamp).getTime(),
          isStatus: false,
          payload: m.payload ? JSON.parse(m.payload) : undefined
        })),
        currentSessionTokens: sessionData.total_tokens || 0,
        currentSessionCost: sessionData.total_cost || 0,
      });

      // Active Plan Recovery:
      // Priority 1: Use the dedicated current_plan field from DB
      // Priority 2: Fallback to scanning message history (last assistant message with steps)
      if (sessionData.current_plan) {
        try {
          const recoveredPlan = JSON.parse(sessionData.current_plan);
          set({ currentPlan: recoveredPlan });
          console.log('Restored active plan from dedicated field:', recoveredPlan.id, recoveredPlan.status);
        } catch (e) {
          console.error('Failed to parse current_plan:', e);
        }
      } else {
        const activity = get().activityLog;
        const lastAssistantMessage = [...activity].reverse().find(m => m.role === 'assistant' && m.payload?.steps);
        if (lastAssistantMessage && lastAssistantMessage.payload.status === 'pending') {
          console.log('Restoring active plan from history fallback:', lastAssistantMessage.id);
          set({ currentPlan: lastAssistantMessage.payload });
        }
      }

      // Update Editor UI State
      const openTabs = JSON.parse(sessionData.open_tabs || '[]');
      const pendingChanges = JSON.parse(sessionData.pending_changes || '[]');
      
      useEditor.setState({ 
        openTabs, 
        pendingChanges,
        activeTab: openTabs.length > 0 ? openTabs[0] : null
      });

    } catch (err) {
      console.error('Failed to load session:', err);
    } finally {
      set({ isInitializing: false, isConnecting: false });
    }
  },

  updateSessionState: async () => {
    const { currentSessionId, currentPlan } = get();
    const { openTabs, pendingChanges } = useEditor.getState();
    if (!currentSessionId) return;

    try {
      await fetchApi(`/sessions/${currentSessionId}/state`, {
        method: 'PUT',
        body: JSON.stringify({
          open_tabs: openTabs,
          pending_changes: pendingChanges,
          current_plan: currentPlan
        })
      });
    } catch (err) {
      console.warn('Silent failure updating session state:', err);
    }
  },

  createSession: async (title: string) => {
    if (get().isCreatingSession) return;
    
    const workspacePath = useFileSystem.getState().currentWorkspacePath;
    if (!workspacePath) {
      console.warn('Cannot create session: No workspace path selected');
      return;
    }

    set({ isCreatingSession: true });

    try {
      // Check for name collision and append index if needed
      let finalTitle = title;
      let count = 1;
      while (get().sessions.find(s => s.title === finalTitle)) {
        finalTitle = `${title} (${++count})`;
      }

      const id = crypto.randomUUID();
      await fetchApi('/sessions', {
        method: 'POST',
        body: JSON.stringify({ id, workspace_path: workspacePath, title: finalTitle })
      });
      
      const sessions = await fetchApi<any[]>(`/sessions?workspace=${encodeURIComponent(workspacePath)}`);
      set({ sessions });
      await get().loadSession(id);
    } catch (err) {
      console.error('Failed to create session:', err);
    } finally {
      set({ isCreatingSession: false });
    }
  },

  deleteSession: async (sessionId: string) => {
    try {
      await fetchApi(`/sessions/${sessionId}`, { method: 'DELETE' });
      const workspacePath = useFileSystem.getState().currentWorkspacePath;
      const sessions = await fetchApi<any[]>(`/sessions?workspace=${encodeURIComponent(workspacePath)}`);
      set({ sessions });
      
      if (get().currentSessionId === sessionId) {
        if (sessions.length > 0) {
          await get().loadSession(sessions[0].id);
        } else {
          // Truly empty state - reset ALL volatile session state
          set({ 
            currentSessionId: null, 
            activityLog: [],
            currentThought: null,
            currentPlan: null,
            terminalCommands: [],
            readFiles: [],
            agentState: 'idle' as const,
            statusDetail: ''
          });
          useEditor.setState({ openTabs: [], pendingChanges: [], activeTab: null });
        }
      }
    } catch (err) {
      console.error('Failed to delete session:', err);
    }
  },

  resetAll: async () => {
    try {
      // 1. Backend Wipe
      await fetchApi('/database/reset', { method: 'POST' });
      
      // 2. Clear LocalStorage
      window.localStorage.clear();
      
      // 3. Page Reload to reset all stores
      window.location.reload();
    } catch (err) {
      console.error('Failed to reset:', err);
    }
  }
}));
