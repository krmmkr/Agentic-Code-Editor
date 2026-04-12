import { useCallback, useMemo } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { Check, X, ArrowLeft, FileCode, Columns2, Rows3, ShieldCheck, ShieldX } from 'lucide-react';
import { useEditor, type DiffChange } from '@/store/editor';
import { useAgent } from '@/store/agent';
import { Button } from '@/components/ui/button';

interface DiffViewProps {
  diff: DiffChange;
  isLocal?: boolean;
}

export default function DiffView({ diff, isLocal = false }: DiffViewProps) {
  const { setDiffView, diffMode, setDiffMode } = useEditor();
  const { acceptChange, rejectChange } = useAgent();

  const isAccepted = diff.accepted === true;
  const isRejected = diff.rejected === true;
  const isResolved = isAccepted || isRejected;

  const handleAccept = useCallback(() => {
    acceptChange(diff.id);
    setDiffView(null);
  }, [diff.id, acceptChange, setDiffView]);

  const handleReject = useCallback(() => {
    rejectChange(diff.id);
    setDiffView(null);
  }, [diff.id, rejectChange, setDiffView]);

  const handleBack = useCallback(() => {
    setDiffView(null);
  }, [setDiffView]);

  const sideBySide = diffMode === 'split';

  const editorOptions = useMemo(() => ({
    fontSize: 13,
    fontFamily: "'Geist Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
    fontLigatures: true,
    readOnly: true,
    renderSideBySide: sideBySide,
    useInlineViewWhenSpaceIsLimited: false,
    renderIndicators: true,
    diffWordWrap: 'off' as const,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    padding: { top: 8, bottom: 8 },
    lineNumbers: 'on' as const,
    renderLineHighlight: 'line' as const,
    automaticLayout: true,
    ignoreTrimWhitespace: false,
  }), [sideBySide]);

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header bar — only show if NOT in the main editor tab which already has a header */}
      {!isLocal && (
        <div className="flex items-center justify-between px-4 py-2 border-b shrink-0 bg-muted/30">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleBack}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-2">
              <FileCode className="h-4 w-4 text-orange-400" />
              <span className="text-sm font-medium">{diff.path}</span>
            </div>
            {diff.description && (
              <span className="text-xs text-muted-foreground">— {diff.description}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Diff mode toggle */}
            <div className="flex items-center border rounded-md overflow-hidden mr-1">
              <Button
                variant={sideBySide ? 'secondary' : 'ghost'}
                size="sm"
                className={`h-7 px-2 text-xs rounded-none border-0 ${sideBySide ? 'bg-secondary' : ''}`}
                onClick={() => setDiffMode('split')}
                title="Side by side view"
              >
                <Columns2 className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant={!sideBySide ? 'secondary' : 'ghost'}
                size="sm"
                className={`h-7 px-2 text-xs rounded-none border-0 ${!sideBySide ? 'bg-secondary' : ''}`}
                onClick={() => setDiffMode('inline')}
                title="Inline (red/green) view"
              >
                <Rows3 className="h-3.5 w-3.5" />
              </Button>
            </div>

            {/* Action buttons — show accept/reject only if not yet resolved */}
            {!isResolved && (
              <>
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={handleReject}
                >
                  <X className="h-3.5 w-3.5 mr-1" /> Reject
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  onClick={handleAccept}
                >
                  <Check className="h-3.5 w-3.5 mr-1" /> Accept
                </Button>
              </>
            )}

            {/* Status badge when already resolved */}
            {isResolved && (
              <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium ${
                isAccepted
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                  : 'bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20'
              }`}>
                {isAccepted ? (
                  <>
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Accepted
                  </>
                ) : (
                  <>
                    <ShieldX className="h-3.5 w-3.5" />
                    Rejected
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Labels */}
      {sideBySide && (
        <div className="flex text-[10px] border-b shrink-0 bg-muted/5 font-mono">
          <div className="flex-1 px-4 py-1 border-r border-border text-red-400 bg-red-500/5 flex items-center gap-1.5">
            <div className="h-1.5 w-1.5 rounded-full bg-red-400" /> Original
          </div>
          <div className="flex-1 px-4 py-1 text-emerald-400 bg-emerald-500/5 flex items-center gap-1.5">
            <div className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Modified
          </div>
        </div>
      )}
      {!sideBySide && (
        <div className="flex items-center gap-3 text-[10px] border-b px-4 py-1 shrink-0 bg-muted/5 font-mono">
          <div className="flex items-center gap-1.5 text-red-400">
            <div className="h-1.5 w-1.5 rounded-full bg-red-400" /> Removed
          </div>
          <div className="flex items-center gap-1.5 text-emerald-400">
            <div className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Added
          </div>
          <span className="text-muted-foreground ml-auto opacity-50">Inline Mode</span>
        </div>
      )}

      {/* Diff Editor */}
      <div className="flex-1 min-h-0">
        <DiffEditor
          key={sideBySide ? 'side-by-side' : 'inline'}
          height="100%"
          original={diff.original}
          modified={diff.modified}
          theme="vs-dark"
          options={editorOptions}
          loading={
            <div className="h-full flex items-center justify-center bg-[#1e1e1e] text-muted-foreground text-sm">
              Loading diff...
            </div>
          }
        />
      </div>
    </div>
  );
}
