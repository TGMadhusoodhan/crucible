import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Crucible — Bring any AI. Build better code.',
  description: 'Model-agnostic multi-LLM coding tool. Two models review every file. You decide what ships.',
  openGraph: {
    title: 'Crucible',
    description: 'Bring any AI. Build better code.',
    type: 'website',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="scroll-smooth">
      <body className="bg-zinc-950 text-zinc-100 antialiased">
        {children}
      </body>
    </html>
  )
}
