#pragma once
#include <stddef.h>
#include <stdint.h>
namespace bulk {
constexpr uint16_t kMagic = 0xA1D2;
constexpr uint16_t kMaxPayload = 2048;
constexpr uint8_t kVendorInterface = 0, kBulkOutEndpoint = 0x01, kBulkInEndpoint = 0x81;
// Wire: LE magic, udp_port, payload_len, then payload. Serialization is explicit.
struct BulkRecord { uint16_t udp_port; uint16_t payload_len; uint8_t payload[kMaxPayload]; };
struct Stats { uint32_t host_records, host_dropped, device_records, device_dropped, framing_errors; };
bool publish(uint16_t port, const uint8_t *payload, uint16_t length);
bool take_host_record(BulkRecord &record);
void pump_usb_tx();
Stats stats();
}