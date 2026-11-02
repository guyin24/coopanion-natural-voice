# Proposed supported host integration

The plugin currently has no public World API for holding and releasing a pet bubble. It therefore verifies only a loopback `/socket?role=pet` upgrade before using its existing compatibility hook. Startup diagnostics fall back to immediate text if that verification is unavailable. This reduces the hook's scope but does not turn private WebSocket internals into a supported API.

A future host API could emit `onSpeechPrepared({id,beats})` and return a per-id gate token with `release()`/`cancel()`, bounded by a host-owned timeout. The same stable id should appear in `desktop-pet.self` and in the pet frame. The host would own delivery, connection lifecycle and fallback; a voice plugin would report readiness without inspecting sockets or patching global prototypes.

This is a local implementation proposal. No issue or message was sent to the upstream project.
