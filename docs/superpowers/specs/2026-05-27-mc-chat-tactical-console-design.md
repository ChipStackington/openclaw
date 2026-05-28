# MC Chat Tactical Console Redesign

Date: 2026-05-27
Owner: Codex
Status: Draft for Jared review

## Goal

Upgrade Mission Control's Chat tab into a high-tech AI cockpit without throwing away the current OpenClaw chat system. The redesigned Chat tab should become the default Mission Control landing surface and feel ready for commercial demos: fast to load, operationally useful, visually premium, and clearly centered on Quinn and the agent network.

The selected design direction is **Tactical Split Console**:

- Chat remains the main work surface.
- A right-side intelligence panel shows the active agent, voice orb, model/session health, context, queue, and key actions.
- The voice orb is visibly alive and prominent while Quinn or any selected agent speaks.
- Orb color is driven by the active agent's department.
- Quinn/System blue is used for Quinn and as the fallback when agent department metadata is missing.
- The first loaded experience opens directly to Chat and presents Quinn's greeting.
- The first implementation pass upgrades the Mission Control shell and voice orb, with only the minimal OpenClaw voice hook needed for real audio-reactive animation.

## Current System

Mission Control currently renders Chat from `C:\Users\jared\Projects\mission-control\app\chat\page.tsx`. That page wraps OpenClaw's control UI in an iframe pointed at the local gateway proxy on port `19101`.

The actual OpenClaw chat view and voice playback live under:

- `C:\AI\openclaw\ui\src\ui\app-render.ts`
- `C:\AI\openclaw\ui\src\ui\voice-tts.ts`
- `C:\AI\openclaw\ui\src\styles\chat\layout.css`
- `C:\AI\openclaw\ui\src\styles\chat\tool-cards.css`

Mission Control already exposes agent metadata through `/api/agents`, including department and `avatarColor`, sourced from `C:\Users\jared\Projects\mission-control\lib\quinn-co.ts`.

## Visual Design

The Chat tab should feel like a live AI command console, not a generic webchat.

Primary layout:

- Collapsed Mission Control navigation remains on the left.
- Main center area contains the chat transcript and tool cards.
- Right intelligence panel contains the active agent identity, voice orb, voice state, model, context, queue, session, and gateway health.
- Composer stays fixed along the bottom of the chat surface.

Visual tone:

- Dark operational base using Wired Wisdom/Quinn colors.
- High contrast text, restrained borders, compact panels, and precision spacing.
- No decorative one-note gradients or toy-like sci-fi excess.
- The orb is the main living visual element; the rest of the UI stays disciplined.

## Voice Orb

Create one shared VoiceOrb visual system. It should not be custom-built per agent.

Inputs:

- `agentId`
- `agentName`
- `department`
- `departmentLabel`
- `avatarColor`
- `voiceState`: `idle | listening | thinking | speaking | unavailable`
- optional audio analyser data while speech is playing

Department colors:

- System / Quinn: `#0A9EFC`
- Sales & Revenue: `#00C853`
- Client Services: `#FFB300`
- Marketing & Content: `#E040FB`
- Finance & Administration: `#B0BEC5`
- People & Talent: `#00BFA5`
- Operations & Workflows: `#FF6D00`
- Unknown/fallback: `#0A9EFC`

Behavior:

- Idle: slow breathing, low glow, no aggressive motion.
- Listening: visible ripple and microphone/input indicator.
- Thinking: orbit ring/scan motion while an agent turn is in flight.
- Speaking: prominent morphing orb driven by Quinn/agent TTS audio.
- Unavailable: muted but still blue fallback, with clear voice-disabled status.

The speaking state should be visibly alive. Shape, glow, wave rings, and waveform bars should react to real audio levels. This can be implemented with the Web Audio API by routing existing TTS playback through an `AnalyserNode`.

## Greeting And Client Customization

When Mission Control is fully loaded and the Chat surface is ready, Quinn should greet Jared:

> "What project should we start working on today Jared?"

This must be configurable for future customer deployments. A sold Quinn system should be able to greet the client by their preferred name and phrase. Example: Adrian's Quinn system could say a custom Adrian-specific greeting without code changes.

Commercial-safe behavior:

- The visual greeting appears once the Chat page and gateway are ready.
- Spoken greeting plays only when browser audio is unlocked and voice is enabled.
- If autoplay is blocked, show a polished "Enable Quinn Voice" action and play the greeting after Jared clicks.
- Do not replay the greeting repeatedly on every route transition or iframe reload. Use a short-lived session/local state guard.
- Store greeting settings as customer/local configuration, not hardcoded UI text.
- Jared's local Quinn-Co build defaults to Jared-specific greeting text.
- Customer deployments can configure:
  - display name
  - greeting phrase
  - greeting enabled/disabled
  - spoken greeting enabled/disabled
  - whether greeting repeats daily, once per browser session, or only on manual voice enable

## Default Route

Mission Control should open to Chat by default.

Preferred behavior:

- Authenticated root/dashboard entry routes to `/chat`.
- Existing dashboard remains accessible from the nav.
- Do not break login, invite, reset password, or security setup routes.
- If Chat is unavailable, show a gateway readiness state rather than dumping the user to a blank iframe.

## Architecture

Phase 1 should preserve the iframe bridge to OpenClaw. This avoids rebuilding the full agent conversation protocol before the visual upgrade ships.

The first implementation pass is **Mission Control shell + orb first**, not a broad OpenClaw UI redesign. OpenClaw should only be touched where required to make the orb respond to actual spoken audio.

Mission Control changes:

- Replace the current simple Chat wrapper with the Tactical Split shell.
- Add a right intelligence panel using existing `/api/agents` data.
- Add `VoiceOrb` as a local Mission Control component for the shell.
- Add expandable voice mode so the orb can grow into a larger center-stage surface during active voice conversations.
- Route root authenticated app entry to `/chat`.
- Add greeting state, controls, and customer-configurable greeting settings.
- Avoid hardcoding sensitive gateway values in client code long term; move token/proxy configuration behind safer local config/API handling in the implementation plan.

OpenClaw UI changes:

- Add minimal voice playback analyser hooks in `voice-tts.ts`.
- Expose voice playback state and analyser levels to the parent Mission Control shell through a small postMessage bridge.
- Keep existing message send/history behavior intact.
- Defer broad OpenClaw chat message/tool-card/composer restyling to a later pass unless a small compatibility style change is required for the shell.

## Data Flow

1. Mission Control loads `/chat`.
2. Chat page fetches `/api/agents`.
3. Selected agent determines iframe session key and orb theme color.
4. Gateway readiness check confirms proxy availability.
5. OpenClaw iframe mounts and loads the selected session.
6. Voice state is synchronized through existing parent frame messages and any new minimal messages needed for analyser/speaking state.
7. When an assistant final message is spoken, OpenClaw TTS playback emits analyser levels.
8. Orb morphs based on current agent color and voice levels.
9. When voice mode is expanded, the orb becomes a larger center-stage interface while the transcript remains accessible.

## Error Handling

- Gateway offline: show clear offline panel with retry and service status.
- Proxy reachable but iframe fails: show an embed error with direct-open action.
- Voice disabled: keep orb idle and show voice enable control.
- Audio blocked: show visual greeting and defer spoken greeting until user interaction.
- Greeting config missing: default to Jared locally and a neutral customer-safe greeting elsewhere.
- Missing department color: use Quinn/System blue.
- Missing agent metadata: show Quinn/System default rather than gray fallback.
- TTS failure: show subtle voice error state without blocking chat.

## Accessibility And Performance

- Preserve keyboard navigation for agent picker, retry, voice controls, and composer.
- Maintain visible focus states.
- Respect `prefers-reduced-motion`: reduce orb deformation to gentle opacity/ring changes.
- Keep animations transform/opacity based.
- Avoid layout shift when status/model/context values change.
- Provide text labels/tooltips for icon-only controls.
- Do not make the orb so active that it interferes with reading the transcript.

## Testing

Required checks before implementation is considered done:

- `npm run build` in `C:\Users\jared\Projects\mission-control`.
- Open `/chat` in browser and verify default route behavior.
- Verify agent switch changes iframe session and orb color.
- Verify Quinn/System and unknown fallback use blue.
- Verify Sales agent uses green and Operations agent uses orange.
- Verify gateway offline state still renders.
- Verify voice enabled path triggers greeting only once per browser session.
- Verify greeting settings can change the name/phrase without code edits.
- Verify audio-blocked path shows enable control and does not throw.
- Verify expanded voice mode opens/closes and does not hide critical chat controls.
- Verify reduced-motion mode reduces orb movement.
- Verify desktop and mobile layouts do not overlap or produce horizontal scroll.

## Out Of Scope For First Pass

- Replacing the OpenClaw iframe with a fully native Mission Control chat client.
- Broad restyling of OpenClaw's internal chat transcript, tool cards, and composer beyond the minimal voice analyser bridge.
- Building custom 3D/WebGL voice visualizations.
- Per-agent custom orb artwork.
- Commercial auth/security overhaul beyond avoiding newly introduced leaks.
- Full redesign of every Mission Control tab.

## Jared Decisions Captured

- First pass scope: Mission Control shell + orb first.
- OpenClaw changes: only the minimal voice analyser/postMessage bridge required for the orb to react to real speech.
- Greeting: customer-configurable, with Jared's local build defaulting to Jared.
- Voice mode: include expandable center-stage orb mode in the implementation plan now.
