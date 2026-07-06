'use client'

import { useState } from 'react'

export default function Home() {
  return (
    <main className="min-h-screen">
      <Nav />
      <Hero />
      <Problem />
      <HowItWorks />
      <Features />
      <Install />
      <Footer />
    </main>
  )
}

// ─── Nav ─────────────────────────────────────────────────────────────────────

function Nav() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-zinc-800/60 bg-zinc-950/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <span className="text-sm font-semibold tracking-tight text-zinc-100">
          Crucible <span className="ml-1.5 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">beta</span>
        </span>
        <a
          href="https://github.com/TGMadhusoodhan/crucible"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-zinc-500 transition-colors hover:text-zinc-200"
        >
          GitHub →
        </a>
      </div>
    </nav>
  )
}

// ─── Hero ─────────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="flex min-h-screen flex-col items-center justify-center px-6 pt-20 text-center">
      <div className="mx-auto max-w-3xl space-y-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-indigo-400">
          Multi-LLM Coding Platform
        </p>
        <h1 className="text-4xl font-bold leading-tight tracking-tight text-zinc-50 sm:text-5xl md:text-6xl">
          Bring any AI.<br />Build better code.
        </h1>
        <p className="mx-auto max-w-xl text-base text-zinc-400 leading-relaxed">
          Your models. Your code. Cross-examined. Two models from different AI families
          review every file. You decide what ships.
        </p>
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
          <a
            href="#install"
            className="rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-indigo-500"
          >
            Get Crucible
          </a>
          <a
            href="#how-it-works"
            className="rounded-lg border border-zinc-700 px-6 py-2.5 text-sm text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
          >
            See how it works
          </a>
        </div>
      </div>

      <div className="mt-20 grid grid-cols-3 gap-8 text-center sm:gap-16">
        {[
          { value: '8+',    label: 'AI providers' },
          { value: 'Local', label: 'runs on your machine' },
          { value: 'Free',  label: 'bring your own keys' },
        ].map(({ value, label }) => (
          <div key={label}>
            <p className="text-2xl font-bold text-zinc-100">{value}</p>
            <p className="text-xs text-zinc-600">{label}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

// ─── Problem ──────────────────────────────────────────────────────────────────

function Problem() {
  return (
    <section className="border-t border-zinc-800/60 px-6 py-24">
      <div className="mx-auto max-w-2xl space-y-6 text-center">
        <h2 className="text-2xl font-bold text-zinc-100">Single-model coding has a ceiling</h2>
        <div className="grid gap-4 text-left sm:grid-cols-2">
          {[
            { title: 'Blind spots', body: 'Every model has systematic gaps it cannot self-detect. The same model that wrote the bug is the one reviewing it.' },
            { title: 'No cross-validation', body: 'One model writes, one model reviews — but they share training data. Real bugs slip through both.' },
            { title: 'Token exhaustion', body: 'Heavy sessions throttle invisibly. Context runs out mid-task, leaving you with half-finished code.' },
            { title: 'Cost vs quality', body: 'Frontier models cost more and run slower. Cheaper models miss more. There\'s no middle ground alone.' },
          ].map(({ title, body }) => (
            <div key={title} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-1">
              <p className="text-sm font-semibold text-zinc-200">{title}</p>
              <p className="text-xs text-zinc-500 leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
        <p className="text-sm text-zinc-500">
          Crucible routes every task through two models from <em className="text-zinc-400">different AI families</em> —
          genuine cross-validation, not the same model asked twice.
        </p>
      </div>
    </section>
  )
}

// ─── How It Works ─────────────────────────────────────────────────────────────

function HowItWorks() {
  const steps = [
    {
      phase: '01',
      label: 'Think + Align',
      desc: 'Both models independently analyse the task. Crucible surfaces any architectural disagreements before a single line is written.',
    },
    {
      phase: '02',
      label: 'Spec',
      desc: 'Questions are merged, you answer once. A deterministic spec is generated and locked. You confirm before generation starts.',
    },
    {
      phase: '03',
      label: 'Generate',
      desc: 'DeepSeek writes the code, file by file. Each file is self-checked before it moves to review.',
    },
    {
      phase: '04',
      label: 'Dual Review',
      desc: 'Two independent reviewers cross-examine every file. Conflicting fixes are surfaced for you to resolve. Consensus code reaches the output gate.',
    },
  ]

  return (
    <section id="how-it-works" className="border-t border-zinc-800/60 px-6 py-24">
      <div className="mx-auto max-w-3xl">
        <h2 className="mb-12 text-center text-2xl font-bold text-zinc-100">How it works</h2>
        <div className="relative space-y-0">
          {steps.map((step, i) => (
            <div key={step.phase} className="flex gap-6">
              <div className="flex flex-col items-center">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-indigo-700 bg-indigo-950 text-xs font-bold text-indigo-400">
                  {step.phase}
                </div>
                {i < steps.length - 1 && (
                  <div className="w-px flex-1 bg-zinc-800 my-1" />
                )}
              </div>
              <div className="pb-8 pt-1 space-y-1">
                <p className="text-sm font-semibold text-zinc-200">{step.label}</p>
                <p className="text-xs text-zinc-500 leading-relaxed">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── Features ─────────────────────────────────────────────────────────────────

function Features() {
  const features = [
    {
      icon: '🔌',
      title: 'Model-agnostic',
      desc: 'Claude, GPT-4o, DeepSeek, Gemini, Mistral, Groq, Together, OpenRouter. Mix and match. New provider = new adapter class, zero pipeline changes.',
    },
    {
      icon: '🔒',
      title: 'Your keys, your data',
      desc: 'Runs entirely on your machine. API keys are AES-256 encrypted at rest. Nothing leaves except the model calls you make.',
    },
    {
      icon: '🧠',
      title: 'Human gates',
      desc: 'Five checkpoints where you stay in control: questions, spec confirm, conflict resolution, arbitration, and final output review.',
    },
    {
      icon: '📁',
      title: 'Multi-file output',
      desc: 'Full projects, not snippets. The spec includes a file manifest. Each file is generated, reviewed, and accepted individually.',
    },
    {
      icon: '⚖️',
      title: 'Conflict resolution',
      desc: 'When reviewers disagree, cross-review resolves most conflicts automatically. Genuine deadlocks come to you — one clear choice.',
    },
    {
      icon: '💰',
      title: 'Budget governor',
      desc: 'Per-provider spend tracking with four modes. Dashboard shows daily average and month-end projection before you start.',
    },
  ]

  return (
    <section className="border-t border-zinc-800/60 px-6 py-24">
      <div className="mx-auto max-w-3xl">
        <h2 className="mb-12 text-center text-2xl font-bold text-zinc-100">Built for real coding work</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon, title, desc }) => (
            <div key={title} className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 space-y-2">
              <p className="text-lg">{icon}</p>
              <p className="text-sm font-semibold text-zinc-200">{title}</p>
              <p className="text-xs text-zinc-500 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── Install ──────────────────────────────────────────────────────────────────

type OS = 'mac' | 'linux' | 'windows'

const OS_LABELS: Record<OS, string> = { mac: 'Mac', linux: 'Linux', windows: 'Windows' }

function Install() {
  const [os, setOs] = useState<OS>('mac')

  const dockerInstall: Record<OS, { code: string; note: string }> = {
    mac: {
      code: `# Option A — download Docker Desktop (recommended)\n# https://www.docker.com/products/docker-desktop/\n\n# Option B — Homebrew\nbrew install --cask docker`,
      note: 'After installing, open Docker Desktop and wait for the whale icon to show "running".',
    },
    linux: {
      code: `curl -fsSL https://get.docker.com | sh\nsudo usermod -aG docker $USER\n# Log out and back in, then verify:\ndocker run hello-world`,
      note: 'Works on Ubuntu, Debian, Fedora, and most other distros.',
    },
    windows: {
      code: `# Download Docker Desktop for Windows:\n# https://www.docker.com/products/docker-desktop/\n#\n# Requires Windows 10/11 (64-bit), WSL 2 backend.\n# Run the installer, restart when prompted.`,
      note: 'After install, open Docker Desktop from the Start menu and wait for it to show "running".',
    },
  }

  const getCompose: Record<OS, string> = {
    mac:     `curl -o docker-compose.yml \\\n  https://crucible.vercel.app/docker-compose.yml`,
    linux:   `curl -o docker-compose.yml \\\n  https://crucible.vercel.app/docker-compose.yml`,
    windows: `# In PowerShell or Command Prompt:\ncurl -o docker-compose.yml ^\n  https://crucible.vercel.app/docker-compose.yml`,
  }

  const runApp: Record<OS, { code: string; note: string }> = {
    mac: {
      code: `echo "ENCRYPTION_KEY=$(openssl rand -hex 32)" > .env\ndocker compose up`,
      note: 'Open localhost:3000, then go to Settings and add your API keys.',
    },
    linux: {
      code: `echo "ENCRYPTION_KEY=$(openssl rand -hex 32)" > .env\ndocker compose up`,
      note: 'Open localhost:3000, then go to Settings and add your API keys.',
    },
    windows: {
      code: `# In PowerShell:\n$key = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })\n"ENCRYPTION_KEY=$key" | Out-File .env -Encoding ascii\ndocker compose up`,
      note: 'Open localhost:3000 in your browser, then go to Settings and add your API keys. Tip: Git Bash or WSL users can use the Linux commands instead.',
    },
  }

  return (
    <section id="install" className="border-t border-zinc-800/60 px-6 py-24">
      <div className="mx-auto max-w-2xl space-y-10">
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-bold text-zinc-100">Install Crucible</h2>
          <p className="text-sm text-zinc-500">
            Runs on Mac, Linux, and Windows via Docker. Your data stays on your machine.
          </p>
        </div>

        {/* OS tabs */}
        <div className="flex justify-center">
          <div className="flex rounded-lg border border-zinc-700 p-0.5 gap-0.5">
            {(Object.keys(OS_LABELS) as OS[]).map(key => (
              <button
                key={key}
                onClick={() => setOs(key)}
                className={[
                  'rounded px-4 py-1.5 text-xs font-medium transition-colors',
                  os === key
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-300',
                ].join(' ')}
              >
                {OS_LABELS[key]}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-6">
          <InstallStep
            number="1"
            title="Install Docker"
            code={dockerInstall[os].code}
            note={dockerInstall[os].note}
          />
          <InstallStep
            number="2"
            title="Download the Crucible compose file"
            code={getCompose[os]}
          />
          <InstallStep
            number="3"
            title="Generate your encryption key and run"
            code={runApp[os].code}
            note={runApp[os].note}
          />
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-1">
          <p className="text-xs font-semibold text-zinc-400">You will need at least one AI API key</p>
          <p className="text-xs text-zinc-600 leading-relaxed">
            Supported: Anthropic, OpenAI, DeepSeek, Google, Mistral, Groq, Together AI, OpenRouter.
            DeepSeek + Claude Sonnet is the recommended default — highest coding score at the lowest cost.
          </p>
        </div>
      </div>
    </section>
  )
}

function InstallStep({
  number, title, code, note,
}: {
  number: string
  title: string
  code: string
  note?: string
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-900 text-[10px] font-bold text-indigo-300">
          {number}
        </span>
        <p className="text-sm font-medium text-zinc-300">{title}</p>
      </div>
      <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-300 leading-relaxed">
        <code>{code}</code>
      </pre>
      {note && <p className="text-xs text-zinc-600">{note}</p>}
    </div>
  )
}

// ─── Footer ───────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="border-t border-zinc-800/60 px-6 py-10">
      <div className="mx-auto flex max-w-5xl items-center justify-between">
        <p className="text-xs text-zinc-700">
          Crucible — open source, self-hosted
        </p>
        <a
          href="https://github.com/TGMadhusoodhan/crucible"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-zinc-600 transition-colors hover:text-zinc-300"
        >
          GitHub →
        </a>
      </div>
    </footer>
  )
}
