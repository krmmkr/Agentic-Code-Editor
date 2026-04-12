'use client';

import { useAgent, type ImplementationPlan, type PlanStep } from '@/store/agent';
import { useEditor } from '@/store/editor';
import { useFileSystem } from '@/store/file-system';
import {
  Check,
  X,
  FileCode,
  Loader2,
  Circle,
  CircleCheck,
  CircleX,
  Lightbulb,
  AlertTriangle,
  ChevronRight,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';

function StepStatusIcon({ status }: { status: PlanStep['status'] }) {
  switch (status) {
    case 'pending':
      return <Circle className="h-4 w-4 text-muted-foreground/40 shrink-0 mt-0.5" />;
    case 'running':
      return <Loader2 className="h-4 w-4 text-blue-400 shrink-0 mt-0.5 animate-spin" />;
    case 'completed':
      return <CircleCheck className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />;
    case 'failed':
      return <CircleX className="h-4 w-4 text-destructive shrink-0 mt-0.5" />;
  }
}

function StepCard({ step, index }: { step: PlanStep; index: number }) {
  const { openFile } = useEditor();
  const { expandPath } = useFileSystem();

  const handleClickFile = (filePath: string) => {
    expandPath(filePath);
    openFile(filePath);
  };

  return (
    <div
      className={`
        rounded-lg border p-3 transition-colors
        ${step.status === 'running' ? 'border-blue-500/30 bg-blue-500/5' : ''}
        ${step.status === 'completed' ? 'border-emerald-500/20 bg-emerald-500/5' : ''}
        ${step.status === 'failed' ? 'border-destructive/30 bg-destructive/5' : ''}
        ${step.status === 'pending' ? 'border-border/50 bg-muted/20' : ''}
      `}
    >
      <div className="flex items-start gap-2.5">
        <StepStatusIcon status={step.status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-mono text-muted-foreground">
              Step {index + 1}
            </span>
            {step.status === 'running' && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 border-blue-500/30 text-blue-400">
                Running
              </Badge>
            )}
            {step.status === 'completed' && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 border-emerald-500/30 text-emerald-400">
                Done
              </Badge>
            )}
            {step.status === 'failed' && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 border-destructive/30 text-destructive">
                Failed
              </Badge>
            )}
          </div>
          <p className={`text-sm leading-relaxed ${
            step.status === 'completed' ? 'text-muted-foreground' : ''
          }`}>
            {step.description}
          </p>
          {step.detail && (
            <p className="text-xs text-muted-foreground mt-1">{step.detail}</p>
          )}
          {/* Affected files */}
          {step.files.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {step.files.map(f => (
                <button
                  key={f}
                  onClick={() => handleClickFile(f)}
                  className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent/60 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                  <ChevronRight className="h-2.5 w-2.5" />
                  {f}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PlanDocument() {
  // Always read DIRECTLY from the store — no local state copy that can go stale
  const { currentPlan } = useAgent();

  if (!currentPlan) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        No active plan
      </div>
    );
  }

  const isPending = currentPlan.status === 'pending';
  const isApproved = currentPlan.status === 'approved';
  const isRejected = currentPlan.status === 'rejected';
  const completedSteps = currentPlan.steps.filter(s => s.status === 'completed').length;
  const totalSteps = currentPlan.steps.length;
  const progress = totalSteps > 0 ? (completedSteps / totalSteps) * 100 : 0;

  return (
    <ScrollArea className="h-full">
      <div className="max-w-2xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className={`h-7 w-7 rounded-lg flex items-center justify-center ${
                isApproved ? 'bg-emerald-500/10' : isRejected ? 'bg-destructive/10' : 'bg-primary/10'
              }`}>
                <Lightbulb className={`h-4 w-4 ${
                  isApproved ? 'text-emerald-500' : isRejected ? 'text-destructive' : 'text-primary'
                }`} />
              </div>
              {isPending && (
                <Badge variant="outline" className="text-[10px] h-5 px-2">
                  Awaiting Approval
                </Badge>
              )}
              {isApproved && (
                <Badge variant="outline" className="text-[10px] h-5 px-2 border-emerald-500/30 text-emerald-400">
                  Approved ✓
                </Badge>
              )}
              {isRejected && (
                <Badge variant="outline" className="text-[10px] h-5 px-2 border-destructive/30 text-destructive">
                  Rejected
                </Badge>
              )}
            </div>
            {isPending && (
              <span className="text-[10px] text-muted-foreground italic">
                Use the Approve button in the Chat panel →
              </span>
            )}
          </div>

          <h1 className="text-xl font-bold text-foreground mb-2">
            {currentPlan.title}
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {currentPlan.description}
          </p>
        </div>

        {/* Reasoning */}
        {currentPlan.reasoning && (
          <div className="mb-6 p-3 rounded-lg bg-muted/30 border border-border/50">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Analysis &amp; Reasoning
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
              {currentPlan.reasoning}
            </p>
          </div>
        )}

        {/* Files Analyzed */}
        <div className="mb-6">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Files Analyzed
          </div>
          <div className="flex flex-wrap gap-1.5">
            {Array.from(new Set(currentPlan.steps.flatMap(s => s.files))).map(f => (
              <span
                key={f}
                className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-1 rounded-md bg-muted/50 border border-border/50 text-muted-foreground"
              >
                <FileCode className="h-3 w-3" />
                {f}
              </span>
            ))}
          </div>
        </div>

        {/* Progress bar — only shown during/after implementation */}
        {isApproved && totalSteps > 0 && (
          <div className="mb-6">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1.5">
              <span>Progress</span>
              <span>{completedSteps} / {totalSteps} steps</span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        {/* Implementation Steps — always reads live from store */}
        <div className="mb-8">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Implementation Steps
          </div>
          <div className="space-y-2">
            {currentPlan.steps.map((step, idx) => (
              <StepCard key={step.id} step={step} index={idx} />
            ))}
          </div>
        </div>

        {isRejected && (
          <div className="flex items-center gap-2 pt-4 border-t text-xs text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Plan was rejected. Send a new message to start over.
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
