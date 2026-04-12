import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import { fetchApi } from '@/lib/api-client';

export interface FileNode {
  id: string;
  name: string;
  type: 'file' | 'folder';
  path: string;
  content?: string;
  language?: string;
  children?: FileNode[];
}

function getLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const nameLower = filename.toLowerCase();
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', json: 'json', css: 'css', html: 'html', md: 'markdown',
    yaml: 'yaml', yml: 'yaml', toml: 'toml', sh: 'shell', bash: 'shell',
    sql: 'sql', rs: 'rust', go: 'go', java: 'java', cpp: 'cpp', c: 'c',
    rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin', xml: 'xml',
    svg: 'xml', txt: 'plaintext', env: 'plaintext',
  };
  if (nameLower === 'dockerfile') return 'dockerfile';
  if (nameLower === '.gitignore') return 'plaintext';
  if (nameLower === 'makefile') return 'makefile';
  return langMap[ext] || 'plaintext';
}

function mapBackendTree(nodes: any[]): FileNode[] {
  return nodes.map(node => ({
    id: node.path,
    name: node.name,
    type: node.type === 'directory' ? 'folder' : 'file',
    path: node.path,
    language: node.type === 'file' ? getLanguage(node.name) : undefined,
    children: node.children ? mapBackendTree(node.children) : undefined,
  }));
}

function findNode(nodes: FileNode[], path: string): FileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

interface FileSystemState {
  files: FileNode[];
  expandedFolders: Set<string>;
  originalContentMap: Record<string, string>; // path -> content on disk (updates on save)
  sessionStartContentMap: Record<string, string>; // path -> content at session start (stable)
  gitStatus: Record<string, string>; // path -> git status code (M, A, D, etc.)
  trackingMode: 'session' | 'git';
  currentWorkspacePath: string;
  isLoaded: boolean;

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  switchWorkspace: (path: string) => Promise<void>;
  
  toggleFolder: (path: string) => void;
  expandPath: (path: string) => void;
  createFile: (parentPath: string, name: string, content?: string) => Promise<void>;
  createFolder: (parentPath: string, name: string) => Promise<void>;
  deleteNode: (path: string) => Promise<void>;
  renameNode: (path: string, newName: string) => Promise<void>;
  updateContent: (path: string, content: string) => void;
  fetchFileContent: (path: string) => Promise<string | null>;
  fetchGitStatus: () => Promise<void>;
  fetchGitDiff: (path: string) => Promise<string | null>;
  saveFile: (path: string) => Promise<void>;
  setTrackingMode: (mode: 'session' | 'git') => void;
  clearSessionTracking: () => void;
  getFileByPath: (path: string) => FileNode | null;
  getFileStatus: (path: string) => 'added' | 'modified' | 'unchanged';
  isUnsaved: (path: string) => boolean;
  hasUnsavedChildren: (path: string) => boolean;
  hasModifiedChildren: (path: string) => boolean;
  getFolderStatus: (path: string) => 'added' | 'modified' | 'unchanged';
  getGitStatus: (path: string) => string | undefined;
  resetSession: () => void;
  getAllFiles: () => FileNode[];
}

function collectFiles(nodes: FileNode[], acc: FileNode[] = []): FileNode[] {
  for (const node of nodes) {
    if (node.type === 'file') acc.push(node);
    if (node.children) collectFiles(node.children, acc);
  }
  return acc;
}

export const useFileSystem = create<FileSystemState>()(
  persist(
    (set, get) => ({
      files: [],
      expandedFolders: new Set(['src']),
      originalContentMap: {},
      sessionStartContentMap: {},
      gitStatus: {},
      trackingMode: 'session',
      currentWorkspacePath: '',
      isLoaded: false,

      init: async () => {
        if (get().isLoaded) return;
        const workspaceData = await fetchApi<{ path: string }>('/workspace/current');
        set({ currentWorkspacePath: workspaceData.path });
        await get().refresh();
        set({ isLoaded: true });
      },

      refresh: async () => {
        try {
          const oldFiles = get().files;
          const data = await fetchApi<{ tree: any[] }>('/tree');
          const newFiles = mapBackendTree(data.tree);

          // Preserve content of existing files
          const migrateContent = (newNodes: FileNode[]) => {
            for (const newNode of newNodes) {
              if (newNode.type === 'file') {
                const oldNode = findNode(oldFiles, newNode.path);
                if (oldNode?.content !== undefined) {
                  newNode.content = oldNode.content;
                }
              }
              if (newNode.children) migrateContent(newNode.children);
            }
          };

          migrateContent(newFiles);
          set({ files: newFiles });
          get().fetchGitStatus();
        } catch (err) {
          console.error('Failed to fetch file tree:', err);
        }
      },

      fetchGitStatus: async () => {
        try {
          const status = await fetchApi<Record<string, string>>('/git/status');
          set({ gitStatus: status });
        } catch (err) {
          console.error('Failed to fetch git status:', err);
        }
      },

      fetchGitDiff: async (path: string) => {
        try {
          const data = await fetchApi<{ content: string }>(`/git/diff?path=${encodeURIComponent(path)}`);
          return data.content;
        } catch (err) {
          console.error('Failed to fetch git diff:', err);
          return null;
        }
      },

      switchWorkspace: async (path: string) => {
        try {
          const workspaceData = await fetchApi<{ path: string }>('/workspace', {
            method: 'POST',
            body: JSON.stringify({ path }),
          });
          set({ isLoaded: false, files: [], currentWorkspacePath: workspaceData.path, expandedFolders: new Set() });
          await get().refresh();
        } catch (err) {
          console.error('Failed to switch workspace:', err);
          throw err;
        }
      },

      toggleFolder: (path: string) =>
        set(state => {
          const next = new Set(state.expandedFolders);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return { expandedFolders: next };
        }),

      expandPath: (path: string) =>
        set(state => {
          const next = new Set(state.expandedFolders);
          const parts = path.split('/').filter(Boolean);
          let current = '';
          for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            next.add(current);
          }
          return { expandedFolders: next };
        }),

      createFile: async (parentPath: string, name: string, content: string = '') => {
        const relPath = (parentPath === '/' || !parentPath) ? name : `${parentPath}/${name}`.replace(/\/+/g, '/').replace(/^\//, '');
        try {
          await fetchApi('/files', {
            method: 'POST',
            body: JSON.stringify({ path: relPath, content }),
          });
          await get().refresh();
        } catch (err) {
          console.error('Failed to create file:', err);
        }
      },

      createFolder: async (parentPath: string, name: string) => {
        const relPath = (parentPath === '/' || !parentPath) ? `${name}/.gitkeep` : `${parentPath}/${name}/.gitkeep`.replace(/\/+/g, '/').replace(/^\//, '');
        try {
          await fetchApi('/files', {
            method: 'POST',
            body: JSON.stringify({ path: relPath, content: '' }),
          });
          await get().refresh();
        } catch (err) {
          console.error('Failed to create folder:', err);
        }
      },

      deleteNode: async (path: string) => {
        const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
        try {
          await fetchApi(`/files/${normalizedPath}`, { method: 'DELETE' });
          await get().refresh();
        } catch (err) {
          console.error('Failed to delete node:', err);
        }
      },

      renameNode: async (path: string, newName: string) => {
        const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
        try {
          const fileData = await fetchApi<{ content: string }>(`/files/${normalizedPath}`);
          const parentPath = normalizedPath.includes('/') ? normalizedPath.substring(0, normalizedPath.lastIndexOf('/')) : '/';
          const newPath = parentPath === '/' ? newName : `${parentPath}/${newName}`.replace(/\/+/g, '/').replace(/^\//, '');
          
          await fetchApi('/files', {
            method: 'POST',
            body: JSON.stringify({ path: newPath, content: fileData.content }),
          });
          await fetchApi(`/files/${normalizedPath}`, { method: 'DELETE' });
          await get().refresh();
        } catch (err) {
          console.error('Failed to rename node:', err);
        }
      },

      updateContent: (path: string, content: string) =>
        set(state => {
          const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
          const files = deepClone(state.files);
          const node = findNode(files, normalizedPath);
          if (node?.type === 'file') node.content = content;
          return { files };
        }),

      fetchFileContent: async (path: string) => {
        const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
        try {
          const data = await fetchApi<{ content: string }>(`/files/${normalizedPath}`);
          set(state => {
            const files = deepClone(state.files);
            const node = findNode(files, normalizedPath);
            if (node?.type === 'file') node.content = data.content;
            
            const nextOriginalContentMap = {
              ...state.originalContentMap,
              [normalizedPath]: data.content
            };
            
            const nextSessionStartContentMap = { ...state.sessionStartContentMap };
            if (nextSessionStartContentMap[normalizedPath] === '_FILE_EXISTS_') {
              nextSessionStartContentMap[normalizedPath] = data.content;
            }

            return { 
              files, 
              originalContentMap: nextOriginalContentMap,
              sessionStartContentMap: nextSessionStartContentMap,
            };
          });
          return data.content;
        } catch (err) {
          console.error('Failed to fetch file content:', err);
          return null;
        }
      },

      saveFile: async (path: string) => {
        const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
        const node = findNode(get().files, normalizedPath);
        if (node?.type === 'file' && node.content !== undefined) {
          try {
            await fetchApi(`/files/${normalizedPath}`, {
              method: 'PUT',
              body: JSON.stringify({ content: node.content }),
            });
            set(state => ({
              originalContentMap: {
                ...state.originalContentMap,
                [normalizedPath]: node.content!,
              },
            }));
            await get().refresh();
          } catch (err) {
            console.error('Failed to save file:', err);
          }
        }
      },

      setTrackingMode: (trackingMode) => set({ trackingMode }),

      clearSessionTracking: () => set({ sessionStartContentMap: {} }),

      resetSession: () => {
        const state = get();
        const currentContents: Record<string, string> = {};
        
        const traverse = (nodes: FileNode[]) => {
          for (const node of nodes) {
            if (node.type === 'file') {
              // Store content if available, otherwise store a marker to show it existed at session start
              currentContents[node.path] = node.content !== undefined ? node.content : '_FILE_EXISTS_';
            }
            if (node.children) traverse(node.children);
          }
        };
        
        traverse(state.files);
        set({ sessionStartContentMap: currentContents });
      },

      getFileByPath: (path: string) => findNode(get().files, path),

      isUnsaved: (path: string) => {
        const state = get();
        const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
        const node = findNode(state.files, normalizedPath);
        if (!node || node.type !== 'file' || node.content === undefined) return false;
        const original = state.originalContentMap[normalizedPath];
        return original !== undefined && node.content !== original;
      },

      hasUnsavedChildren: (path: string) => {
        const state = get();
        const node = findNode(state.files, path);
        if (!node || node.type !== 'folder' || !node.children) return false;

        const checkRecursive = (n: FileNode): boolean => {
          if (n.type === 'file') return state.isUnsaved(n.path);
          return !!n.children?.some(checkRecursive);
        };

        return node.children.some(checkRecursive);
      },

      hasModifiedChildren: (path: string) => {
        const state = get();
        const node = findNode(state.files, path);
        if (!node || node.type !== 'folder' || !node.children) return false;

        const checkRecursive = (n: FileNode): boolean => {
          if (n.type === 'file') return state.getFileStatus(n.path) !== 'unchanged';
          return !!n.children?.some(checkRecursive);
        };

        return node.children.some(checkRecursive);
      },

      getFolderStatus: (path: string) => {
        const state = get();
        const node = findNode(state.files, path);
        if (!node || node.type !== 'folder' || !node.children) return 'unchanged';

        let hasAdded = false;
        let hasModified = false;

        const checkRecursive = (n: FileNode) => {
          if (n.type === 'file') {
            const status = state.getFileStatus(n.path);
            if (status === 'added') hasAdded = true;
            if (status === 'modified') hasModified = true;
          } else if (n.children) {
            n.children.forEach(checkRecursive);
          }
        };

        node.children.forEach(checkRecursive);

        if (hasAdded) return 'added';
        if (hasModified) return 'modified';
        return 'unchanged';
      },

      getFileStatus: (path: string) => {
        const state = get();
        const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
        const node = findNode(state.files, normalizedPath);
        if (!node || node.type !== 'file') return 'unchanged';

        if (state.trackingMode === 'git') {
          const gitStat = state.gitStatus[normalizedPath];
          if (gitStat === 'M') return 'modified';
          if (gitStat === 'A' || gitStat === '??') return 'added';
          return 'unchanged';
        }

        // Session mode
        const original = state.sessionStartContentMap[normalizedPath];
        if (original === undefined) return 'added'; // Truly new file
        if (original === '_FILE_EXISTS_') return 'unchanged'; // Existed at session start, content not yet loaded/changed
        if (node.content !== original) return 'modified';
        return 'unchanged';
      },

      getGitStatus: (path: string) => {
        return get().gitStatus[path];
      },

      getAllFiles: () => collectFiles(get().files),
    }),
    {
      name: 'file-system-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        expandedFolders: Array.from(state.expandedFolders),
        sessionStartContentMap: state.sessionStartContentMap,
        originalContentMap: state.originalContentMap,
        trackingMode: state.trackingMode,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        
        // Normalize expandedFolders set
        if (Array.isArray(state.expandedFolders)) {
          state.expandedFolders = new Set(state.expandedFolders);
        }

        const normalize = (path: string) => path.startsWith('/') ? path.slice(1) : path;

        // Recursively normalize tree paths
        const normalizeTree = (nodes: FileNode[]) => {
          if (!nodes) return;
          for (const node of nodes) {
            node.path = normalize(node.path);
            if (node.children) normalizeTree(node.children);
          }
        };

        if (state.files) {
          normalizeTree(state.files);
        }

        // Migrate content maps to remove leading slashes from keys
        const normalizeMap = (map: Record<string, string>) => {
          const next: Record<string, string> = {};
          if (!map) return next;
          for (const [key, value] of Object.entries(map)) {
            next[normalize(key)] = value;
          }
          return next;
        };

        if (state.sessionStartContentMap) {
          state.sessionStartContentMap = normalizeMap(state.sessionStartContentMap);
        }
        if (state.originalContentMap) {
          state.originalContentMap = normalizeMap(state.originalContentMap);
        }
      },
    }
  )
);
