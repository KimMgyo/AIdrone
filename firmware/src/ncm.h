// -----------------------------------------------------------------------------
// USB CDC-NCM data plane: turns the USB-C cable into a real Ethernet NIC.
//
// Producers (the Wi-Fi RX callback, the bench generator) call queue(); it
// copies into a ring and returns immediately -- it NEVER blocks and never
// waits on USB. The ring is drained into TinyUSB from the TinyUSB task itself
// via usbd_defer_func(); see the long comment above the pump in ncm.cpp for
// why every single driver call has to land in that one task.
//
// That split is the whole point. Blocking a producer on USB readiness would
// stall the Wi-Fi driver's RX task, which is how the previous design ended up
// with multi-second video freezes.
// -----------------------------------------------------------------------------
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace ncm {

struct Stats {
  uint32_t q_pkts;    // frames accepted into the ring
  uint32_t q_bytes;
  uint32_t tx_pkts;   // frames handed to TinyUSB
  uint32_t tx_bytes;
  uint32_t drop_full; // frames evicted by drop-oldest because the ring was full
  uint32_t drop_big;  // frames refused: larger than a single ring can hold
  uint32_t stalls;    // pump iterations where USB could not accept the frame
  uint32_t recoveries; // USB link bounces: stall-watchdog forced + manual
  uint32_t hiwater;   // peak ring occupancy in bytes; reset by snapshot()
  // Frames the HOST sent us. Useful context when reading the console -- it is
  // the only sign of life from the far end -- but NOT a liveness signal a
  // watchdog can act on; see link_up() below. The receiver in desktop/rx.ts
  // sends a 1 Hz heartbeat so an operator can tell a quiet host from a dead one.
  uint32_t rx_pkts;
};

// Registers the NCM interface, then starts the USB device. MUST be called from
// setup(), before anything else touches USB, and exactly once.
bool begin(size_t ring_bytes);

// True if the CDC-NCM interface was accepted at static init, before the core
// started TinyUSB. False means the descriptor never made it into the config
// and no amount of replugging will produce a NIC.
bool registered();

// USB-configured, i.e. tud_ready(). This is WEAKER than "the NIC is up", and the
// gap is a measured failure mode, not a theoretical one. The Windows NCM adapter
// goes Disconnected (LinkSpeed 0 bps, host IPv4 gone) in two distinct shapes,
// both with tud_ready() still true, and telling them apart decides who can fix
// what:
//
//   REFUSES  tud_network_can_xmit() rejects every frame forever -- measured
//            stalls pinned at ~1130/s, tx=0, ring at high-water dropping all of
//            it. Device-visible and device-curable: the stall watchdog in
//            ncm.cpp bounces USB and TX resumes immediately.
//   ACCEPTS  the host takes every frame at full rate and discards it, so the
//            device streams into a pipe with no other end. Nothing on this side
//            can see it: no stalls, no errors. Only the far end knows.
//
// The second shape is genuinely undecidable here. NCM exposes no datapath
// liveness signal, tud_network_init_cb() is an ECM/RNDIS-era callback the NCM
// driver never invokes (verified: a full detach/attach never fires it), and "no
// host frames arriving" is ambiguous -- with no receiver running the host is
// legitimately quiet, while Windows alone emits ARP/mDNS bursts that hold a 3 s
// streak. A watchdog built on that signal was measured bouncing USB every few
// seconds, audibly, curing nothing; it is gone. Detection belongs to the far end
// (desktop/rx.ts knows whether frames reach it), and so does the cure, because a
// bounce does not revive a host adapter that is already Disconnected -- verified:
// after one bounce the device transmits cleanly while Windows still reads 0 bps
// until Restart-NetAdapter (desktop/nic-restart.ps1).
bool link_up();

// Force a USB detach/attach so the host re-enumerates and rebuilds the NCM
// datapath. Safe to call from any task: the bounce is deferred into the
// TinyUSB task, which is the only context allowed to touch the driver.
// The detach is deliberately seconds long -- measured, a 50 ms bounce and even a
// full ESP.restart() both leave Windows holding the same dead NIC instance.
void recover();

// Copy one Ethernet frame toward the host. Non-blocking. Returns false if the
// frame was refused outright (oversized); a frame that displaces older queued
// frames still returns true.
bool queue(const uint8_t *frame, uint16_t len);

// Host-to-device frames are handed to this sink from the USB task context.
// Keep the sink short; it runs inside the TinyUSB receive path.
using HostSink = void (*)(const uint8_t *frame, uint16_t len);
void on_host_frame(HostSink sink);

const uint8_t *host_mac();   // MAC the host's NIC end will use
const uint8_t *device_mac(); // MAC of our end of the USB link

// Cumulative counters, except hiwater which is peak-since-last-snapshot.
void snapshot(Stats &out);
void reset_stats();

} // namespace ncm
