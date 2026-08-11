// -----------------------------------------------------------------------------
// Layer-2 shuttle between the Tello's soft-AP and the USB NIC.
//
// esp_wifi_internal_reg_rxcb() supports exactly ONE callback per interface, so
// registering ours REPLACES the one esp_netif installed. If we simply consumed
// every frame, the soft-AP's own DHCP server would go deaf and the Tello would
// never get a lease. So the callback demultiplexes on the destination MAC:
//
//   broadcast / multicast (DHCP, ARP) -> BOTH the laptop and our lwIP stack
//   unicast to the ESP32's AP MAC     -> lwIP only
//   any other unicast                 -> the laptop only
//
// Frames never touch lwIP's UDP mailbox on their way to the host, which is
// what removes the 6-datagram (~8.8 KB) burst ceiling of the old path.
// -----------------------------------------------------------------------------
#pragma once

#include <stdint.h>

namespace shuttle {

struct Stats {
  uint32_t rx_host;       // Wi-Fi frames shuttled to the laptop
  uint32_t rx_host_bytes;
  uint32_t rx_group;      // broadcast/multicast, delivered to both sides
  uint32_t rx_self;       // unicast addressed to the ESP32, lwIP only
  uint32_t rx_runt;       // shorter than an Ethernet header; discarded
  uint32_t tx_wifi;       // frames injected from the laptop onto the AP
  uint32_t tx_wifi_err;
};

bool begin();

// Detaches the USB leg without touching the AP, so a bench run can measure the
// USB link with zero Wi-Fi traffic competing for the ring.
void set_enabled(bool on);
bool enabled();

uint8_t clients();
uint32_t tello_ip(); // 0 until the soft-AP hands out a lease

void snapshot(Stats &out);
void reset_stats();

} // namespace shuttle
