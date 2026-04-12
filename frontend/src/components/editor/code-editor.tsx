import { useCallback, useRef, useMemo, useEffect } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { 
  FileCode, 
  Diff, 
  Columns2, 
  Rows3, 
  Undo2, 
  Save,
  ChevronRight,
  GitBranch,
  History,
  ClipboardCheck,
  Circle
} from 'lucide-react';
import { useState } from 'react';
import { useFileSystem } from '@/store/file-system';
import { useEditor, type DiffChange } from '@/store/editor';
import { Button } from '@/components/ui/button';
import DiffView from './diff-view';
import MarkdownPreview from './markdown-preview';

// Map language for better Monaco detection
function mapLanguage(lang?: string): string {
  const map: Record<string, string> = {
    typescript: 'typescript',
    javascript: 'javascript',
    python: 'python',
    json: 'json',
    css: 'css',
    html: 'html',
    markdown: 'markdown',
    yaml: 'yaml',
    toml: 'plaintext',
    shell: 'shell',
    sql: 'sql',
    plaintext: 'plaintext',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    xml: 'xml',
  };
  return map[lang || ''] || 'plaintext';
}

export default function CodeEditor() {
  const { 
    activeTab, 
    viewMode, 
    setViewMode, 
    diffMode, 
    setDiffMode,
    diffSource,
    setDiffSource,
    activeDiff
  } = useEditor();
  const { getFileByPath, updateContent, getFileStatus, isUnsaved, originalContentMap, saveFile, fetchGitDiff } = useFileSystem();
  const [gitHeadContent, setGitHeadContent] = useState<string | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const activeTabRef = useRef(activeTab);

  // Sync ref with state
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  const activeFile = activeTab ? getFileByPath(activeTab) : null;
  const status = activeTab ? getFileStatus(activeTab) : 'unchanged';
  const fetchFileContent = useFileSystem(state => state.fetchFileContent);

  useEffect(() => {
    if (activeTab && activeFile && activeFile.content === undefined) {
      fetchFileContent(activeTab);
    }
  }, [activeTab, activeFile, fetchFileContent]);

  useEffect(() => {
    if (activeTab && viewMode === 'diff' && diffSource === 'git-head') {
      fetchGitDiff(activeTab).then(content => setGitHeadContent(content));
    } else {
      setGitHeadContent(null);
    }
  }, [activeTab, viewMode, diffSource, fetchGitDiff]);

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;

    // Keyboard shortcuts - Use ref to avoid stale closure
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const currentTab = activeTabRef.current;
      if (currentTab) saveFile(currentTab);
    });
  }, [saveFile]);

  const handleEditorChange = useCallback((value: string | undefined) => {
    if (activeTab && value !== undefined) {
      updateContent(activeTab, value);
    }
  }, [activeTab, updateContent]);

  const localDiff = useMemo((): DiffChange | null => {
    if (!activeFile) return null;
    const original = diffSource === 'git-head' && gitHeadContent !== null 
      ? gitHeadContent 
      : (originalContentMap[activeFile.path] || '');
      
    return {
      id: 'local',
      path: activeFile.path,
      original,
      modified: activeFile.content || '',
      description: diffSource === 'git-head' ? 'Changes since last commit' : 'Local changes'
    };
  }, [activeFile, originalContentMap, diffSource, gitHeadContent]);

  // If we have an active agent diff, that takes priority for the diff view
  const currentDiff = activeDiff || localDiff;

  // No tabs open or no active file
  if (!activeTab || !activeFile) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-background text-muted-foreground">
        <div className="text-4xl mb-4 opacity-20">{'{ }'}</div>
        <p className="text-sm">Open a file from the explorer to start editing</p>
        <p className="text-xs mt-1 opacity-60">or use Ctrl+P to search files</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Enhanced Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b shrink-0 bg-muted/20">
        <div className="flex items-center gap-2 overflow-hidden">
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">
            {activeFile.path.split('/').filter(Boolean).map((part, i, arr) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="h-2 w-2 opacity-50" />}
                <span className={i === arr.length - 1 ? 'text-foreground' : ''}>{part}</span>
              </span>
            ))}
          </div>
          {status !== 'unchanged' && (
            <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase ${
              status === 'added' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-yellow-500/10 text-yellow-500'
            }`}>
              {status}
            </span>
          )}
          {isUnsaved(activeFile.path) && (
            <Circle className="h-2 w-2 fill-yellow-500 text-yellow-500 animate-pulse" />
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* View Mode Toggle */}
          <div className="flex items-center border rounded-md overflow-hidden bg-background">
            <Button
              variant={viewMode === 'editor' ? 'secondary' : 'ghost'}
              size="sm"
              className={`h-7 px-2 text-[10px] rounded-none border-0 ${viewMode === 'editor' ? 'bg-secondary' : ''}`}
              onClick={() => setViewMode('editor')}
              title="Editor View"
            >
              <FileCode className="h-3.5 w-3.5 mr-1" /> Editor
            </Button>
            <Button
              variant={viewMode === 'diff' ? 'secondary' : 'ghost'}
              size="sm"
              className={`h-7 px-2 text-[10px] rounded-none border-0 ${viewMode === 'diff' ? 'bg-secondary' : ''}`}
              onClick={() => setViewMode('diff')}
              title="Diff View"
            >
              <Diff className="h-3.5 w-3.5 mr-1" /> Diff
            </Button>
            {activeFile.name.endsWith('.md') && (
              <Button
                variant={viewMode === 'preview' ? 'secondary' : 'ghost'}
                size="sm"
                className={`h-7 px-2 text-[10px] rounded-none border-0 ${viewMode === 'preview' ? 'bg-secondary' : ''}`}
                onClick={() => setViewMode('preview' as any)}
                title="Markdown Preview"
              >
                <ClipboardCheck className="h-3.5 w-3.5 mr-1" /> Preview
              </Button>
            )}
          </div>

          {/* Diff Source Switcher */}
          {viewMode === 'diff' && (
            <div className="flex items-center border rounded-md overflow-hidden bg-background ml-1">
              <Button
                variant={diffSource === 'last-save' ? 'secondary' : 'ghost'}
                size="sm"
                className={`h-7 px-2 text-[10px] rounded-none border-0 ${diffSource === 'last-save' ? 'bg-secondary' : ''}`}
                onClick={() => setDiffSource('last-save')}
                title="Compare vs Last Save"
              >
                <Save className="h-3.5 w-3.5 mr-1" /> vs Save
              </Button>
              <Button
                variant={diffSource === 'git-head' ? 'secondary' : 'ghost'}
                size="sm"
                className={`h-7 px-2 text-[10px] rounded-none border-0 ${diffSource === 'git-head' ? 'bg-secondary' : ''}`}
                onClick={() => setDiffSource('git-head')}
                title="Compare vs Git Commit"
              >
                <GitBranch className="h-3.5 w-3.5 mr-1" /> vs Commit
              </Button>
            </div>
          )}

          {/* Diff Mode Switcher (only in diff view) */}
          {viewMode === 'diff' && (
            <div className="flex items-center border rounded-md overflow-hidden bg-background ml-1">
              <Button
                variant={diffMode === 'split' ? 'secondary' : 'ghost'}
                size="sm"
                className={`h-7 px-2 text-[10px] rounded-none border-0 ${diffMode === 'split' ? 'bg-secondary' : ''}`}
                onClick={() => setDiffMode('split')}
                title="Split View"
              >
                <Columns2 className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant={diffMode === 'inline' ? 'secondary' : 'ghost'}
                size="sm"
                className={`h-7 px-2 text-[10px] rounded-none border-0 ${diffMode === 'inline' ? 'bg-secondary' : ''}`}
                onClick={() => setDiffMode('inline')}
                title="Inline View"
              >
                <Rows3 className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}

          <div className="h-4 w-[1px] bg-border mx-1" />

          {(status !== 'unchanged' || isUnsaved(activeFile.path)) && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={() => saveFile(activeTab)}
              title="Save changes"
            >
              <Save className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 min-h-0">
        {viewMode === 'editor' ? (
          <Editor
            height="100%"
            language={mapLanguage(activeFile.language)}
            value={activeFile.content || ''}
            theme="vs-dark"
            onChange={handleEditorChange}
            onMount={handleEditorMount}
            options={{
              fontSize: 13,
              fontFamily: "'Geist Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
              fontLigatures: true,
              lineNumbers: 'on',
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              padding: { top: 8, bottom: 8 },
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              renderLineHighlight: 'line',
              bracketPairColorization: { enabled: true },
              guides: {
                bracketPairs: true,
                indentation: true,
              },
              suggest: {
                showKeywords: true,
                showSnippets: true,
              },
              wordWrap: 'off',
              automaticLayout: true,
              tabSize: 2,
            }}
            loading={
              <div className="h-full flex items-center justify-center bg-[#1e1e1e] text-muted-foreground text-sm">
                Loading editor...
              </div>
            }
          />
        ) : viewMode === 'diff' ? (
          currentDiff ? (
            <DiffView diff={currentDiff} isLocal={!activeDiff} />
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground bg-muted/5">
              <Diff className="h-8 w-8 mb-2 opacity-20" />
              <p className="text-sm">No changes to display</p>
            </div>
          )
        ) : (
          <MarkdownPreview content={activeFile.content || ''} />
        )}
      </div>
    </div>
  );
}
