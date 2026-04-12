import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Agentic Code Editor - AI-Powered Development",
  description: "Modern agentic code editor optimized for AI-powered development. Built with TypeScript, Tailwind CSS, and shadcn/ui.",
  keywords: ["AI", "Code Editor", "Next.js", "TypeScript", "Tailwind CSS", "shadcn/ui"],
  authors: [{ name: "Agentic Editor Team" }],
  icons: {
    icon: "/favicon.png",
  },
  openGraph: {
    title: "Agentic Code Editor",
    description: "AI-powered development with modern React stack",
    url: "http://localhost:3000",
    siteName: "AgenticEditor",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Agentic Code Editor",
    description: "AI-powered development with modern React stack",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground overflow-hidden`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
