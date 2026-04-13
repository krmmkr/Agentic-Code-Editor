'use client';

import { Check, X, FileCode, ListOrdered, Lightbulb, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAgent, type ImplementationPlan } from '@/store/agent';
import { useEditor, PLAN_TAB_ID } from '@/store/editor';

interface PlanCardProps {
  plan: ImplementationPlan;
  onApprove?: () => void;
  onReject?: (reason?: string) => void;
}

export default function PlanCard({ plan, onApprove, onReject }: PlanCardProps) {
  const isPending = plan.status === 'pending';
  const isApproved = plan.status === 'approved';
  const isRejected = plan.status === 'rejected';
  const activeTab = useEditor(state => state.activeTab);
  const isPlanActive = activeTab === PLAN_TAB_ID;

  return (
    <div
      className={`
        rounded-lg border p-3 my-2 text-sm
        ${isApproved ? 'border-emerald-500/30 bg-emerald-500/5' : ''}
        ${isRejected ? 'border-destructive/30 bg-destructive/5' : ''}
        ${isPending ? 'border-primary/30 bg-primary/5' : ''}
      `}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <div className={`h-6 w-6 rounded-md flex items-center justify-center shrink-0 ${
            isApproved ? 'bg-emerald-500/10' : isRejected ? 'bg-destructive/10' : 'bg-primary/10'
          }`}>
            <Lightbulb className={`h-3.5 w-3.5 ${
              isApproved ? 'text-emerald-500' : isRejected ? 'text-destructive' : 'text-primary'
            }`} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="font-semibold text-xs">{plan.title}</h4>
              {!isPlanActive && (
                <button
                  onClick={() => useEditor.getState().openPlanTab()}
                  className="inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                  title="View full plan in editor"
                >
                  <ExternalLink className="h-2.5 w-2.5" />
                  View
                </button>
              )}
            </div>
            {isPending && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 mt-0.5">
                Awaiting Approval
              </Badge>
            )}
            {isApproved && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 mt-0.5 border-emerald-500/30 text-emerald-500">
                Approved
              </Badge>
            )}
            {isRejected && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 mt-0.5 border-destructive/30 text-destructive">
                Rejected
              </Badge>
            )}
          </div>
        </div>
      </div>

      {/* Description */}
      <p className="text-xs text-muted-foreground leading-relaxed mb-3">
        {plan.description}
      </p>

      {/* Steps */}
      <div className="space-y-1.5 mb-3">
        <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          <ListOrdered className="h-3 w-3" />
          Implementation Steps
        </div>
        {plan.steps.map((step, idx) => (
          <div
            key={step.id}
            className="flex items-start gap-2 px-2 py-1.5 rounded-md bg-muted/50"
          >
            <span className="text-[10px] font-mono text-muted-foreground mt-px shrink-0">
              {idx + 1}.
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-xs">{step.description}</p>
              {step.files.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {step.files.map(f => (
                    <span
                      key={f}
                      className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent text-muted-foreground"
                    >
                      <FileCode className="h-2.5 w-2.5" />
                      {f.split('/').pop()}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Action buttons */}
      {isPending && (
        <div className="space-y-2 pt-2 border-t">
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[10px]"
              onClick={() => useEditor.getState().openFile('implementation_plan.md')}
            >
              <ExternalLink className="h-3 w-3 mr-1" />
              Edit Plan.md
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[10px]"
              onClick={() => useEditor.getState().openFile('task_list.md')}
            >
              <ExternalLink className="h-3 w-3 mr-1" />
              Edit Tasks.md
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-7 text-xs flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={onApprove}
            >
              <Check className="h-3.5 w-3.5 mr-1" />
              Approve Plan
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-7 text-xs flex-1"
              onClick={() => onReject?.()}
            >
              <X className="h-3.5 w-3.5 mr-1" />
              Reject Plan
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
