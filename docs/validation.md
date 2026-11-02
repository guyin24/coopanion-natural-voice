# Validation scope

Recorded 2026-11-02, version 0.6.0. This is the first public source snapshot. Local development checkpoints remain outside this public repository.

Version 0.6.1 updates npm/market metadata and installation documentation only; its `src/` and `web/` runtime files are unchanged from the validated 0.6.0 baseline. Its release checks run again before publication.

Version 0.6.2 updates the market's actual description field, feedback documentation and issue forms. The speech runtime remains unchanged. Metadata, YAML forms, document links, packaged feedback guide and upstream contract checks are verified for this release; it adds no new cloud/device validation claims.

## Evidence completed locally

- 268 automated tests passed, zero failures/skips, on a Windows development machine with an output device. This includes real native continuous playback, cancellation, recovery and persistent-process reuse, plus loopback protocol and mocked UI/player tests.
- Recursive syntax/manifest checks passed with `npm run check`.
- Actual upstream manifest parsing, dry mount, WorldAssembly, JsonlEventStore, loopback TTS and native playback passed using `npm run check:host` against Cortico commit `78e43502acbb082d6b7a587273784f359e554505`.
- Installed Coopanion 0.2.16 (`00f0f103c70e4f77a0a260606020eb093c6880fc`) completed a real Aliyun Qwen 3.1 Flash reply, stop/recovery and bubble self-check. Saved settings and credentials were retained across restart.
- Default mood mode produced speech without an additional tone tool. A controlled explicit ordinal test produced `voice_set_tone` followed by `pet_say`, and the tone reached Aliyun synthesis/native playback. Ordinary short requests also demonstrated that the model may skip optional annotations; the fallback remains necessary.
- Real settings-panel browser checks covered mode save/reload, hiding unsupported controls, and a 430px viewport without horizontal overflow.

## Same-condition cloud samples

Fixed text, Qwen 3.1 Flash, the same voice, speed 1.1, 24kHz and delivery instruction were used for a local 0.5.0 baseline and the revised implementation. Each case has one sample; these are not averages, percentiles or a general latency guarantee.

| Case | Baseline first native submission | Revised first native submission | Other observation |
|---|---:|---:|---|
| Cold short utterance | 1839ms | 1695ms | First cloud PCM varied from 1453ms to 1538ms; not every latency measure improved. |
| Warm socket, changed delivery | 1477ms | 869ms | Revised handshake is reusable across delivery changes. |
| Warm long utterance, 32.632s audio | 1405ms | 955ms | Baseline gap between first/remainder playback was 1796ms. Revised playback used 272 chunks and recorded no queue underflow ≥25ms. |

Native submission is a Windows API/worker signal, not a physical loudspeaker measurement. Underflow detection polls at approximately 10ms and counts gaps ≥25ms. Initial testing with 200ms buffering observed a 34ms gap; after switching to 300ms all three revised cases were rerun with no counted underflow. Raw generated audio and installed application records are not distributed.

## CI and untested boundaries

CI runs protocol/configuration/UI/player fixtures on Ubuntu and Windows with Node 22/24. Headless CI explicitly skips the one real audio-device test with `NATURAL_VOICE_SKIP_NATIVE_AUDIO=1`; Windows also compiles the native C# worker. A green CI build does not establish real cloud access, audible playback or hardware support.

Not run: clean-system Windows 10/11 matrix, multiple audio hardware/output devices, physical loopback measurements, emotional-expression blind scoring, and live credentials for all other providers. Continuous cloud streaming remains Aliyun-only. The private bubble hook has self-check/fail-open protection but remains dependent on host internals.
