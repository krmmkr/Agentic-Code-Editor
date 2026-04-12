'use client';

import { useState, useEffect } from 'react';
import { 
  Folder, 
  ChevronRight, 
  ChevronLeft, 
  FolderOpen, 
  X,
  Search,
  Home
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle, 
  DialogFooter 
} from '@/components/ui/dialog';
import { fetchApi } from '@/lib/api-client';
import { useFileSystem } from '@/store/file-system';

interface FolderEntry {
  name: string;
  path: string;
  type: 'directory';
}

interface BrowseResponse {
  current_path: string;
  parent_path: string | null;
  entries: FolderEntry[];
}

interface FolderPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function FolderPicker({ open, onOpenChange }: FolderPickerProps) {
  const [currentPath, setCurrentPath] = useState<string>('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FolderEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [editedPath, setEditedPath] = useState('');
  const { switchWorkspace, currentWorkspacePath } = useFileSystem();

  const fetchPath = async (path: string = '') => {
    setLoading(true);
    try {
      const data = await fetchApi<BrowseResponse>(`/browse?path=${encodeURIComponent(path)}`);
      setCurrentPath(data.current_path);
      setParentPath(data.parent_path);
      setEntries(data.entries);
    } catch (err) {
      console.error('Failed to browse path:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      fetchPath(currentWorkspacePath || '');
    }
  }, [open, currentWorkspacePath]);

  const handleOpen = async () => {
    try {
      await switchWorkspace(currentPath);
      onOpenChange(false);
    } catch (err) {
      console.error('Failed to switch workspace:', err);
    }
  };

  const filteredEntries = entries.filter(e => 
    e.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] h-[600px] flex flex-col p-0">
        <DialogHeader className="p-4 border-b">
          <DialogTitle className="flex items-center gap-2">
            <FolderOpen className="h-5 w-5 text-primary" />
            Open Folder
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-hidden flex flex-col">
          {/* Breadcrumbs / Path Input */}
          <div className="p-3 bg-muted/30 flex flex-col gap-2 border-b">
            <div className="flex items-center gap-2">
              <Button 
                variant="ghost" 
                size="icon" 
                className="h-8 w-8" 
                onClick={() => parentPath && fetchPath(parentPath)}
                disabled={!parentPath || loading}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div 
                className="flex-1 flex items-center gap-1 bg-background border px-2 py-1 rounded text-xs overflow-hidden font-mono cursor-text focus-within:ring-1 focus-within:ring-primary"
                onClick={() => { setIsEditingPath(true); setEditedPath(currentPath); }}
              >
                <Home className="h-3 w-3 shrink-0 text-muted-foreground" />
                {isEditingPath ? (
                  <Input
                    value={editedPath}
                    onChange={e => setEditedPath(e.target.value)}
                    onBlur={() => setIsEditingPath(false)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        fetchPath(editedPath);
                        setIsEditingPath(false);
                      }
                      if (e.key === 'Escape') setIsEditingPath(false);
                    }}
                    className="h-4 p-0 border-none bg-transparent focus-visible:ring-0 text-xs font-mono"
                    autoFocus
                  />
                ) : (
                  <span className="truncate">{currentPath}</span>
                )}
              </div>
              <Button 
                variant="ghost" 
                size="icon" 
                className="h-8 w-8 text-muted-foreground hover:text-primary" 
                onClick={() => fetchPath(currentWorkspacePath)}
                disabled={loading || !currentWorkspacePath}
                title="Reset to workspace"
              >
                <Home className="h-4 w-4" />
              </Button>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search folders..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="pl-8 h-8 text-xs"
              />
            </div>
          </div>

          {/* Directory List */}
          <div className="flex-1 overflow-y-auto min-h-0">
            <div className="p-1">
              {loading ? (
                <div className="p-4 text-center text-sm text-muted-foreground">Loading...</div>
              ) : (
                filteredEntries.map(entry => (
                  <button
                    key={entry.path}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent rounded-sm transition-colors text-left group"
                    onClick={() => fetchPath(entry.path)}
                  >
                    <Folder className="h-4 w-4 text-yellow-500 fill-yellow-500/20" />
                    <span className="truncate flex-1">{entry.name}</span>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100" />
                  </button>
                ))
              )}
              {!loading && filteredEntries.length === 0 && (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  No folders found
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="p-4 border-t bg-muted/10">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleOpen} disabled={!currentPath || loading}>
            Open This Folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
