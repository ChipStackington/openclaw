# MC Chat Tactical Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Mission Control Tactical Split Chat shell with department-colored audio-reactive voice orb, configurable greeting, default `/chat` entry, and expandable voice mode.

**Architecture:** Mission Control owns the visible shell, greeting config, selected-agent metadata, right intelligence panel, and expandable orb UI. OpenClaw remains embedded through the existing iframe bridge and only gains a minimal voice telemetry `postMessage` hook from the existing TTS playback path. The existing dashboard is preserved by moving it to `/dashboard` while `/` redirects to `/chat`.

**Tech Stack:** Next.js 16 App Router, React 18, TypeScript, Tailwind CSS, Framer Motion, Lucide React, OpenClaw Lit/Vite control UI, Web Audio API.

---

## File Structure

Mission Control files:

- `C:\Users\jared\Projects\mission-control\lib\chat-greeting.ts`  
  Pure greeting config loader with Jared local defaults and environment/customer overrides.

- `C:\Users\jared\Projects\mission-control\lib\chat-greeting.test.ts`  
  Node tests for greeting defaults, overrides, booleans, and repeat policy.

- `C:\Users\jared\Projects\mission-control\lib\chat-orb.ts`  
  Pure orb theme helpers: department fallback, avatar color fallback, reduced-motion-safe intensity calculations.

- `C:\Users\jared\Projects\mission-control\lib\chat-orb.test.ts`  
  Node tests for department colors and fallback-to-blue behavior.

- `C:\Users\jared\Projects\mission-control\app\api\chat\greeting\route.ts`  
  Server route exposing customer-configurable greeting settings to the Chat page.

- `C:\Users\jared\Projects\mission-control\components\chat\VoiceOrb.tsx`  
  Reusable visual orb component. Receives agent metadata, voice state, analyser levels, and expanded/compact mode.

- `C:\Users\jared\Projects\mission-control\components\chat\ChatIntelligencePanel.tsx`  
  Right-side panel with active agent identity, orb, model/session/gateway/voice details, greeting controls, and expand button.

- `C:\Users\jared\Projects\mission-control\components\chat\ExpandedVoiceMode.tsx`  
  Overlay/sheet for the larger center-stage voice orb while keeping transcript accessible.

- `C:\Users\jared\Projects\mission-control\components\chat\ChatGreeting.tsx`  
  Visual greeting banner and voice enable fallback.

- `C:\Users\jared\Projects\mission-control\app\chat\page.tsx`  
  Replace the simple wrapper with Tactical Split shell while preserving iframe session behavior.

- `C:\Users\jared\Projects\mission-control\app\dashboard\page.tsx`  
  New copy of the existing dashboard page.

- `C:\Users\jared\Projects\mission-control\app\page.tsx`  
  Replace with a server redirect to `/chat`.

- `C:\Users\jared\Projects\mission-control\components\layout\Sidebar.tsx`  
  Change Dashboard nav item from `/` to `/dashboard`.

- `C:\Users\jared\Projects\mission-control\package.json`  
  Add focused test scripts for chat helper tests.

OpenClaw files:

- `C:\AI\openclaw\ui\src\ui\voice-tts.ts`  
  Add an analyser node and parent-frame voice telemetry messages during playback.

- `C:\AI\openclaw\ui\src\ui\voice-tts.test.ts`  
  Unit-test text cleaning and telemetry payload helper if feasible without browser audio APIs. If browser APIs block direct tests, keep pure helpers tested and verify playback manually.

Docs:

- `C:\AI\openclaw\docs\superpowers\specs\2026-05-27-mc-chat-tactical-console-design.md`  
  Source design spec.

- `C:\AI\openclaw\docs\superpowers\plans\2026-05-27-mc-chat-tactical-console-implementation.md`  
  This plan.

---

### Task 1: Greeting Config Helper

**Files:**
- Create: `C:\Users\jared\Projects\mission-control\lib\chat-greeting.ts`
- Create: `C:\Users\jared\Projects\mission-control\lib\chat-greeting.test.ts`
- Modify: `C:\Users\jared\Projects\mission-control\package.json`

- [ ] **Step 1: Write failing tests**

Create `C:\Users\jared\Projects\mission-control\lib\chat-greeting.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getChatGreetingConfig, parseBooleanFlag, type ChatGreetingEnv } from "./chat-greeting";

describe("parseBooleanFlag", () => {
  it("treats true-like values as true", () => {
    assert.equal(parseBooleanFlag("true", false), true);
    assert.equal(parseBooleanFlag("1", false), true);
    assert.equal(parseBooleanFlag("yes", false), true);
    assert.equal(parseBooleanFlag("on", false), true);
  });

  it("treats false-like values as false", () => {
    assert.equal(parseBooleanFlag("false", true), false);
    assert.equal(parseBooleanFlag("0", true), false);
    assert.equal(parseBooleanFlag("no", true), false);
    assert.equal(parseBooleanFlag("off", true), false);
  });

  it("uses fallback for missing or unknown values", () => {
    assert.equal(parseBooleanFlag(undefined, true), true);
    assert.equal(parseBooleanFlag("maybe", false), false);
  });
});

describe("getChatGreetingConfig", () => {
  it("defaults Jared's local system to a Jared greeting", () => {
    const env: ChatGreetingEnv = {};
    assert.deepEqual(getChatGreetingConfig(env), {
      displayName: "Jared",
      greetingText: "What project should we start working on today Jared?",
      enabled: true,
      spokenEnabled: true,
      repeat: "session",
    });
  });

  it("allows customer-specific greeting overrides", () => {
    const env: ChatGreetingEnv = {
      MC_CLIENT_DISPLAY_NAME: "Adrian",
      MC_CHAT_GREETING_TEXT: "Good morning Adrian. Which project should we move first?",
      MC_CHAT_GREETING_ENABLED: "true",
      MC_CHAT_GREETING_SPOKEN_ENABLED: "false",
      MC_CHAT_GREETING_REPEAT: "daily",
    };

    assert.deepEqual(getChatGreetingConfig(env), {
      displayName: "Adrian",
      greetingText: "Good morning Adrian. Which project should we move first?",
      enabled: true,
      spokenEnabled: false,
      repeat: "daily",
    });
  });

  it("falls back to a generated greeting when only the display name changes", () => {
    const env: ChatGreetingEnv = { MC_CLIENT_DISPLAY_NAME: "Adrian" };
    assert.equal(
      getChatGreetingConfig(env).greetingText,
      "What project should we start working on today Adrian?",
    );
  });

  it("normalizes unsupported repeat values to session", () => {
    const env: ChatGreetingEnv = { MC_CHAT_GREETING_REPEAT: "hourly" };
    assert.equal(getChatGreetingConfig(env).repeat, "session");
  });
});
```

- [ ] **Step 2: Add test script**

Modify `C:\Users\jared\Projects\mission-control\package.json` scripts:

```json
"test:chat": "tsx --test lib/chat-greeting.test.ts lib/chat-orb.test.ts",
```

Keep existing scripts intact.

- [ ] **Step 3: Run tests to verify failure**

Run:

```powershell
npm run test:chat
```

Expected: fails because `lib/chat-greeting.ts` and `lib/chat-orb.test.ts` do not exist yet.

- [ ] **Step 4: Implement greeting helper**

Create `C:\Users\jared\Projects\mission-control\lib\chat-greeting.ts`:

```ts
export type GreetingRepeat = "session" | "daily" | "manual";

export type ChatGreetingConfig = {
  displayName: string;
  greetingText: string;
  enabled: boolean;
  spokenEnabled: boolean;
  repeat: GreetingRepeat;
};

export type ChatGreetingEnv = Partial<Record<
  | "MC_CLIENT_DISPLAY_NAME"
  | "MC_CHAT_GREETING_TEXT"
  | "MC_CHAT_GREETING_ENABLED"
  | "MC_CHAT_GREETING_SPOKEN_ENABLED"
  | "MC_CHAT_GREETING_REPEAT",
  string
>>;

const DEFAULT_DISPLAY_NAME = "Jared";

export function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseRepeat(value: string | undefined): GreetingRepeat {
  if (value === "daily" || value === "manual" || value === "session") return value;
  return "session";
}

export function getChatGreetingConfig(env: ChatGreetingEnv = process.env): ChatGreetingConfig {
  const displayName = env.MC_CLIENT_DISPLAY_NAME?.trim() || DEFAULT_DISPLAY_NAME;
  const greetingText =
    env.MC_CHAT_GREETING_TEXT?.trim() ||
    `What project should we start working on today ${displayName}?`;

  return {
    displayName,
    greetingText,
    enabled: parseBooleanFlag(env.MC_CHAT_GREETING_ENABLED, true),
    spokenEnabled: parseBooleanFlag(env.MC_CHAT_GREETING_SPOKEN_ENABLED, true),
    repeat: parseRepeat(env.MC_CHAT_GREETING_REPEAT),
  };
}
```

- [ ] **Step 5: Run tests**

Run:

```powershell
npm run test:chat
```

Expected: still fails because `lib/chat-orb.test.ts` is planned in Task 2.

---

### Task 2: Orb Theme Helper

**Files:**
- Create: `C:\Users\jared\Projects\mission-control\lib\chat-orb.ts`
- Create: `C:\Users\jared\Projects\mission-control\lib\chat-orb.test.ts`

- [ ] **Step 1: Write failing tests**

Create `C:\Users\jared\Projects\mission-control\lib\chat-orb.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getOrbTheme, clampVoiceLevel, type OrbAgent } from "./chat-orb";

describe("getOrbTheme", () => {
  it("uses Quinn/System blue for main agent", () => {
    const agent: OrbAgent = { id: "main", name: "Quinn", department: "system", avatarColor: "#0A9EFC" };
    assert.equal(getOrbTheme(agent).color, "#0A9EFC");
  });

  it("uses department avatar color for Sales", () => {
    const agent: OrbAgent = {
      id: "sales-lead",
      name: "Sales Agent",
      department: "sales-and-revenue",
      avatarColor: "#00C853",
    };
    assert.equal(getOrbTheme(agent).color, "#00C853");
  });

  it("uses Quinn/System blue when agent metadata is missing", () => {
    assert.equal(getOrbTheme(null).color, "#0A9EFC");
    assert.equal(getOrbTheme({ id: "unknown", name: "Unknown" }).color, "#0A9EFC");
  });

  it("rejects unsafe color strings and falls back to blue", () => {
    const agent: OrbAgent = { id: "bad", name: "Bad", avatarColor: "url(javascript:bad)" };
    assert.equal(getOrbTheme(agent).color, "#0A9EFC");
  });
});

describe("clampVoiceLevel", () => {
  it("clamps analyser levels into 0..1", () => {
    assert.equal(clampVoiceLevel(-1), 0);
    assert.equal(clampVoiceLevel(0.42), 0.42);
    assert.equal(clampVoiceLevel(2), 1);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
npm run test:chat
```

Expected: fails because `lib/chat-orb.ts` is missing.

- [ ] **Step 3: Implement orb helper**

Create `C:\Users\jared\Projects\mission-control\lib\chat-orb.ts`:

```ts
export type OrbAgent = {
  id: string;
  name: string;
  department?: string;
  departmentLabel?: string;
  avatarColor?: string;
  model?: string;
  role?: string;
  status?: string;
};

export type OrbTheme = {
  color: string;
  department: string;
  label: string;
};

const SYSTEM_BLUE = "#0A9EFC";

const DEPARTMENT_LABELS: Record<string, string> = {
  system: "System",
  "sales-and-revenue": "Sales & Revenue",
  "client-services": "Client Services",
  "marketing-and-content": "Marketing & Content",
  "finance-and-administration": "Finance & Administration",
  "people-and-talent": "People & Talent",
  "operations-and-workflows": "Operations & Workflows",
};

function isSafeHexColor(value: string | undefined): value is string {
  return /^#[0-9a-fA-F]{6}$/.test(value ?? "");
}

export function getOrbTheme(agent: OrbAgent | null | undefined): OrbTheme {
  const department = agent?.department || "system";
  const label = agent?.departmentLabel || DEPARTMENT_LABELS[department] || "System";
  const color = isSafeHexColor(agent?.avatarColor) ? agent.avatarColor.toUpperCase() : SYSTEM_BLUE;

  return {
    color,
    department,
    label,
  };
}

export function clampVoiceLevel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
```

- [ ] **Step 4: Run tests**

Run:

```powershell
npm run test:chat
```

Expected: all chat helper tests pass.

---

### Task 3: Greeting API Route

**Files:**
- Create: `C:\Users\jared\Projects\mission-control\app\api\chat\greeting\route.ts`

- [ ] **Step 1: Implement API route**

Create `C:\Users\jared\Projects\mission-control\app\api\chat\greeting\route.ts`:

```ts
import { NextResponse } from "next/server";
import { getChatGreetingConfig } from "@/lib/chat-greeting";

export async function GET() {
  return NextResponse.json(getChatGreetingConfig());
}
```

- [ ] **Step 2: Run helper tests**

Run:

```powershell
npm run test:chat
```

Expected: pass.

- [ ] **Step 3: Run build**

Run:

```powershell
npm run build
```

Expected: build passes with only existing project warnings.

---

### Task 4: VoiceOrb Component

**Files:**
- Create: `C:\Users\jared\Projects\mission-control\components\chat\VoiceOrb.tsx`

- [ ] **Step 1: Implement reusable orb**

Create `C:\Users\jared\Projects\mission-control\components\chat\VoiceOrb.tsx`:

```tsx
"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Mic, Volume2, Loader2, Radio } from "lucide-react";
import { clampVoiceLevel, getOrbTheme, type OrbAgent } from "@/lib/chat-orb";
import { cn } from "@/lib/utils";

export type VoiceState = "idle" | "listening" | "thinking" | "speaking" | "unavailable";

type VoiceOrbProps = {
  agent: OrbAgent | null;
  voiceState: VoiceState;
  level?: number;
  expanded?: boolean;
  className?: string;
};

const stateLabels: Record<VoiceState, string> = {
  idle: "Voice idle",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  unavailable: "Voice unavailable",
};

export default function VoiceOrb({ agent, voiceState, level = 0, expanded = false, className }: VoiceOrbProps) {
  const reduceMotion = useReducedMotion();
  const theme = getOrbTheme(agent);
  const safeLevel = clampVoiceLevel(level);
  const active = voiceState === "speaking" || voiceState === "listening";
  const scale = reduceMotion ? 1 : 1 + safeLevel * (expanded ? 0.16 : 0.1);
  const size = expanded ? 220 : 124;
  const glow = active ? 0.42 + safeLevel * 0.36 : 0.18;
  const borderShift = active && !reduceMotion ? `${48 + safeLevel * 10}% ${52 - safeLevel * 10}% ${44 + safeLevel * 8}% ${56 - safeLevel * 8}% / ${54 - safeLevel * 9}% ${46 + safeLevel * 9}% ${56 - safeLevel * 7}% ${44 + safeLevel * 7}%` : "50%";
  const Icon = voiceState === "speaking" ? Volume2 : voiceState === "thinking" ? Loader2 : voiceState === "listening" ? Mic : Radio;

  return (
    <div
      className={cn("relative grid place-items-center", className)}
      style={{ "--orb-color": theme.color, "--orb-glow": `${theme.color}66` } as React.CSSProperties}
      aria-label={`${agent?.name ?? "Quinn"} ${stateLabels[voiceState]}`}
    >
      <motion.div
        className="absolute rounded-full border border-[color:var(--orb-color)]/30"
        style={{ width: size * 1.72, height: size * 1.72 }}
        animate={reduceMotion ? { opacity: 0.42 } : { rotate: voiceState === "thinking" ? 360 : 0, opacity: active ? [0.35, 0.7, 0.35] : 0.28 }}
        transition={{ duration: voiceState === "thinking" ? 7 : 2.1, repeat: Infinity, ease: "linear" }}
      />
      <motion.div
        className="absolute rounded-full border border-dashed border-[color:var(--orb-color)]/20"
        style={{ width: size * 2.12, height: size * 2.12 }}
        animate={reduceMotion ? { opacity: 0.28 } : { scale: active ? [0.92, 1.08, 0.92] : [0.98, 1.02, 0.98], opacity: active ? [0.22, 0.55, 0.22] : 0.18 }}
        transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="relative grid place-items-center overflow-hidden border"
        style={{
          width: size,
          height: size,
          borderRadius: borderShift,
          borderColor: `${theme.color}AA`,
          background: `radial-gradient(circle at 35% 28%, rgba(255,255,255,.86), transparent 12%), radial-gradient(circle at 42% 36%, ${theme.color}, transparent 28%), radial-gradient(circle at 62% 72%, ${theme.color}CC, transparent 45%), radial-gradient(circle at 50% 50%, ${theme.color}33, transparent 74%)`,
          boxShadow: `0 0 ${expanded ? 70 : 38}px rgba(10, 158, 252, ${glow}), inset -18px -20px 40px rgba(0,0,0,.42)`,
        }}
        animate={reduceMotion ? { opacity: 1 } : { scale, rotate: active ? [-1.5, 1.5, -1.5] : 0 }}
        transition={{ duration: 0.9, repeat: Infinity, ease: "easeInOut" }}
      >
        <Icon className={cn("text-white/80", voiceState === "thinking" && "animate-spin")} size={expanded ? 38 : 24} />
      </motion.div>
      <div className="mt-5 text-center">
        <div className="font-mono text-xs uppercase tracking-wider text-[color:var(--orb-color)]">
          {agent?.name ?? "Quinn"} {stateLabels[voiceState]}
        </div>
        <div className="mt-1 text-[11px] text-text-secondary">{theme.label}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run build**

Run:

```powershell
npm run build
```

Expected: build passes.

---

### Task 5: Chat Panel Components

**Files:**
- Create: `C:\Users\jared\Projects\mission-control\components\chat\ChatGreeting.tsx`
- Create: `C:\Users\jared\Projects\mission-control\components\chat\ChatIntelligencePanel.tsx`
- Create: `C:\Users\jared\Projects\mission-control\components\chat\ExpandedVoiceMode.tsx`

- [ ] **Step 1: Implement ChatGreeting**

Create `C:\Users\jared\Projects\mission-control\components\chat\ChatGreeting.tsx`:

```tsx
"use client";

import { Volume2 } from "lucide-react";
import type { ChatGreetingConfig } from "@/lib/chat-greeting";
import { cn } from "@/lib/utils";

type ChatGreetingProps = {
  config: ChatGreetingConfig | null;
  voiceOn: boolean;
  onEnableVoice: () => void;
  className?: string;
};

export default function ChatGreeting({ config, voiceOn, onEnableVoice, className }: ChatGreetingProps) {
  if (!config?.enabled) return null;

  return (
    <div className={cn("rounded-lg border border-sky-400/30 bg-sky-500/10 px-4 py-3", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-sky-100">Quinn is ready.</div>
          <div className="mt-1 text-sm text-slate-300">{config.greetingText}</div>
        </div>
        {config.spokenEnabled && !voiceOn && (
          <button
            type="button"
            onClick={onEnableVoice}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-sky-400/40 bg-sky-400/10 px-3 text-xs font-semibold text-sky-100 transition hover:bg-sky-400/20"
          >
            <Volume2 className="h-4 w-4" />
            Enable Quinn Voice
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Implement ChatIntelligencePanel**

Create `C:\Users\jared\Projects\mission-control\components\chat\ChatIntelligencePanel.tsx`:

```tsx
"use client";

import { Maximize2, Mic, RefreshCw, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import VoiceOrb, { type VoiceState } from "./VoiceOrb";
import type { OrbAgent } from "@/lib/chat-orb";

type ChatIntelligencePanelProps = {
  agent: OrbAgent | null;
  connectionState: "checking" | "connected" | "disconnected" | "error";
  voiceState: VoiceState;
  voiceLevel: number;
  voiceOn: boolean;
  sessionLabel: string;
  onRetry: () => void;
  onExpandVoice: () => void;
};

export default function ChatIntelligencePanel({
  agent,
  connectionState,
  voiceState,
  voiceLevel,
  voiceOn,
  sessionLabel,
  onRetry,
  onExpandVoice,
}: ChatIntelligencePanelProps) {
  const connected = connectionState === "connected";

  return (
    <aside className="hidden w-[320px] shrink-0 border-l border-sky-500/15 bg-[#07101d]/90 xl:flex xl:flex-col">
      <div className="border-b border-sky-500/15 px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-mono uppercase tracking-wider text-slate-500">Active Agent</div>
            <div className="mt-1 text-lg font-semibold text-white">{agent?.name ?? "Quinn"}</div>
            <div className="mt-1 text-xs text-slate-400">{agent?.role ?? "Chief of Staff"}</div>
          </div>
          <button
            type="button"
            onClick={onExpandVoice}
            className="grid h-10 w-10 place-items-center rounded-lg border border-sky-400/25 text-sky-200 transition hover:bg-sky-400/10"
            title="Expand voice mode"
          >
            <Maximize2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid place-items-center border-b border-sky-500/15 px-4 py-7">
        <VoiceOrb agent={agent} voiceState={voiceState} level={voiceLevel} />
      </div>

      <div className="grid gap-3 px-4 py-4">
        <PanelMetric icon={connected ? Wifi : WifiOff} label="Gateway" value={connected ? "Connected" : connectionState.toUpperCase()} good={connected} />
        <PanelMetric icon={Mic} label="Voice" value={voiceOn ? "Enabled" : "Disabled"} good={voiceOn} />
        <PanelMetric icon={ShieldCheck} label="Session" value={sessionLabel} />
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900/70 px-3 text-xs font-semibold text-slate-200 transition hover:border-sky-400/50 hover:text-sky-100"
        >
          <RefreshCw className="h-4 w-4" />
          Retry Gateway
        </button>
      </div>
    </aside>
  );
}

function PanelMetric({
  icon: Icon,
  label,
  value,
  good,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  good?: boolean;
}) {
  return (
    <div className="rounded-lg border border-sky-500/15 bg-white/[0.03] p-3">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Icon className={good ? "h-3.5 w-3.5 text-emerald-400" : "h-3.5 w-3.5 text-sky-300"} />
        {label}
      </div>
      <div className="mt-1 truncate font-mono text-xs text-slate-200">{value}</div>
    </div>
  );
}
```

- [ ] **Step 3: Implement ExpandedVoiceMode**

Create `C:\Users\jared\Projects\mission-control\components\chat\ExpandedVoiceMode.tsx`:

```tsx
"use client";

import { X } from "lucide-react";
import VoiceOrb, { type VoiceState } from "./VoiceOrb";
import type { OrbAgent } from "@/lib/chat-orb";

type ExpandedVoiceModeProps = {
  open: boolean;
  agent: OrbAgent | null;
  voiceState: VoiceState;
  voiceLevel: number;
  onClose: () => void;
};

export default function ExpandedVoiceMode({ open, agent, voiceState, voiceLevel, onClose }: ExpandedVoiceModeProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] bg-[#02020e]/90 backdrop-blur-xl">
      <div className="flex h-full flex-col">
        <div className="flex h-16 items-center justify-between border-b border-sky-500/15 px-6">
          <div>
            <div className="text-sm font-semibold text-white">Voice Mode</div>
            <div className="text-xs text-slate-500">{agent?.name ?? "Quinn"} remains connected to the active chat session.</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-10 w-10 place-items-center rounded-lg border border-slate-700 text-slate-200 transition hover:border-sky-400/50 hover:text-white"
            title="Close voice mode"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid flex-1 place-items-center px-6">
          <VoiceOrb agent={agent} voiceState={voiceState} level={voiceLevel} expanded />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run build**

Run:

```powershell
npm run build
```

Expected: build passes.

---

### Task 6: Tactical Chat Page Shell

**Files:**
- Modify: `C:\Users\jared\Projects\mission-control\app\chat\page.tsx`

- [ ] **Step 1: Replace page with Tactical Split shell**

Modify `C:\Users\jared\Projects\mission-control\app\chat\page.tsx` by preserving existing gateway/session logic and adding:

- imports for `Send`, `Settings2`, `Volume2`, `PanelRightOpen`
- imports for new chat components
- `greetingConfig` state fetched from `/api/chat/greeting`
- `voiceState` and `voiceLevel` state
- `expandedVoiceOpen` state
- `message` event listener for `openclaw:voice-telemetry`
- Tactical Split layout around the existing iframe

The new parent-frame message handler must accept this payload:

```ts
type VoiceTelemetryMessage = {
  type: "openclaw:voice-telemetry";
  state: "idle" | "speaking" | "error";
  level?: number;
};
```

The local handler logic:

```ts
if (e.data?.type === "openclaw:voice-telemetry") {
  setVoiceState(e.data.state === "speaking" ? "speaking" : "idle");
  setVoiceLevel(typeof e.data.level === "number" ? e.data.level : 0);
}
```

The selected agent mapping must preserve existing agent data:

```ts
const selectedAgentInfo = agents.find((a) => a.id === selectedAgent) || {
  id: "main",
  name: "Quinn",
  emoji: "🤖",
  role: "Chief of Staff",
  department: "system",
  departmentLabel: "System",
  avatarColor: "#0A9EFC",
};
```

The shell must render:

```tsx
<div className="flex h-full min-h-0 flex-col bg-[#02020e]">
  <div className="flex min-h-0 flex-1">
    <section className="flex min-w-0 flex-1 flex-col">
      {/* tactical header, greeting, iframe frame */}
    </section>
    <ChatIntelligencePanel ... />
  </div>
  <ExpandedVoiceMode ... />
</div>
```

Keep the iframe:

```tsx
<iframe
  ref={iframeRef}
  key={`${selectedAgent}-${retryCount}`}
  src={iframeSrc}
  className="h-full w-full"
  title={`${selectedAgentInfo.name} Chat`}
  allow="microphone; autoplay"
/>
```

- [ ] **Step 2: Run build**

Run:

```powershell
npm run build
```

Expected: build passes.

- [ ] **Step 3: Browser visual check**

Run Mission Control if it is not already running:

```powershell
npm run start
```

Open:

```text
http://localhost:3000/chat
```

Expected:

- Tactical Split shell renders.
- Existing iframe chat still loads.
- Right panel appears on desktop.
- Voice orb uses Quinn blue by default.
- Agent switch still changes iframe session.

---

### Task 7: Default Route To Chat, Preserve Dashboard

**Files:**
- Create: `C:\Users\jared\Projects\mission-control\app\dashboard\page.tsx`
- Modify: `C:\Users\jared\Projects\mission-control\app\page.tsx`
- Modify: `C:\Users\jared\Projects\mission-control\components\layout\Sidebar.tsx`

- [ ] **Step 1: Copy existing dashboard page**

Copy current contents of `C:\Users\jared\Projects\mission-control\app\page.tsx` into:

```text
C:\Users\jared\Projects\mission-control\app\dashboard\page.tsx
```

- [ ] **Step 2: Replace root page with redirect**

Replace `C:\Users\jared\Projects\mission-control\app\page.tsx` with:

```tsx
import { redirect } from "next/navigation";

export default function HomePage() {
  redirect("/chat");
}
```

- [ ] **Step 3: Update sidebar dashboard link**

In `C:\Users\jared\Projects\mission-control\components\layout\Sidebar.tsx`, change:

```ts
{ href: "/", icon: Home, label: "Dashboard" },
```

to:

```ts
{ href: "/dashboard", icon: Home, label: "Dashboard" },
```

- [ ] **Step 4: Run build**

Run:

```powershell
npm run build
```

Expected: build passes.

- [ ] **Step 5: Verify routes**

Open:

```text
http://localhost:3000/
http://localhost:3000/chat
http://localhost:3000/dashboard
```

Expected:

- `/` redirects to `/chat`.
- `/chat` shows Tactical Console.
- `/dashboard` shows the old dashboard.

---

### Task 8: OpenClaw Voice Telemetry Bridge

**Files:**
- Modify: `C:\AI\openclaw\ui\src\ui\voice-tts.ts`

- [ ] **Step 1: Add telemetry helpers**

In `C:\AI\openclaw\ui\src\ui\voice-tts.ts`, add these helpers above `speakText`:

```ts
type VoiceTelemetryState = "idle" | "speaking" | "error";

function emitVoiceTelemetry(state: VoiceTelemetryState, level = 0): void {
  try {
    window.parent?.postMessage(
      {
        type: "openclaw:voice-telemetry",
        state,
        level,
      },
      "*",
    );
  } catch {
    // Parent frame may be unavailable; voice playback should continue.
  }
}

function startAnalyserTelemetry(
  context: AudioContext,
  source: AudioBufferSourceNode,
): { stop: () => void } {
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.72;

  source.connect(analyser);
  analyser.connect(context.destination);

  const data = new Uint8Array(analyser.frequencyBinCount);
  let stopped = false;
  let frame = 0;

  const tick = () => {
    if (stopped) return;
    analyser.getByteFrequencyData(data);
    const total = data.reduce((sum, value) => sum + value, 0);
    const level = Math.min(1, total / data.length / 160);
    if (frame % 3 === 0) {
      emitVoiceTelemetry("speaking", level);
    }
    frame += 1;
    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);

  return {
    stop: () => {
      stopped = true;
      emitVoiceTelemetry("idle", 0);
    },
  };
}
```

- [ ] **Step 2: Replace direct destination connection**

In `speakText`, replace:

```ts
source.connect(_audioContext.destination);
source.onended = () => {
  _currentSource = null;
};
```

with:

```ts
const telemetry = startAnalyserTelemetry(_audioContext, source);
source.onended = () => {
  telemetry.stop();
  _currentSource = null;
};
```

- [ ] **Step 3: Emit error telemetry**

In the `catch` block of `speakText`, add:

```ts
emitVoiceTelemetry("error", 0);
```

before the warning log.

- [ ] **Step 4: Build OpenClaw control UI**

Run:

```powershell
cd C:\AI\openclaw\ui
npm run build
```

Expected: Vite build passes.

- [ ] **Step 5: Manual verification**

Start Quinn and open Mission Control Chat. Turn voice on and send a short prompt. Expected:

- Spoken response still plays.
- Orb moves more while audio is playing.
- Orb returns to idle when playback ends.

---

### Task 9: Final Visual And Functional Verification

**Files:**
- No code changes unless verification finds a bug.

- [ ] **Step 1: Run Mission Control tests**

Run:

```powershell
cd C:\Users\jared\Projects\mission-control
npm run test:chat
npm run build
```

Expected:

- Chat helper tests pass.
- Next build passes.

- [ ] **Step 2: Run OpenClaw UI build**

Run:

```powershell
cd C:\AI\openclaw\ui
npm run build
```

Expected: build passes.

- [ ] **Step 3: Restart Quinn from desktop launcher**

Use the existing desktop icon or launcher.

Expected:

- Startup still lands under the existing fast-start target.
- Mission Control opens to Chat.
- Dashboard remains available at `/dashboard`.

- [ ] **Step 4: Verify Tactical Console states**

Check:

- Gateway connected state.
- Gateway offline state by stopping proxy or using existing failure condition.
- Agent selector changes the active session.
- Quinn orb is blue.
- Sales agent orb is green.
- Operations agent orb is orange.
- Unknown/fallback agent orb is blue.
- Expanded voice mode opens and closes.
- Greeting appears once per configured repeat rule.
- Audio-blocked path shows Enable Quinn Voice instead of throwing.

- [ ] **Step 5: Browser responsive check**

Use desktop and narrow viewport.

Expected:

- No horizontal scroll.
- Right panel collapses or hides on small screens.
- Iframe remains usable.
- Text does not overlap controls.

---

## Self-Review Checklist

- Spec coverage:
  - Tactical Split shell: Task 6.
  - Department-colored orb: Tasks 2, 4, 6.
  - Fallback blue: Task 2.
  - Configurable client greeting: Tasks 1, 3, 5, 6.
  - Default `/chat`: Task 7.
  - Expandable voice mode: Tasks 5, 6.
  - Minimal OpenClaw voice analyser hook: Task 8.
  - Verification: Task 9.

- Placeholder scan:
  - Placeholder scan completed with no unresolved markers.
  - No undefined helper names outside the tasks that define them.

- Type consistency:
  - `VoiceState` is defined in `VoiceOrb.tsx` and reused by panel/expanded mode.
  - `OrbAgent` comes from `lib/chat-orb.ts`.
  - `ChatGreetingConfig` comes from `lib/chat-greeting.ts`.
  - OpenClaw telemetry message type is `openclaw:voice-telemetry`.
