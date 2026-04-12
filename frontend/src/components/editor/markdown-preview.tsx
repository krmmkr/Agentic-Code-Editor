'use client';

import ReactMarkdown from 'react-markdown';
import { FileText, ClipboardCheck, Info } from 'lucide-react';

interface MarkdownPreviewProps {
  content: string;
}

export default function MarkdownPreview({ content }: MarkdownPreviewProps) {
  if (!content) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground bg-muted/5">
        <FileText className="h-8 w-8 mb-2 opacity-20" />
        <p className="text-sm">No content to preview</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background p-8 lg:p-12 selection:bg-primary/20">
      <div className="max-w-3xl mx-auto">
        <article className="prose prose-invert prose-slate max-w-none 
          prose-headings:font-bold prose-headings:tracking-tight prose-headings:text-foreground
          prose-h1:text-3xl prose-h1:mb-6 prose-h1:pb-4 prose-h1:border-b
          prose-h2:text-2xl prose-h2:mt-10 prose-h2:mb-4
          prose-h3:text-xl prose-h3:mt-8 prose-h3:mb-3
          prose-p:text-muted-foreground prose-p:leading-relaxed prose-p:mb-4
          prose-strong:text-foreground prose-strong:font-semibold
          prose-ul:my-6 prose-ul:list-disc prose-ul:pl-6
          prose-li:text-muted-foreground prose-li:mb-2
          prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-foreground prose-code:text-[0.9em] prose-code:before:content-none prose-code:after:content-none
          prose-pre:bg-muted/50 prose-pre:p-4 prose-pre:rounded-lg prose-pre:border
          prose-blockquote:border-l-4 prose-blockquote:border-primary prose-blockquote:bg-primary/5 prose-blockquote:py-1 prose-blockquote:px-4 prose-blockquote:italic
          prose-hr:my-10 prose-hr:border-border
        ">
          <ReactMarkdown
            components={{
              h1: ({ children }) => <h1 className="flex items-center gap-3">{children}</h1>,
              h2: ({ children }) => <h2 className="flex items-center gap-2">{children}</h2>,
              blockquote: ({ children }) => (
                <blockquote className="rounded-r-md">
                  <div className="flex gap-2">
                    <Info className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                    <div className="flex-1">{children}</div>
                  </div>
                </blockquote>
              ),
              // Support for standard markdown tables
              table: ({ children }) => (
                <div className="my-8 overflow-x-auto border rounded-lg">
                  <table className="w-full text-sm border-collapse">{children}</table>
                </div>
              ),
              th: ({ children }) => <th className="bg-muted/50 px-4 py-3 text-left font-bold border-b">{children}</th>,
              td: ({ children }) => <td className="px-4 py-3 border-b border-muted/30">{children}</td>,
            }}
          >
            {content}
          </ReactMarkdown>
        </article>
      </div>
    </div>
  );
}
