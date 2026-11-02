# Architecture

```mermaid
flowchart LR
  Host[Coopanion / Cortico] --> Events[New desktop-pet.self events]
  Host --> Tap[Optional outputTap first-reply pre-synthesis]
  Events --> World[World queue and delivery metadata]
  Tap --> World
  World --> Router[TTS provider adapter]
  Router --> Service[Selected online service]
  Service --> Audio[Validated WAV / PCM]
  Audio --> Player[Persistent hidden Windows waveOut worker]
  Player --> Gate[Release matching bubble / timeout fallback]
```

`src/index.js` exposes the World API 6 definition. `src/world.js` subscribes to the store, excludes history/input/activity, resolves delivery instructions, validates pre-synthesis identity and manages cancellation and ordered playback. Speculation is bounded to one first reply and then the next actual queued phrase.

`src/tts.js` routes credentials and normalized settings to protocol-specific adapters. Transport functions enforce bounded requests/downloads, permitted origins and validated audio. Aliyun WebSocket handshake ownership is independent of model, voice and delivery instructions; a leased socket gets its run-task only after those parameters are known.

Aliyun `onAudioChunk` emits all PCM in approximately 120ms WAV chunks. `src/player-stream.js` sends PCM over JSONL stdin to the hidden Windows PowerShell host compiling `src/native/PcmPlayer.cs`. The worker uses native waveOut buffers, a 300ms initial prebuffer and in-process reset for stop. Other providers currently return whole-response audio through the same player.

Default mood mapping adds no tool or environment prompt. Optional ordinal annotations declare `voice_set_tone({tones:[...]})` and bind by following speech beat order. The model can skip annotations; existing expression metadata and the global instruction are fallbacks.

`src/pet-sync.js` is a compatibility layer until the host provides a supported bubble gate. It scopes discovery to loopback pet upgrades, exposes diagnostics, and fails open. See `upstream-bubble-hook-proposal.md` for the local proposal; no upstream acceptance is implied.

`web/client.js` is the provider settings/preview panel. `src/credentials.js` uses the host secret store, keeps provider secrets separate, and never returns their values to the panel. Catalog adapters query with the selected provider's credentials and retain labeled presets on failure.
