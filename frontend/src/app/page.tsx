'use client';

import dynamic from 'next/dynamic';

// Dynamic import to avoid SSR issues with Monaco Editor
const EditorLayout = dynamic(
  () => import('@/components/editor/editor-layout'),
  { ssr: false }
);

export default function Home() {
  return <EditorLayout />;
}
