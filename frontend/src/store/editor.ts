import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useFileSystem } from './file-system';
import { fetchApi } from '@/lib/api-client';

export const PLAN_TAB_ID = '__plan__';

export interface DiffChange {
  id: string;
  path: string;
  original: string;
  modified: string;
  description: string;
  accepted?: boolean;
  rejected?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  changes?: DiffChange[];
}

interface EditorState {
  // Tabs
  openTabs: string[];
  activeTab: string | null;

  // View modes
  viewMode: 'editor' | 'diff' | 'preview';
  diffMode: 'split' | 'inline';
  diffSource: 'last-save' | 'git-head';
  markdownPreview: boolean;

  // Diff context (for agent changes)
  activeDiff: DiffChange | null;
  pendingChanges: DiffChange[];

  // Chat
  chatMessages: ChatMessage[];
  llmSettings: {
    apiKey: string;
    model: string;
    apiBase: string;
  };

  // Tab actions
  openFile: (path: string) => void;
  openPlanTab: () => void;
  closeTab: (path: string) => void;
  setActiveTab: (path: string) => void;
  closeOtherTabs: (path: string) => void;
  closeAllTabs: () => void;
  isPlanTabActive: () => boolean;
  validateTabs: (existingPaths: string[]) => void;

  // View actions
  setViewMode: (mode: 'editor' | 'diff') => void;
  setDiffMode: (mode: 'split' | 'inline') => void;
  setDiffSource: (source: 'last-save' | 'git-head') => void;
  setMarkdownPreview: (preview: boolean) => void;

  // Diff actions
  setDiffView: (diff: DiffChange | null) => void;
  addPendingChange: (change: DiffChange) => void;
  acceptChange: (changeId: string) => void;
  rejectChange: (changeId: string) => void;
  clearPendingChanges: () => void;

  // Chat actions
  addMessage: (message: Omit<ChatMessage, 'id' | 'timestamp'>) => void;
  clearChat: () => void;
  setLLMSettings: (settings: { apiKey: string; model: string; apiBase: string }) => void;
  closeSavedTabs: () => void;
}

export const useEditor = create<EditorState>()(
  persist(
    (set, get) => ({
      openTabs: [],
      activeTab: null,
      viewMode: 'editor',
      diffMode: 'split',
      diffSource: 'last-save',
      markdownPreview: true,
      activeDiff: null,
      pendingChanges: [],
      chatMessages: [],
      llmSettings: {
        apiKey: '',
        model: 'gemini/gemini-2.0-flash',
        apiBase: '',
      },

      openFile: (path: string) => {
        set(state => {
          const openTabs = state.openTabs.includes(path)
            ? state.openTabs
            : [...state.openTabs, path];
          const result = { 
            openTabs, 
            activeTab: path, 
            activeDiff: null,
            viewMode: 'editor' as const
          };
          
          // Sync to DB if we have a session
          const sessionId = window.localStorage.getItem('current_session_id');
          if (sessionId) {
            fetchApi(`/sessions/${sessionId}/state`, {
              method: 'PUT',
              body: JSON.stringify({ open_tabs: openTabs })
            }).catch(e => console.error(e));
          }

          return result;
        });
      },

      openPlanTab: () => {
        set(state => {
          const openTabs = state.openTabs.includes(PLAN_TAB_ID)
            ? state.openTabs
            : [PLAN_TAB_ID, ...state.openTabs]; // Plan tab always first
          return { 
            openTabs, 
            activeTab: PLAN_TAB_ID, 
            activeDiff: null,
            viewMode: 'editor' 
          };
        });
      },

      closeTab: (path: string) => {
        set(state => {
          const idx = state.openTabs.indexOf(path);
          const openTabs = state.openTabs.filter(t => t !== path);
          let activeTab = state.activeTab;
          if (activeTab === path) {
            activeTab = openTabs[Math.min(idx, openTabs.length - 1)] || null;
          }
          const result = { 
            openTabs, 
            activeTab: activeTab === path ? null : activeTab,
            viewMode: 'editor' as const
          };

          const sessionId = window.localStorage.getItem('current_session_id');
          if (sessionId) {
            fetchApi(`/sessions/${sessionId}/state`, {
              method: 'PUT',
              body: JSON.stringify({ open_tabs: openTabs })
            }).catch(e => console.error(e));
          }

          return result;
        });
      },

      setActiveTab: (path: string) =>
        set({ activeTab: path, activeDiff: null, viewMode: 'editor' }),

      closeOtherTabs: (path: string) =>
        set(state => ({
          openTabs: state.openTabs.includes(path) ? [path] : state.openTabs,
          activeTab: path,
          viewMode: 'editor'
        })),

      closeAllTabs: () =>
        set({ openTabs: [], activeTab: null, viewMode: 'editor' }),

      setViewMode: (viewMode) => set({ viewMode }),
      setDiffMode: (diffMode) => set({ diffMode }),
      setDiffSource: (diffSource) => set({ diffSource }),
      setMarkdownPreview: (markdownPreview) => set({ markdownPreview }),
      setLLMSettings: (llmSettings) => {
        set({ llmSettings });
        // Sync to backend
        fetchApi('/settings', {
          method: 'POST',
          body: JSON.stringify({ key: 'llm_settings', value: llmSettings })
        }).catch(err => console.error('Failed to sync settings to DB:', err));
      },

      closeSavedTabs: () => {
        const { openTabs } = get();
        const { isUnsaved } = useFileSystem.getState();
        const nextTabs = openTabs.filter(tab => tab === PLAN_TAB_ID || isUnsaved(tab));
        set({ 
          openTabs: nextTabs, 
          activeTab: nextTabs.length > 0 ? nextTabs[0] : null 
        });
      },

      setDiffView: (diff: DiffChange | null) =>
        set({ activeDiff: diff, viewMode: diff ? 'diff' : 'editor' }),

      addPendingChange: (change: DiffChange) =>
        set(state => {
          const next = [...state.pendingChanges, change];
          
          const sessionId = window.localStorage.getItem('current_session_id');
          if (sessionId) {
            fetchApi(`/sessions/${sessionId}/state`, {
              method: 'PUT',
              body: JSON.stringify({ pending_changes: next })
            }).catch(e => console.error(e));
          }

          return { pendingChanges: next };
        }),

      acceptChange: (changeId: string) =>
        set(state => ({
          pendingChanges: state.pendingChanges.map(c =>
            c.id === changeId ? { ...c, accepted: true } : c
          ),
        })),

      rejectChange: (changeId: string) =>
        set(state => ({
          pendingChanges: state.pendingChanges.map(c =>
            c.id === changeId ? { ...c, rejected: true } : c
          ),
        })),

      clearPendingChanges: () =>
        set({ pendingChanges: [], activeDiff: null }),

      isPlanTabActive: () => get().activeTab === PLAN_TAB_ID,

      addMessage: (message) =>
        set(state => {
          const newMessage = {
            ...message,
            id: crypto.randomUUID(),
            timestamp: Date.now(),
          };
          return {
            chatMessages: [...state.chatMessages, newMessage],
          };
        }),

      clearChat: () =>
        set({ chatMessages: [] }),

      validateTabs: (existingPaths: string[]) => {
        set(state => {
          const validPaths = new Set(existingPaths);
          const nextTabs = state.openTabs.filter(tab => {
            const isValid = tab === PLAN_TAB_ID || validPaths.has(tab.startsWith('/') ? tab.slice(1) : tab);
            if (!isValid) console.debug(`[validateTabs] Closing invalid tab: ${tab}`);
            return isValid;
          });
          
          let nextActiveTab = state.activeTab;
          if (nextActiveTab && nextActiveTab !== PLAN_TAB_ID) {
            const normalizedActive = nextActiveTab.startsWith('/') ? nextActiveTab.slice(1) : nextActiveTab;
            if (!validPaths.has(normalizedActive)) {
              // Active tab no longer exists, switch to plan or null
              nextActiveTab = nextTabs.length > 0 ? nextTabs[0] : null;
            }
          }

          return { 
            openTabs: nextTabs,
            activeTab: nextActiveTab
          };
        });
      },
    }),
    {
      name: 'editor-storage',
      partialize: (state) => ({
        openTabs: state.openTabs,
        activeTab: state.activeTab,
        chatMessages: state.chatMessages,
        viewMode: state.viewMode,
        diffMode: state.diffMode,
        diffSource: state.diffSource,
        markdownPreview: state.markdownPreview,
        llmSettings: state.llmSettings,
      }),
    }
  )
);
