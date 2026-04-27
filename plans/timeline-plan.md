# Timeline Support Plan (av-controls)

## Goals
- Add optional/opt-in timeline support to `av-controls` so artworks can be timelineable without changing all apps.
- Timeline time is seconds (world time). Playback + seek + pause.
- Separate timeline app (WebSocket only) that shows recent changes and lets users create/modify envelopes.
- Two-way updates so controller + timeline + artwork stay in sync.

## Scope Decisions (pending)
- Monorepo/workspace change? (see Notes below)
- Curve type for envelopes (start with linear points; consider bezier later).

## Phases
1. Protocol design
   - Add timeline message types (specs, edits, playback/seek, recent-changes stream).
   - Define lane types per control (single value, multi-value like XY/Dots).
   - Define opt-in flag on root spec or per-control metadata.

2. Transport support
   - WebSocket transport carries timeline messages alongside existing messages.
   - (PostMessage not required per current direction.)

3. Receiver-side timeline engine (optional)
   - Time engine in seconds with `now()` and `deltaTime()`.
   - Playback state (play/pause), seek, and manual override behavior.
   - Apply envelope outputs to control receivers when automation enabled.
   - Track recent control changes for timeline UI.

4. Sender-side timeline client
   - Subscribe to timeline updates.
   - Send edits (add/move/delete points, enable/disable lanes, insert at current time).

5. Timeline app UI
   - Time bar with click-to-seek and space for play/pause.
   - Tree with 3 states per group (collapsed/expanded/expanded-minimal with pinned).
   - Lanes per control (fader/knob/switch/xy, etc.), resizable lane height.
   - Search for controls to show lanes.

6. Two-way control updates
   - Ensure senders react to receiver-side value changes.
   - Ensure receivers emit updates when their values change (manual or automation).

7. Docs + demo
   - Example artwork with timeline enabled.
   - Demo flow using ws-broker + timeline app + controller.

## Notes
- Monorepo: could use a workspace at repo root to unify `protocol`, `controller`, `time-n-controls`, `ws-broker`, `demo` (exclude `platform`).
- Start with linear interpolation for envelope evaluation; extend later.
## Future Architecture
- Consider adding a `ControllerClient` in `protocol` to mirror `TimelineClient` and reduce controller app message-wiring duplication.
## Persistence (additive requirement)
- Timeline app persists projects in IndexedDB keyed by artwork ID.
- Multiple timeline projects per artwork.
- Import/export entire timeline projects (all lanes + metadata).
