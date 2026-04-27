# Timeline Architecture Notes

## Status

This is a design note, not an implementation plan. We are explicitly postponing the refactor for now.

The current system works, but the timeline has become deeply integrated into the artwork runtime. Recent debugging suggests that this is convenient in the short term but creates architectural and operational complexity:

- the artwork runtime owns rendering and timeline execution
- the timeline app owns editing and persistence
- control authority and time authority are mixed together
- offline rendering, live control, sync, and persistence concerns are all crossing the same boundary

Some parts are still intentionally uncertain, but a few working decisions now feel strong enough to write down and use as implementation guidance.

## Main Concern

`av-controls` is already a protocol for sending control messages. That suggests a cleaner separation:

- artwork should primarily be a stateful control receiver + renderer
- timeline should primarily be a control-producing client, similar to a live controller

The current design pushes too much timeline responsibility into the artwork:

- playback state
- automation evaluation
- timeline state broadcasting
- render sequence state

That makes the artwork runtime heavier, harder to reason about, and harder to debug during hot reload / reconnect scenarios.

## Cleaner Direction

The clean conceptual split is:

- `artwork`
  - owns control state
  - receives `ControlSignal`
  - emits `ControlUpdate`
  - renders frames

- `timeline app`
  - owns timeline project state
  - owns playback UI
  - evaluates automation lanes
  - sends resulting control signals
  - may also drive explicit frame renders when artwork is not `live`

- `controller app`
  - sends live/manual control signals
  - may override timeline-driven controls

## Key Distinction: Time Authority vs Control Authority

These should be treated as separate concepts.

### Time Authority

Who defines the current playback time?

Possible authorities:

- artwork
- timeline client
- artwork render engine during offline render

### Control Authority

Who is allowed to change a control right now?

Possible authorities:

- timeline automation
- manual controller input
- artwork-local logic

These should not be assumed to be the same thing.

## Current Working Model

### 1. Live Manual Mode

- time authority: artwork
- control authority: manual controller / artwork local logic
- timeline may observe only

This is the low-latency performance mode.

### 2. Timeline Playback Mode

- artwork remains `live`
- artwork advances time itself from local `Date.now()` progression
- `deltaTime` is derived from that local progression too
- timeline evaluates automation from its own local timeline time
- timeline sends the resulting `ControlSignal`s
- for now, we assume timeline time and artwork time stay in sync well enough
- later, a drift-correction mechanism can be added if needed

### 3. Offline Render Mode

- artwork is `paused`
- timeline evaluates automation at target time `t`
- timeline sends the resulting control signals
- timeline then calls `render(t)`
- artwork computes `deltaTime` from the difference between the previous render call and `t`

This is the only case where artwork-side frame stepping should remain a first-class concern.

## Artwork State Model

The strongest current direction is that the artwork should only know:

- `live`
- `paused`

or equivalently:

- `running`
- `stopped`

In this model:

- `live`
  - artwork renders continuously
  - artwork advances its own internal time from local `Date.now()`
  - `deltaTime` follows that local progression
  - timeline may still send control updates
  - timeline does **not** call `render(t)`

- `paused`
  - artwork does not advance time on its own
  - scrubbing and offline rendering work by explicitly calling `render(t)`
  - the artwork computes `deltaTime` from the difference between the previous render time and the current explicit render time
  - `deltaTime` may therefore be negative when scrubbing backwards

This now feels like the right practical model, even if the full protocol around it is still not completely settled.

## Ongoing Ambiguity: Should Timeline Force Absolute Time Every Frame?

Partly resolved for now.

The current answer is: no, not in `live` mode.

In `live` mode:

- artwork should keep advancing time locally
- timeline should just send automation-derived control updates
- we rely on timeline time and artwork time staying close enough, usually because both run on the same machine

In `paused` mode:

- timeline may drive exact frame time by calling `render(t)`
- this is the mechanism for scrubbing and offline rendering

Future clock-drift correction is still open, but it is not required for the next step.

## Ongoing Ambiguity: What Should `deltaTime` Mean?

Less ambiguous now.

Current working rule:

- in `live`, `deltaTime` comes from local real-time progression
- in `paused`, `deltaTime` is `currentRenderTime - previousRenderTime`

That means negative `deltaTime` during backward scrubbing is acceptable.

What is still uncertain is whether every existing subsystem behaves well under negative or sharply discontinuous deltas.

## The Real Reason This Is Hard: Media Sync

This is still the main source of uncertainty, but it is lower priority now.

The original push toward deep timeline integration came from a real need:

- the timeline time must stay synchronized with a video playing inside the artwork

That means this is not only about envelope automation. It is also about the timebase used for:

- video frame selection
- audio position
- time-based simulation
- delta-sensitive effects

This is why "timeline as just another controller" is attractive architecturally, but incomplete on its own.

The current pragmatic stance is:

- in `live`
  - artwork owns time
  - timeline behaves mostly like a controller

- in `paused`
  - timeline can explicitly drive frame time via `render(t)`
  - artwork should eventually sample video and any other media from that explicit time

For now, media-perfect sync is a lower priority than simplifying the architecture and getting the control/render split clean.

## Tentative Direction Right Now

The currently most attractive idea is:

- keep the artwork state model very small
- use `live` and `paused`
- in `live`, artwork advances time itself from local time
- in `paused`, external callers drive exact render time
- timeline sends control updates for automated envelopes
- explicit `render(t)` handles scrubbing and offline rendering
- for now, rely on timeline time and artwork time staying in sync well enough during `live`

But this is still a working idea, not a final design decision.

## Proposed Render Model

For offline rendering and scrubbing, a cleaner protocol than "artwork owns full timeline playback" is:

1. set artwork to `paused`
2. timeline evaluates automated state/signals for frame time `t`
3. timeline sends those control messages
4. timeline calls `render(t)`
5. artwork renders and captures the frame if needed

Important note:

- in the current working model, `deltaTime` is inferred from consecutive `render(t)` calls
- that is simpler, but it means scrubbing backwards can produce negative deltas
- this may be acceptable, but it still needs practical validation

This is cleaner than relying on artwork-side autonomous timeline playback during export.

## Findings From Recent Debugging

### 1. `ConfirmSwitch` controller sync bug

Observed:

- trigger lane updates on the artwork side changed receiver state
- controller UI did not reflect the change

Cause:

- `ConfirmSwitch.Receiver` emitted updates
- `ConfirmSwitch.Sender` had no `handleUpdate()`

Fix:

- add `handleUpdate()` on `ConfirmSwitch.Sender`
- clear `awaitingConfirmation` when remote state wins

### 2. Timeline autosave caused heavy playback overhead

Observed:

- repeated play/pause felt progressively laggy
- restart restored fluidity

Cause:

- artwork-side timeline sent `TimelineState` continuously during playback
- timeline app autosaved full state too often
- autosave also refreshed the project list repeatedly

Mitigation applied:

- debounce autosave
- skip autosave during active playback / rendering
- stop refreshing the project list on every autosave

### 3. Render progress path was broken

Observed:

- UI showed `Frame 0 / 0`
- no downloaded frames

Cause:

- artwork tried to send render progress via a non-existent public `Receiver.send()` API

Fix:

- add a public receiver-side send helper
- use it for `RenderProgressMessage` and `RenderCompleteMessage`

### 4. Audio played during offline rendering

Observed:

- soundtrack played during frame-by-frame export

Cause:

- `rendering` was treated like `playing`

Fix:

- audio playback now runs only during real-time `playing`

### 5. Reconnect delays may be startup latency, not broker latency

Observed:

- after artwork reload, timeline/controller sometimes take several seconds to reconnect
- broker logs look normal but arrive late

Likely explanation:

- artwork constructs a large amount of WebGL/media/runtime state before creating the WebSocket receiver
- browser/runtime startup cost is visible as delayed receiver registration
- Firefox may make this more obvious

This supports the idea that artwork startup should become lighter and that transport concerns should be decoupled from expensive renderer initialization where possible.

## Recommendation

Do not attempt a big-bang rewrite.

Preferred migration path:

1. Keep current system working.
2. Introduce a client-side timeline executor for live playback first.
3. Treat timeline as another control-producing client in normal playback.
4. Keep only a thin artwork-side render/frame API for deterministic offline render.
5. Remove artwork-side live timeline execution after the new path is proven.

## Summary

The timeline should probably become:

- a controller-like client for live playback
- a sequence authoring tool for automation
- a render orchestrator for export

The artwork should probably become:

- a deterministic control receiver + renderer

The refactor is meaningful, but not urgent enough to force right now. This note records the intended direction and the reasons behind it.
