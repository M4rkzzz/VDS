# VDS enhanced ICE patches

The patches apply to the original, hash-pinned libjuice 1.7.0 and libdatachannel 0.24.1 source archives. Both upstream projects use MPL-2.0; their source headers and licenses are preserved in the extracted build source. The patch files are the editable source of the VDS changes; no UU software code is included.

Run `scripts/build-vds-ice.ps1` after installing the media-agent vcpkg manifest dependencies. It verifies SHA-512 hashes, applies the tracked patches in a task-owned source directory, rebuilds both libraries against existing OpenSSL, SRTP and usrsctp dependencies, and copies only `juice.dll` and `datachannel.dll` into the runtime. It does not remove other runtime files. CMake's `VDS_MEDIA_AGENT_ENHANCED_ICE` option verifies the patched installation and selects it ahead of the standard dependency package.

Primary STUN sampling and ordinary connectivity checks use the same libjuice UDP socket. Additional socket paths are described below; their authenticated checks and selected media traffic retain the additional socket identity. At most four STUN targets are configured; duplicate resolved endpoints are skipped. Mapping observations carry the actual successful first-send sequence for IPv4; IPv6 requests do not consume this sequence. Replies require a matching transaction ID, matching source endpoint and a nonzero mapped endpoint. Failed/cancelled transactions cannot supply later observations. Public IPv4 checks wait at most two seconds for sampling; host LAN and IPv6 checks continue immediately.

The standalone C predictor in `media-agent/src/nat_port_prediction.h` sorts verified observations by send sequence. Linear predictions require at least three observations from the same IPv4 address, consecutive sequence numbers and an identical bounded nonzero step. Unknown mappings use a bounded neighborhood of verified ports. A peer advertises at most 16 speculative candidates, with lower priority than genuine candidates and explicit `vds-predicted`, `vds-nat-step`, `vds-probe-index` and current ICE `ufrag` metadata. Confirmed server-reflexive callbacks include `vds-probe-count`, and are flushed before predictions and before gathering completion, including error/timeout completion. The first current-session mapping metadata opens one 400 ms window that delays previously untested IPv4 server-reflexive checks so speculative checks can punch before old STUN mappings consume new destination-dependent ports. New metadata cannot extend this window; final ICE pair priorities are unchanged.

A successful authenticated ICE check must validate a predicted endpoint before it carries media. Non-selected speculative checks stop when a working pair is selected; consent checks on the selected pair continue. libdatachannel reports rejection of numeric predicted candidates instead of silently recording them in its remote description. Candidate capacity is 128, with a separate 16-speculation limit and reserved space for genuine and peer-reflexive candidates.

This implementation does not promise traversal through arbitrary NAT behavior. Browser WebRTC exposes no API to control its UDP socket directly; the native peer can supply its predicted ports to browser ICE, and browser candidates remain subject to browser scheduling. No TURN server is configured by VDS.

## Random mapping and additional sockets

After the existing sampling deadline, one or two validated primary-socket STUN responses are enough to enter unknown-mapping exploration. Three consecutive consistent observations are still required to classify an endpoint-independent or sequential mapping; no-response transports still cannot start the enhanced planner. Partial STUN availability must not silently disable all auxiliary checks. The existing peer opt-in, current ICE credentials, confirmed remote IPv4 endpoint, probe budget and nomination rules are unchanged.

`vds-nat-sparse-samples` configures four real loopback STUN targets, drops all but one or two responses on the random-NAT side, and drops that side's primary peer path. The other side has a stable known entry. Candidates are trickled without waiting for dead servers to finish gathering. Success requires actual auxiliary ICE/DTLS/SCTP and seven seconds of data echo; a negative case corrupts MESSAGE-INTEGRITY while recomputing a valid fingerprint, and must stay disconnected. The pre-fix DLL fails the same one-response scenario without reaching any peer packet. This is a specific fallback regression, not an ISP success-rate comparison or a change to full-sample random-port exploration.

Genuine server-reflexive candidates arriving after the sampling deadline use the same metadata-emitting callback path as early candidates. Previously, the late branch emitted only the base candidate and omitted `vds-punch`, `vds-probe-count`, and `vds-nat-mode`, making its confirmed exit ineligible for the peer's enhanced planner. Observation count/classification reflects evidence available at emission; a first late sample stays unknown. Prediction-disabled transports retain the standard callback behavior, and peer-reflexive candidates are not newly advertised.

`vds-nat-late-stun` queues real STUN responses on one side for 2.5 seconds, beyond the existing 2-second sampling deadline. With the random side's primary path unavailable, the pre-fix DLL cannot complete in the 12-second observation window. The fixed library must preserve the late candidate's metadata and current credentials, select a real auxiliary path, echo data for seven seconds, then release ports. The fixture does not synthesize ICE/DTLS/SCTP or make receipt of a probe create a NAT mapping.

Sampling metadata now belongs to the candidate object and its common SDP serializer. Previously it was appended only to the trickle callback string, so backend `getLocalDescription` and `createOffer/createAnswer` lost the opt-in and classification. Creation stores currently known evidence; the normal sampling flush updates the evidence before issuing its callback. Parsed metadata is retained when re-serializing a candidate. Explicit `vds-punch 0` remains an opt-out, predictions keep their own fields, and prediction-disabled transports retain ordinary candidates.

The STUN packet regression compares genuine and predicted callback strings against the exported local SDP for IPv4 and mixed IPv4/IPv6 samples. `vds-nat-sdp-candidates` first establishes candidate-free offer/answer credentials, then uses candidates exported by `createOffer/createAnswer` in a complete embedded offer/answer exchange after gathering. It filters out LAN/TCP/relay routes and does not inject trickle candidates as a rescue. Success requires an auxiliary winner, seven seconds of real DTLS/SCTP echo, completed signaling, and port release. The previous DLL fails both the serialization check and the same connection test.

Native peers advertise `vds-punch` and `vds-nat-mode` on confirmed reflexive candidates, bound to the current ICE ufrag. Older/native-browser pairs continue ordinary ICE. Stable/stable and linear-only pairs retain the existing strategy. After primary sampling and a 500 ms ordinary-ICE opportunity, a mutually capable native pair with unknown allocation may explore additional paths. A stable local mapping keeps its original socket. Unknown/unknown starts with one auxiliary UDP socket: destination-dependent mappings already vary by destination, and immediate sixteen-way fanout can exhaust a small NAT table before later hypotheses are explored. If still unconnected, successive passes through exit groups expand to 2, 4, 8, then 16 auxiliary sockets, retaining existing sockets. This preserves initial mapping capacity without permanently discarding source diversity. Other unknown/linear combinations can use up to 16 additional sockets immediately. The pool opens sockets lazily according to the chosen strategy, retaining identities for delayed authenticated checks. The opener returns a contiguous prefix of successfully bound sockets; partial failures shrink that plan to available sockets. If no auxiliary socket can bind, destination exploration continues on the primary instead of being disabled. A single-port local bind range therefore still supports enhanced target exploration. There is still one ICE agent, credential set, role negotiation and nomination decision, with no per-socket worker thread.

Confirmed remote candidates are grouped by IPv4 exit address within the current ICE credentials. Groups are ranked by mapping confidence (stable, linear, unknown), existing candidate priority, then address. The planner rotates across groups instead of committing to the first trickled candidate. This is remote-exit scheduling within the existing ICE agent; it does not infer separate local-interface mappings from mixed STUN observations or replace ordinary ICE pair priorities.

Remote stable mappings use confirmed endpoints. For linear remotes the plan prefers signaled predicted ports before confirmed ports. Unknown remotes add hypotheses sampled from the observed 256-port block and the wider nonprivileged UDP port space. These are exploration guesses, not proof that the allocator uses that block. Unknown plans put new hypotheses before confirmed STUN endpoints, which ordinary ICE already checks. When multiple source sockets are useful, probes are interleaved in waves: each wave visits all destination ports, rotating the source socket by target and wave. Every target/socket pair in that selected strategy is checked once per transmission round. For unknown/unknown pairs, the first wave reuses the primary socket for targets already registered as ordinary UDP ICE checks on that exit address. Novel target hypotheses keep the auxiliary source; subsequent waves retain source diversity. This removes overlapping primary/auxiliary mapping allocations without changing the probe count. A known target reuses primary socket identity, not the standard ICE transaction ID. A blanket primary-first experiment was withdrawn after a worse six-run connectivity sample. Later passes add source diversity gradually; socket creation is lazy and earlier sockets remain available for delayed authenticated requests.

A plan contains at most 100 distinct destination ports and sends each transaction twice over five seconds. Batches contain at most 32 authenticated requests. The first pass keeps the original 20ms spacing for fast discovery; the second starts at the 2.5-second midpoint and spreads its batches across the remaining window. Batch times are anchored to the plan start with at least 20ms between actual batches, avoiding accumulated OS wake rounding. The packet budget and deadline do not increase. If ICE is still connecting without a selected pair, the planner rotates to the next exit and generates fresh transactions and a fresh random seed while reusing its existing sockets. After each pass through the exit groups, block-local sampling decreases from 75% to 50%, 25%, then zero. Ordinary ICE owns the overall connection timeout; these are not session-duration, media bitrate, frame-rate or resolution limits.

Gradual unknown/unknown fanout trades some initial source-port diversity for mapping capacity in later plans. A path requiring additional source sockets may therefore connect in a later five-second plan; this is not a claim of universally faster connection or a proven higher success rate. Ordinary ICE timing is unchanged. Enhanced probes, including those toward confirmed endpoints, now keep their second transmission for the latter half of the plan; this trades immediate repeat latency for better overlap after transient loss. An exhausted permanent mapping table with no reciprocal path remains unreachable in this fixture; local socket closure does not release a router's mapping remotely.

Every probe uses a full random 96-bit STUN transaction ID and ordinary ICE short-term authentication. Responses must match the transaction, remote endpoint and receiving socket. A new plan discards the old probe lookup, so an old reply cannot satisfy a new probe. Candidate pairs and STUN entries retain the local socket index; nomination, consent and media sends use that same socket. Accepted paths join the existing ICE pair selection; UDP writability or a custom magic reply cannot select a media route. Unselected auxiliary sockets are closed after nomination; failure and agent destruction release them. Closing a transport destroys its complete pool, and new transport generations cannot share old probe state. Diagnostic snapshots expose `multiSocketNatEnabled` as capability, not a claim that a random path succeeded.

The random test fixture uses two independent seeded random port permutations, mapping keys `(internal socket, remote endpoint)` and exact inbound endpoint filtering. Inbound packets do not create mappings. It models a finite 256-port allocator window that can exhaust, not the full behavior of an arbitrary ISP NAT. `--random-multi` reports a probabilistic six-seed benchmark, requires actual auxiliary winners and seven seconds of DTLS/SCTP echo after selection, and checks that unused/winner sockets can be rebound after release. It intentionally retains misses; this benchmark is not added as a deterministic CI success-rate gate. The invalid-packet scenario is a deterministic CTest regression and also checks close cancellation/resource release.

```powershell
ctest --test-dir media-agent/build -C Release --output-on-failure
media-agent/build/Release/vds-nat-traversal-e2e.exe --random-baseline
media-agent/build/Release/vds-nat-traversal-e2e.exe --random-multi
media-agent/build/Release/vds-nat-traversal-e2e.exe --exploration-plans
media-agent/build/Release/vds-nat-traversal-e2e.exe --paced-recovery
media-agent/build/Release/vds-nat-traversal-e2e.exe --primary-exploration
```

TURN remains unconfigured. Supporting a wider random allocation space or another router's filtering behavior requires further measurement; a local benchmark is not a mobile/Unicom success-rate claim.

The deterministic exploration regression blackholes incoming traffic, observes targets during the first four seconds and after twelve seconds, and requires actual new destination probes. It requires at least 60 mapped destinations while using fewer than 140 mappings in the first unknown/unknown plan, exactly two total source sockets with one mapping per destination (including ordinary ICE), and actual additional mappings plus additional source sockets in later plans. The final finite table may still fill; the test checks that it is not exhausted in the first pass. The original target-major and subsequent interleaved cartesian schedules fail the first-pass capacity check; a permanently single-socket strategy fails the later source-expansion check. A second case advertises a higher-ranked dead exit, requires auxiliary sockets to visit it first, then observes actual new target mappings at the other exit. It also checks close cancellation and socket release. It tests planner behavior, not successful media through the blackhole. The independent traversal tests still require real DTLS/SCTP data and reject invalid ICE packets.

Diagnostic output includes connection elapsed time, mapping-table occupancy, unique mapped destinations, reciprocal endpoint-filter-compatible mapping pairs and allocation-exhaustion drops. `--random-multi 3 5 6` selects seeds for diagnosis; the default benchmark retains its existing 12-second observation window and acceptance checks. `--random-multi-long 6` observes for 35 seconds, within the existing native ICE connectivity timer, without changing production timeout behavior. Only the NAT permutations are seeded, not cryptographic probe randomness or thread scheduling. The fixture never reclaims mappings and only intercepts destinations in its bound port window: out-of-window outgoing allocations are not modeled. Run native NAT executables serially to avoid port-reservation races between fixtures. These limitations prevent interpreting a few seeded runs as an ISP success-rate measurement.

The exploration regression also checks destination discovery 300ms after the first packet to a target absent from the signaled candidate set, so spreading out the initial pass cannot silently delay discovery.

The paced-recovery regression uses stable/random mapping, endpoint-independent filtering only on the stable side, and exact filtering on the random side. It drops the random peer's primary-socket path to require an auxiliary winner, and injects a two-second bidirectional outage starting with its first auxiliary packet. It does not queue dropped traffic or invent mappings. With no predicted candidates exchanged, ordinary primary retries cannot rescue the test. Recovery must complete within five seconds, then sustain seven seconds of actual DTLS/SCTP echo and release its sockets. This tests timing recovery, not guaranteed traversal of the stricter double-random matrix.

The primary-exploration regression reserves a one-port local range on each endpoint and blackholes peer traffic. It checks prompt first discovery, continued new targets across plans, exactly one source socket, close cancellation, and released ports. It validates bind-failure fallback rather than claiming a media path through a blackhole. Successful matrix rows still require authenticated ICE, DTLS/SCTP echo for seven seconds, and the selected socket remaining usable. A primary-socket winner is valid; unsuccessful cases must still expand source diversity, and the default matrix still requires at least one auxiliary winner.

The fixture also reports first delivered peer-packet time, first observed ICE-ready time, observation-end ICE/PeerConnection states, DTLS packet counts, channel-open state and actual payload receipt. These are passive diagnostics to distinguish absent traversal from incomplete handshake; they do not extend the observation window or count an ICE-ready path as a completed DataChannel.


### ICE-to-DTLS startup handoff (2026-10-18)

An incoming ClientHello can reach libjuice while the receiving ICE transport is still checking. Previously `Transport::recv` discarded it because `DtlsTransport::start` had not registered its callback. The peer then waited for OpenSSL's normal one-second retransmission even though the NAT path already worked. Late path discovery could consume the fixture's remaining twelve-second observation window.

Only the libjuice ICE transport now retains initial, epoch-zero DTLS handshake datagrams before the first receive registration. Registration and replay use the existing callback mutex; saved message pointers are replayed without copying. This startup stash coalesces duplicate packets and is bounded to 16 datagrams / 64 KiB. It does not buffer media or constrain established traffic, sockets, bitrate, frame rate, connection time or retransmission policy. Unregistering clears the stash permanently. DTLS state and MTU initialization precede callback registration so replay cannot race an uninitialized receiver. ICE authentication and DTLS certificate fingerprint verification are unchanged.

`vds-nat-early-handshake` holds real STUN success responses to one peer until after a real ClientHello arrives, preserving all NAT mapping/filtering rules and packet bytes. It requires an early ClientHello, exactly one ClientHello flight, bidirectional payload within 600ms of both ICE transports being ready, seven seconds of continued echo, and socket cleanup. The old DLL fails the single-flight assertion. `vds-early-dtls-callback-tests` covers duplicate coalescing, arrival order, startup bounds, live traffic, unregister and 200 registration races. Both are required by `verify:nat`. `VDS_NAT_TRACE=1` enables verbose native protocol logs for diagnosis only.

### Retain alternate sockets until nomination (2026-10-18)

A selected, writable pair stops exploration but is not necessarily the final nominated pair. Previously expiry of the five-second probe plan called `vds_punch_finish` even before nomination, closing alternate auxiliary sockets. Plan expiry now retires probe transactions only. Existing sockets remain available for authenticated checks and nomination; the existing selected-pair gate prevents another exploration plan. Final nomination, terminal ICE failure, or agent destruction still releases them. This changes no socket/probe counts, retransmissions, connection deadlines or media parameters.

`vds-nat-delayed-nomination` holds genuine USE-CANDIDATE requests until six seconds after the random peer's first auxiliary packet, without changing their bytes or the NAT graph. Its primary path is unavailable. At 5.5 seconds it requires all observed source sockets to remain bound while ICE is connected but not completed. It then requires seven seconds of actual DTLS/SCTP echo, completed nomination, spare release, full release on close, and stopped probes. The old DLL fails; the current DLL passes, including a run whose selected pair changed before final nomination.

For finite-NAT diagnosis, `VDS_NAT_PACKET_TRACE=1` records up to 256 delivered STUN/DTLS control headers, endpoint/socket identities and times, plus the exact observation boundary. It does not record credentials or media payloads and has no production effect. Packet arrival is not proof of successful authentication. This optional diagnostic does not make the NAT matrix deterministic or remove its documented allocation-window limitations.

### Sampled random-port region (2026-10-18)

When at least three distinct genuine srflx ports for the current remote ufrag and same IPv4 exit cross an aligned 256-port boundary, the nearby random hypothesis uses their envelope with tail allowance. One/two samples and same-block samples retain the exact previous plan; no NAT classification changes. Full-range sampling, target/socket counts, timing and validation remain unchanged. The inferred envelope is only a hypothesis, not a confirmed NAT allocation range.

`vds-nat-sampled-range` supplies real cross-boundary STUN observations and blackholes incoming peer traffic. It verifies that the shipped native backend actually explores novel targets beyond the anchor's block during the first plan, excluding signaled endpoints and neighbor predictions; this is a planner integration check, not a connection claim. The old DLL fails with zero such novel targets, while the new DLL passes. Unit tests preserve same-block/sparse behavior and cover arrival ordering, unique hypotheses, port boundaries and later full-range fallback.

For actual transmission comparison, `vds-nat-traversal-e2e --random-multi-offset 128 1 2 3 4` shifts the otherwise unchanged 256-slot NAT pool by 128 ports. Offsets 64/128/192 with seeds 1–4 were fixed before comparison: old 3/12, new 5/12, each success sustaining seven seconds of real DTLS/SCTP. This small unpaired random sample does not establish a general success rate or UU parity; all successes and failures are retained in `REA/reports/vds-random-sampling-range-2026-10-18.md`.


### Preserve STUN DNS address-family diversity (2026-10-18)

Each configured STUN hostname already had two resolved-endpoint slots. The previous resolver copied the first two DNS answers; two IPv6 answers could therefore hide a usable IPv4 answer later in the list (and conversely). The STUN-only selector now scans the full resolver answer, retains the first valid endpoint, and prefers the other family for the second slot. Single-family answers retain their first two distinct endpoints. Duplicate endpoints do not consume the second slot. Address lengths, ports and IPv6 scope identifiers are preserved. General candidate and TURN resolution are unchanged.

This keeps the existing per-host endpoint count, configured server count, probe pacing, retry schedule, socket budget and media behavior. It does not retry every DNS address or cancel a still-pending endpoint when its sibling succeeds. OS AI_ADDRCONFIG filtering is unchanged; DNS failures or a slow blocking resolver are not repaired by this selection change.

`vds-stun-resolver-tests` compiles the exact fingerprinted production selector and covers all 24 permutations of two IPv4/two IPv6 answers, duplicates, single-family fallback, scope IDs, malformed records and numeric resolution. `vds-nat-stun-probe-tests` additionally resolves localhost through the real DLL and silently drops one family's STUN requests in each direction. Both families must be probed from the same source port, the live family must yield a genuine mapped candidate before the dead-family timeout, and destruction must stop probing. The crafted three-or-more-answer ordering is covered by the selector test; localhost does not supply that DNS ordering. These tests do not measure random-NAT traversal or public IPv6 reachability.


### Confirm server-address diversity before stable classification (2026-10-18)

Equal mapped ports observed through different ports on the same STUN IP do not distinguish endpoint-independent from address-dependent mapping. The production classifier now counts only validated IPv4 mapping responses from actual server endpoints. It retains the existing stable classification only with at least two distinct server IPs, otherwise leaving the behavior unknown so fallback exploration remains eligible. Port-sequence prediction and ordinary ICE remain unchanged.

For an unknown remote with only one genuine endpoint, the first probe wave now uses an auxiliary socket for that endpoint rather than reusing ordinary ICE's primary source. Primary reuse remains for multiple-endpoint random exploration. A sole genuine endpoint also stays at the front of the target list, so its existing second transmission can recover promptly after transient loss. This preserves target/socket budgets and the existing two transmissions and pacing, while avoiding waiting for a second plan when the primary path has failed.

The same-address STUN fixture models address-dependent mapping keyed by internal socket and destination IP, with strict endpoint filtering on that peer, alongside a stable peer. It blackholes the address-dependent peer's primary path and disables predicted-candidate exchange; success requires an auxiliary winner, real DTLS/SCTP echo for seven seconds, nomination and release. The previous DLL fails with false stable metadata. Genuine distinct-server and same-server classifications also have real UDP response tests. The delayed-nomination fixture now uses distinct STUN IPs to retain its intended stable/random competing-socket setup; no nomination or release assertions were weakened.


### Rejected target-history experiment and fixture diagnostics (2026-10-18)

Cross-plan target suppression was tested on twelve predeclared double-random cases: 5/12 connected before and 5/12 with the experiment. Production changes were reverted byte-for-byte to this turn's baseline; no target-history exclusion is active. The optional native `--target-overlap` blackhole diagnostic distinguishes repeated target ports, same-source reuse, and new-source choices. It does not count as connectivity success or change runtime limits.

The sparse two-response fixture now delays its second valid response past the sampling deadline and waits for its expected responsive samples before its single batch exchange. Previously it raced on the first candidate callback and immediately asserted the full count. The old gate fails the delayed negative control; real echo, nomination, auxiliary winner and cleanup assertions remain. This is fixture synchronization, not a production trickle delay. See `REA/reports/vds-target-history-2026-10-18.md` for evidence and validation.


### Allocation-model calibration (2026-10-18)

`vds-nat-allocation-model-tests` shares production planning helpers but is a deterministic in-memory allocation/filtering model, not ICE/DTLS/SCTP. It accounts for outbound mappings even when a destination falls outside the receiver allocation pool; the real UDP finite-window fixture cannot intercept those sends. Pool width and mapping capacity are separate. `--matrix` and `--pool-matrix` retain fixed paired samples rather than selecting favorable seeds. Model response paths must never be reported as actual connectivity or UU parity. No production patch or runtime limit changed in this step; see `REA/reports/vds-allocation-model-2026-10-18.md`.


### Progress while subsequent STUN DNS is pending (2026-10-18)

Resolved STUN batches now wake the existing connection worker immediately. The one two-second prediction window starts at the first usable batch rather than after all hostname lookups. A connection-lock-protected resolving flag prevents premature gathering completion and non-deadline prediction emission while further DNS is outstanding; deadline-based partial trickle still proceeds. Clear the flag on completion or resolver-thread creation failure. No added DNS threads, servers, sockets, retry budgets or media restrictions.

`vds-stun-resolver-progress-tests` builds this fingerprinted libjuice source in isolation with a getaddrinfo seam only in agent.c. The old code stalls resolved candidates/data; a wake-only intermediate version completes gathering too soon. Final cases exercise held DNS followed by success/failure, authenticated loopback ICE, bidirectional 4KiB UDP, final nomination and continued data. This focused target does not test DTLS/SCTP or system DNS cancellation. The ordinary DLL/DataChannel regressions remain separate. See `REA/reports/vds-dns-progress-2026-10-18.md`.


### Numeric STUN targets before hostname lookups (2026-10-18)

Stable-partition the existing STUN configuration into numeric addresses then hostnames. The numeric-only hostname predicate performs no DNS query. Preserve order within each class and the four-server/two-address budgets; mapping samples still use actual send sequence. This lets the prior batch wake/window fix work even when a slow hostname precedes a numeric target. No additional resolver threads or runtime timeout changes.

The held-DNS test now covers both orders and successful/failed DNS completion, with real authenticated ICE and 4KiB bidirectional UDP while DNS remains pending. Its CTest process allowance is 30 seconds for four cases, not a client timeout. All-hostname head-of-line blocking and resolver cancellation remain outside this change. See `REA/reports/vds-numeric-stun-2026-10-18.md`.


### 2026-10-18：线性预测首发排序

回归发现 STUN 回复释放较早时隙后，后续预测可抢在已排队的预测之前发出。修复在当前会话、同 IP 的未发送线性预测间保留优先顺序和既有 50ms pacing；普通 ICE、已发送探测与重传不新增约束。新增 `vds-sequential-pacing-tests`，复用正式指纹源码验证前后差异及四种不受影响的对照。见 `REA/reports/vds-numeric-stun-2026-10-18.md`。


### Full outbound NAT fixture (2026-10-18)

`vds-nat-full-egress` compiles the fingerprinted ICE sources with a test-only UDP destination envelope into a separate `build/full-egress/Release/juice.dll`. All fixture IPv4 STUN/peer destinations pass the gateway; outside-pool sends consume mappings, repeat source/destination tuples reuse them, and successful send counts must equal processed datagrams. ICE authentication and real DTLS/SCTP are unchanged. This DLL is never copied to the production runtime. `verify:nat` includes allocation-boundary, authenticated positive/invalid negative, and double-random observation cases; passing these is not a success-rate claim. See `REA/reports/vds-full-egress-2026-10-18.md`.

### Planning seed replay (2026-10-19)

Build `vds-nat-seeded-egress` and run `node scripts/test-native-nat-replay.js` from the repository root. The runner measures the six difficult random-NAT cases twice, with the same target-plan seeds and public port pools, and reports every connection/failure and any changed outcome. It does not turn a failed connection into a successful connectivity assertion. A busy fixed test pool is an error, not permission to switch networks silently.

Set `VDS_NAT_ALLOCATION_TRACE=1` for per-mapping allocation order, source port,
destination and creation time. The fixture renders this bounded trace after the
connection observation, outside packet handling; no payloads or ICE secrets are
included. The replay summary then reports how many mappings use additional
sources for an already visited destination and when the finite table filled.
For strict random/random cases it also includes `mappingGraphAtObservationEnd`:
unmapped destinations, destinations occupied by a non-peer mapping, reverse
source-port mismatches, and exact reciprocal pairs. Analyze archived traces with
`node scripts/analyze-native-nat-mappings.js <log> [<log> ...]`. This offline tool
uses the fixture's two public addresses and one allowed endpoint per mapping;
it rejects stable-mapping scenarios, whose trace does not enumerate all filters.
The trace snapshot can precede final media counters and does not prove that an
authenticated handshake completed. Tests exercise a mapped-but-blocked reverse
endpoint, an actual reciprocal pair, STUN-only occupancy and malformed records.
These are diagnostics, not connectivity criteria. Successful cases still require
the secure channel and sustained payload exchange; fewer allocations alone do
not justify adopting a strategy.

Closed-port checks retain the three-second fixture deadline. A failed rebind
queries Windows UDP ownership: another process owning the endpoint, with no
matching socket owned by the fixture, is reported as `CLOSE-PORT-REASSIGNED`.
An own socket, unknown owner or failed query still fails verification.
`node scripts/test-native-nat-cleanup.js` checks an intentionally held own
socket, delayed release and a separate supervisor taking the released port.
It is included in `verify:nat`; corrupted ICE remains disconnected in all cases.

The isolated `build/seeded-egress/Release/juice.dll` compiles fingerprinted `agent.c` through `tests/juice_seeded_agent.c`. Only the planner's `juice_random(&seed, sizeof(seed))` call is replaced, keyed by fixture scenario, side and plan. Credentials, transaction IDs, ICE tiebreakers and DTLS randomness remain unchanged. Real socket timing, STUN arrival order and thread scheduling are still variable; this is **not fully deterministic network replay**. Neither this DLL nor its exported test hooks belongs in the production runtime. The experiment does not change socket/retry/target budgets or add TURN.

### Joint sampling hint (2026-10-18)

For unknown mappings, raise the first three near-region quotas to 95/75/50% only when local valid observations and remote confirmed candidates each contain at least three distinct ports in one aligned 256-port block. The blocks need not match. Reject mixed local public addresses and duplicate transaction sequences. All other inputs preserve the original plan byte for byte; round four retains the original full-range fallback. This is an uncertain scheduling hint, not NAT classification. Socket, target, retry and timeout budgets are unchanged.

The allocation model now supports independent NAT ranges/capacities/offsets and a `--mixed-matrix` in both directions. Known per-seed regressions remain; modeled response paths do not establish real connectivity or UU parity. See `REA/reports/vds-joint-evidence-2026-10-18.md` for all results, including failures.

### Cross-boundary sampling hint (2026-10-18)

The above hint also accepts four distinct valid samples with a span below 256, even across aligned blocks. Three-sample hints retain the earlier same-block rule; wide spans, duplicates and invalid observations cannot broaden it. Existing sample-envelope generation handles the shifted region. No quotas, sockets, retries or timeouts change. `--timing-matrix` adds deterministic post-STUN probe-start skew and one-way transit delay; it is not a full ICE state-machine simulation. See `REA/reports/vds-span-evidence-2026-10-18.md` for holdout gains and known regressions.


### TCP framing and backpressure (2026-10-18)

Preserve split RFC4571 headers, normalize write errors, stop on zero-progress sends, and drain oversized frames without exposing a claimed length beyond the existing buffer. The read counter accommodates a 65535-byte payload plus its two-byte header. EOF never becomes an empty ICE datagram.

The application sender, poll flusher, pending-write inspection and failure reset share the send mutex; callbacks run outside it. A newly buffered partial write wakes polling after releasing the send mutex, preserving registry-to-send lock order. Temporary backpressure is not a connection failure; real write failures are. These changes preserve existing media limits and NAT socket/target/retry budgets.

`vds-tcp-io-tests` exercises exact fingerprinted parser/poll sources with deterministic I/O; `vds-tcp-wire-tests` uses IPv4/IPv6 sockets, fragmented/oversized frames and a slow reader. They are required by `verify:nat`. These tests do not establish passive ICE TCP, simultaneous open, NAT traversal success or UU parity. See `REA/reports/vds-tcp-foundation-2026-10-18.md` for measured results and remaining work.


### Native active/passive TCP ICE (2026-10-18)

The native libdatachannel configuration now selects the additive `JUICE_ICE_TCP_MODE_BOTH` mode. The poll backend advertises actual passive TCP listeners as well as active candidates; the old active-only mode remains available. Every TCP endpoint owns its own framing, pending write and state. Multiple candidates can progress independently, including when an earlier same-family endpoint stays silent.

Incoming sockets must supply an integrity-checked ICE Binding request with the current credentials before creating a peer-reflexive endpoint or delivering data. Provisional incoming sockets use the existing peer-reflexive candidate capacity and ICE TCP handshake timeout; the oldest provisional socket can be displaced. Authenticated media connections do not gain a duration, bitrate or user-count limit. The new path adds TCP sockets; UDP exploration socket/target/retry settings are unchanged. It does not add TURN or implement TCP simultaneous open/public TCP NAT mappings.

Candidate lookup now includes the socket transport, preventing TCP/UDP endpoints with the same IP and port from aliasing. Actual local TCP endpoints are bound before ICE nomination can report a pair. Existing streams are processed before new accepts, and TCP state updates synchronize with the sender. Bad/expired provisional connections close individually. TCP_NODELAY is enabled for connected sockets.

`vds-tcp-ice-e2e` is mandatory in `verify:nat`: UDP control, TCP IPv4/IPv6, each direction with only one advertised passive endpoint, and idle/invalid-credential interference plus higher-priority silent candidates. TCP cases require seven seconds of sequence-checked 4KiB payload echo and cleanup; both selected candidates must remain TCP. These are local protocol cases, not random-NAT success-rate samples. See `REA/reports/vds-tcp-dual-2026-10-18.md` for source, negative controls, final runtime and desktop TCP video evidence.


### TCP gateway mappings and related-address candidates (2026-10-18)

Desktop mapping now accepts IPv4 UDP host sockets and TCP passive listeners, balances the existing candidate slots across transports, and preserves transport in PCP, NAT-PMP, UPnP and lease ownership keys. UPnP journal records include transport; historical records without it remain UDP for correct cleanup. Active port-9 placeholders are not mapped. This does not add TURN, media restrictions or UDP exploration budgets.

Both candidate parsers now find `tcptype` among complete attribute pairs, including after `raddr`/`rport` as specified by RFC 6544 section 4.5, and reject ambiguous duplicate types. Candidate generation retains that standard order. Local protocol tests use the production desktop mapping functions and native ICE/DTLS/SCTP across a test-only TCP gateway forwarder; the forwarder is not shipped as an application relay. `verify:nat` runs `scripts/test-native-tcp-mapping.js` after the existing native checks. See `REA/reports/vds-tcp-mapping-2026-10-18.md` for results and limits; mapped TCP success is not a random-NAT or UU-parity measurement.

### TCP simultaneous open, TCP STUN and multiple local interfaces (2026-10-19)

The formal patches now include the previously isolated simultaneous-open and TCP STUN implementation. Each address family retains an SO source-port reservation; explicit `stun:host:port?transport=tcp` endpoints use raw STUN Binding over TCP from that port. Peer ICE streams still use RFC4571 framing and integrity-checked ICE credentials. TCP mapping observations do not enter UDP port prediction. Four UDP and four TCP server slots are independent; `RTC_VDS_TCP_STUN` identifies the updated native configuration API. No TURN allocation or media relay is introduced.

For outgoing SO attempts, try distinct real local candidate addresses at the reserved source port, prioritizing validated TCP mapping bases. A failed interface does not cancel another live attempt. Only locally generated ICE Binding requests may fan out before authentication. A response must match the active transaction and endpoint, and the authenticated winner determines the actual local candidate and closes the other attempts. Normal active/passive TCP and UDP remain available; this does not increase UDP prediction budgets or add media limits.

`vds-tcp-so-e2e` is a required native regression covering SO-only ICE/DTLS/SCTP, delayed signaling and stale candidates with sustained echo and release checks. `scripts/test-native-tcp-stun.js` exercises the shipped agent RPC with four local UDP servers plus one TCP server in both orders, fragmented TCP responses, wrong transaction IDs and actual mapped source-port verification. These are capability/regression checks, not six-case random-NAT connection-rate measurements. The native default pool now adds Cloudflare TCP Binding discovery without replacing its four UDP endpoints; browser configuration remains unchanged.

Ordinary active TCP now gathers every local interface, rather than only the first
address in each family, and binds outgoing attempts to those actual active host
bases using fresh ephemeral ports. This also honors an explicitly configured
bind address. The existing logical-connection aggregation keeps a failed NIC
from cancelling a usable one; authentication still selects one physical path
and closes alternatives. The route-selected fallback remains available when no
active host base was gathered. This may create one attempt per real interface;
it does not add random source sockets or change UDP exploration/retry budgets.
`vds-tcp-active-bind-e2e` checks both active/passive directions with distinct
loopback bind addresses, seven-second data echo, actual selected source and
listener release. The Linux kernel source-routing/SNAT comparison additionally
covers interface-order reversal, blackholed/default routes, RST, complete
blocking and wrong credentials; see `REA/reports/vds-tcp-active-source-2026-10-19.md`.

UDP auxiliary checks now spread the existing socket pool across distinct gathered
IPv4 host interfaces when the main socket is wildcard-bound and multiple such
interfaces exist. Explicit binding and the single-interface route-selected path
are preserved. If an address disappears after gathering, another gathered
interface is tried without changing existing socket IDs or increasing the pool.
No local STUN observation is required to authenticate a check to a known remote
endpoint: after the existing discovery grace period, a failed local STUN route
no longer suppresses auxiliary checks entirely. Remote credentials and the
existing candidate eligibility checks remain required. This does not infer a
remote allocation range from missing observations or change media limits.
Windows socket-binding regression and isolated Linux UDP routing/NAT comparisons
cover this path; their results do not replace the difficult double-random NAT
matrix or constitute a same-network UU comparison.

The isolated full-egress, seeded and delayed-TCP fixtures copy the DataChannel DLL from their linked imported target. Copying it from the application runtime before the build finished paired the new juice C API with an old DataChannel DLL. The isolated juice DLLs remain test-only and are never copied into the application runtime.

The actual `createPeer` RPC also validates the selected endpoint merged with the pool using the shared per-transport validator. An obsolete four-total-endpoint check in this second stage rejected the valid four-UDP-plus-TCP case even though the parser and library accepted it; the live-agent TCP STUN test reproduced that rejection before the fix and now covers both configuration orders and excess selected UDP rejection.

For the known default UDP and TCP STUN hostnames, desktop discovery detects synthetic 198.18/15 DNS answers or lookup failure and races two HTTPS DNS resolvers for current public IPv4 records. Recovered UDP addresses replace their own service slots and undergo UDP preflight; if none responds, a responding original service replaces its own recovered slot. TCP addresses use spare TCP discovery slots and preserve explicit configured endpoints and the hostname fallback. DNS failure retains the original service. No public service IP is pinned, no custom/private hostname is submitted, and normal DNS skips HTTPS queries. Discovery shares in-flight work per host, follows DNS TTL with a five-minute maximum cache age, and runs alongside the original UDP preflight before native peer creation. It does not change media timing or UDP exploration budgets. See `REA/reports/vds-tcp-defaults-2026-10-19.md` and `REA/reports/vds-udp-discovery-2026-10-19.md` for the observed proxy-exit versus direct-exit mapping difference and validation boundaries.

### Auxiliary checks with standard ICE peers (2026-10-19)

A peer without VDS candidate extensions can now receive auxiliary checks at its advertised UDP server-reflexive endpoints when the local mapping is not known to be endpoint-independent. This reuses the existing auxiliary socket pool and authenticated ICE path. Missing remote NAT metadata never enables guesses of its remote ports. An omitted candidate ufrag uses the current remote SDP credentials; an explicit mismatching ufrag cannot enable auxiliary checks. VDS-to-VDS random planning and its target/socket/retry budgets are unchanged.

`vds-nat-standard-peer` is required by `verify:nat`. Its fixed-pool full-egress fixture disables auxiliary support on one peer, strips VDS metadata, and drops the other peer's primary path. Positive cases with and without candidate-level ufrag must complete real ICE/DTLS/SCTP, seven seconds of payload echo, final nomination and socket release. Negative cases reject stale credentials and corrupted HMAC. The standard-facing native side may probe only the advertised endpoint. This protocol fixture still uses libdatachannel at both endpoints; it is not a browser fault-injection or cross-ISP comparison. See `REA/reports/vds-standard-peer-2026-10-19.md` for results and limits.

### Standard-peer address groups (2026-10-19)

The standard-peer auxiliary path now includes all eligible advertised IPv4 UDP
srflx endpoints in one plan. It no longer waits five seconds per public address
before reaching a lower-priority live exit. Candidate ufrag checks, deduplication,
authentication, nomination, target/socket caps and probe batching remain in
place. This can schedule more known endpoints in the first plan; it does not
increase the existing caps or guess ports for standard peers. Enhanced-peer
classification and random-port planning retain the previous per-exit policy.

`vds-nat-standard-multiexit`, required by `verify:nat`, places four dead advertised
addresses ahead of a working standard peer, with primary-path traffic dropped.
It checks both priority orders, sustained secure-channel echo, a stale live
candidate among valid dead groups, corrupted authentication and socket cleanup.
The full-egress test boundary also accounts for the four dead loopback aliases;
it never forwards these failed destinations outside the fixture. See
`REA/reports/vds-standard-multiexit-2026-10-19.md` for the native and actual Chromium
comparison, including the distinction from the unchanged double-random matrix.
