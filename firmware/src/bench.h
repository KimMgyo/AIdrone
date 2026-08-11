// -----------------------------------------------------------------------------
// Synthetic load generator: measures the USB-NCM link in isolation.
//
// It injects fully-formed Ethernet/IPv4/UDP broadcast frames straight into the
// same ring the Wi-Fi shuttle feeds, so it exercises the real transmit path
// rather than a parallel one -- but with zero dependence on the Tello, the
// radio, or DHCP. Broadcast at both layers means the host needs no address
// configuration on either Windows or Ubuntu: bind UDP :BENCH_PORT and count.
//
// Each payload carries a magic, a sequence number and the device's millis(),
// which is what lets the receiver separate loss from reordering.
// -----------------------------------------------------------------------------
#pragma once

#include <stdint.h>

namespace bench {

bool begin();

// kbps is the wire rate including Ethernet/IP/UDP headers. payload is the UDP
// payload in bytes, clamped to [16, 1472].
void start(uint32_t kbps, uint16_t payload);
void stop();

bool running();
uint32_t kbps();
uint16_t payload();
uint16_t frame_bytes();
uint32_t sent();

} // namespace bench
