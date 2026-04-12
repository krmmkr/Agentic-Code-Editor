'use client';

import { useState, useRef, useEffect } from 'react';
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  Plus,
  FolderPlus,
  Trash2,
  Pencil,
  FileCode,
  FileJson,
  FileText,
  FileType,
  Search,
  X,
  History as HistoryIcon,
  RefreshCw,
  Circle,
  RotateCcw,
} from 'lucide-react';
import { fetchApi } from '@/lib/api-client';
import { useFileSystem, type FileNode } from '@/store/file-system';
import { useEditor } from '@/store/editor';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import FolderPicker from './folder-picker';

// File icon mapping
function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const nameLower = name.toLowerCase();

  const iconProps = { className: 'h-4 w-4 shrink-0' };

  if (nameLower === 'dockerfile' || nameLower === 'makefile')
    return <FileCode {...iconProps} className={`${iconProps.className} text-green-500`} />;
  if (['py'].includes(ext))
    return <FileCode {...iconProps} className={`${iconProps.className} text-yellow-500`} />;
  if (['ts', 'tsx'].includes(ext))
    return <FileCode {...iconProps} className={`${iconProps.className} text-blue-400`} />;
  if (['js', 'jsx'].includes(ext))
    return <FileCode {...iconProps} className={`${iconProps.className} text-yellow-400`} />;
  if (['json'].includes(ext))
    return <FileJson {...iconProps} className={`${iconProps.className} text-yellow-600`} />;
  if (['md'].includes(ext))
    return <FileText {...iconProps} className={`${iconProps.className} text-slate-400`} />;
  if (['toml', 'yaml', 'yml'].includes(ext))
    return <FileType {...iconProps} className={`${iconProps.className} text-purple-400`} />;
  if (['css', 'scss', 'less'].includes(ext))
    return <FileCode {...iconProps} className={`${iconProps.className} text-pink-400`} />;
  if (['html', 'htm', 'svg'].includes(ext))
    return <FileCode {...iconProps} className={`${iconProps.className} text-orange-500`} />;
  if (['txt', 'env', 'gitignore'].includes(ext) || !ext)
    return <FileText {...iconProps} className={`${iconProps.className} text-slate-400`} />;
  return <File {...iconProps} className={`${iconProps.className} text-muted-foreground`} />;
}

interface TreeItemProps {
  node: FileNode;
  depth: number;
}

function TreeItem({ node, depth }: TreeItemProps) {
  const { expandedFolders, toggleFolder, deleteNode, renameNode, createFile, createFolder } = useFileSystem();
  const { openFile, activeTab } = useEditor();
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  const [isCreating, setIsCreating] = useState<'file' | 'folder' | null>(null);
  const [createValue, setCreateValue] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);
  const createRef = useRef<HTMLInputElement>(null);

  const isExpanded = expandedFolders.has(node.path);
  const isActive = activeTab === node.path;

  useEffect(() => {
    if (isRenaming && renameRef.current) {
      renameRef.current.focus();
      renameRef.current.select();
    }
  }, [isRenaming]);

  useEffect(() => {
    if (isCreating && createRef.current) {
      createRef.current.focus();
    }
  }, [isCreating]);

  const handleClick = () => {
    if (node.type === 'folder') {
      toggleFolder(node.path);
    } else {
      openFile(node.path);
    }
  };

  const handleRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== node.name) {
      renameNode(node.path, trimmed);
    }
    setIsRenaming(false);
  };

  const handleCreate = () => {
    const trimmed = createValue.trim();
    if (trimmed) {
      if (isCreating === 'file') {
        createFile(node.type === 'folder' ? node.path : node.path.substring(0, node.path.lastIndexOf('/')), trimmed);
      } else {
        createFolder(node.type === 'folder' ? node.path : node.path.substring(0, node.path.lastIndexOf('/')), trimmed);
      }
    }
    setIsCreating(null);
    setCreateValue('');
  };

  const handleDelete = () => {
    deleteNode(node.path);
  };

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger>
          <div
            className={`
              group flex items-center gap-1 px-2 py-1 cursor-pointer text-sm
              hover:bg-accent rounded-sm
              ${isActive ? 'bg-accent text-accent-foreground' : 'text-foreground'}
            `}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
            onClick={handleClick}
          >
            {/* Expand/collapse for folders */}
            {node.type === 'folder' ? (
              <>
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                {isExpanded ? (
                  <FolderOpen className="h-4 w-4 shrink-0 text-yellow-500" />
                ) : (
                  <Folder className="h-4 w-4 shrink-0 text-yellow-500" />
                )}
              </>
            ) : (
              <>
                <span className="w-3.5" />
                <FileIcon name={node.name} />
              </>
            )}

            {/* Name or rename input */}
            {isRenaming ? (
              <Input
                ref={renameRef}
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                onBlur={handleRename}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleRename();
                  if (e.key === 'Escape') { setIsRenaming(false); setRenameValue(node.name); }
                }}
                className="h-5 px-1 py-0 text-xs border-primary"
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <div className="flex-1 flex items-center gap-2 truncate">
                <span className={`truncate ${(() => {
                  const { pendingChanges } = useEditor.getState();
                  const { getFileStatus, getFolderStatus } = useFileSystem.getState();
                  
                  const agentChange = pendingChanges.find(c => c.path === node.path && !c.accepted && !c.rejected);
                  if (agentChange) {
                    return agentChange.original === '' || agentChange.original === null ? 'text-emerald-500' : 'text-yellow-500';
                  }

                  const status = node.type === 'file' ? getFileStatus(node.path) : getFolderStatus(node.path);
                  if (status === 'added') return 'text-emerald-500';
                  if (status === 'modified') return 'text-yellow-500';
                  return '';
                })()}`}>
                  {node.name}
                  {(node.type === 'file' ? useFileSystem.getState().isUnsaved(node.path) : useFileSystem.getState().hasUnsavedChildren(node.path)) && (
                    <Circle className="h-1.5 w-1.5 fill-yellow-500 text-yellow-500 ml-1.5 shrink-0" />
                  )}
                </span>

                {/* Git Status Badge */}
                {(() => {
                  const { getGitStatus, trackingMode } = useFileSystem.getState();
                  if (trackingMode !== 'git') return null;
                  
                  const gitCode = getGitStatus(node.path);
                  if (!gitCode) return null;

                  if (gitCode === 'M') return <span className="text-[10px] font-bold text-yellow-500 px-1 border border-yellow-500/30 rounded bg-yellow-500/10">M</span>;
                  if (gitCode === 'A' || gitCode === '??') return <span className="text-[10px] font-bold text-emerald-500 px-1 border border-emerald-500/30 rounded bg-emerald-500/10">{gitCode === '??' ? 'U' : 'A'}</span>;
                  if (gitCode === 'D') return <span className="text-[10px] font-bold text-red-500 px-1 border border-red-500/30 rounded bg-red-500/10">D</span>;
                  return null;
                })()}
              </div>
            )}

            {/* Action buttons on hover */}
            {!isRenaming && (
              <div className="hidden group-hover:flex items-center gap-0.5 ml-auto">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5"
                  onClick={e => { e.stopPropagation(); setIsCreating('file'); }}
                >
                  <Plus className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5"
                  onClick={e => { e.stopPropagation(); setIsCreating('folder'); }}
                >
                  <FolderPlus className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5"
                  onClick={e => { e.stopPropagation(); setIsRenaming(true); setRenameValue(node.name); }}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 text-destructive hover:text-destructive"
                  onClick={e => { e.stopPropagation(); handleDelete(); }}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {node.type === 'folder' && (
            <>
              <ContextMenuItem onClick={() => setIsCreating('file')}>
                <Plus className="h-4 w-4 mr-2" /> New File
              </ContextMenuItem>
              <ContextMenuItem onClick={() => setIsCreating('folder')}>
                <FolderPlus className="h-4 w-4 mr-2" /> New Folder
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onClick={() => { setIsRenaming(true); setRenameValue(node.name); }}>
            <Pencil className="h-4 w-4 mr-2" /> Rename
          </ContextMenuItem>
          <ContextMenuItem onClick={handleDelete} className="text-destructive">
            <Trash2 className="h-4 w-4 mr-2" /> Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Inline create input */}
      {isCreating && (
        <div
          className="flex items-center gap-1 px-2 py-1 text-sm"
          style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
        >
          {isCreating === 'folder' ? (
            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <File className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <Input
            ref={createRef}
            value={createValue}
            onChange={e => setCreateValue(e.target.value)}
            onBlur={handleCreate}
            onKeyDown={e => {
              if (e.key === 'Enter') handleCreate();
              if (e.key === 'Escape') { setIsCreating(null); setCreateValue(''); }
            }}
            placeholder={isCreating === 'file' ? 'filename.ext' : 'folder name'}
            className="h-5 px-1 py-0 text-xs border-primary"
          />
        </div>
      )}

      {/* Children */}
      {node.type === 'folder' && isExpanded && node.children && (
        <div>
          {node.children.map(child => (
            <TreeItem key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function FileTree() {
  const { 
    files, 
    createFile, 
    createFolder, 
    init, 
    refresh, 
    trackingMode, 
    setTrackingMode,
    resetSession,
    hasUnsavedChildren,
    hasModifiedChildren
  } = useFileSystem();
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    if (isSearchOpen && searchRef.current) {
      searchRef.current.focus();
    }
  }, [isSearchOpen]);

  const toggleSearch = () => {
    setIsSearchOpen(prev => !prev);
    if (isSearchOpen) {
      setSearchQuery('');
    }
  };

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Explorer
        </span>
        <div className="flex items-center gap-0.5">
          <Button 
            variant="ghost" 
            size="icon" 
            className="h-6 w-6" 
            onClick={() => setIsPickerOpen(true)}
            title="Open Folder"
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={toggleSearch}>
            {isSearchOpen ? <X className="h-3.5 w-3.5" /> : <Search className="h-3.5 w-3.5" />}
          </Button>
          <Button 
            variant="ghost" 
            size="icon" 
            className="h-6 w-6" 
            onClick={() => refresh()}
            title="Sync File Tree & Git Status"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6">
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => createFile('/', 'untitled.py')}>
                <Plus className="h-4 w-4 mr-2" /> New File
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => createFolder('/', 'new-folder')}>
                <FolderPlus className="h-4 w-4 mr-2" /> New Folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button 
            variant="ghost" 
            size="icon" 
            className="h-6 w-6" 
            onClick={async () => {
              try {
                await fetchApi('/session/summary', { method: 'POST' });
                refresh();
              } catch (err) {
                console.error('Failed to generate summary:', err);
              }
            }}
            title="Generate Session Summary"
          >
            <HistoryIcon className="h-3.5 w-3.5 text-blue-400" />
          </Button>
        </div>
      </div>

      {/* Tracking Toggle Bar */}
      <div className="px-3 py-1.5 border-b bg-muted/20 flex items-center justify-between gap-2">
        <div className="flex bg-background border rounded p-0.5 gap-0.5">
          <Button
            variant={trackingMode === 'session' ? 'secondary' : 'ghost'}
            className="h-5 px-2 text-[10px] rounded-sm"
            onClick={() => setTrackingMode('session')}
          >
            Session
          </Button>
          <Button
            variant={trackingMode === 'git' ? 'secondary' : 'ghost'}
            className="h-5 px-2 text-[10px] rounded-sm"
            onClick={() => setTrackingMode('git')}
          >
            Git
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
            {trackingMode === 'session' ? 'Session tracking' : 'Git diff mode'}
          </span>
          <Button
            variant="ghost" 
            size="icon" 
            className="h-6 w-6 rounded-sm hover:bg-destructive/10 hover:text-destructive"
            onClick={() => {
              if (confirm('Finish current session? This will reset all modification markers to the current file states.')) {
                resetSession();
              }
            }}
            title="Finish Session (Reset indicators)"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Search */}
      {isSearchOpen && (
        <div className="px-2 py-1.5 border-b shrink-0">
          <Input
            ref={searchRef}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search files..."
            className="h-7 text-xs"
          />
        </div>
      )}

      {/* Tree */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden py-1">
        {files.map(node => (
          <TreeItem key={node.id} node={node} depth={0} />
        ))}
        {files.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No files in workspace
          </div>
        )}
      </div>

      {/* Folder Picker Modal */}
      <FolderPicker open={isPickerOpen} onOpenChange={setIsPickerOpen} />
    </div>
  );
}
