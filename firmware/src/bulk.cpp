#include "bulk.h"

#include <Arduino.h>
#include <USB.h>
#include <esp32-hal-tinyusb.h>
#include <string.h>
#include <tusb.h>

namespace {

constexpr size_t kQueueCapacity = 12;
constexpr size_t kHeaderLength = 6;
constexpr uint8_t kEndpointPacketSize = 64;

class Ring {
 public:
  bool push(uint16_t port, const uint8_t* payload, uint16_t payload_length) {
    if (payload_length > bulk::kMaxPayload || (payload_length != 0 && payload == nullptr)) {
      return false;
    }

    portENTER_CRITICAL(&lock_);
    if (count_ == kQueueCapacity) {
      tail_ = (tail_ + 1) % kQueueCapacity;
      --count_;
      ++dropped_;
    }

    bulk::BulkRecord& destination = records_[head_];
    destination.udp_port = port;
    destination.payload_len = payload_length;
    if (payload_length != 0) {
      memcpy(destination.payload, payload, payload_length);
    }
    head_ = (head_ + 1) % kQueueCapacity;
    ++count_;
    portEXIT_CRITICAL(&lock_);
    return true;
  }

  bool pop(bulk::BulkRecord& record) {
    portENTER_CRITICAL(&lock_);
    if (count_ == 0) {
      portEXIT_CRITICAL(&lock_);
      return false;
    }
    record = records_[tail_];
    tail_ = (tail_ + 1) % kQueueCapacity;
    --count_;
    portEXIT_CRITICAL(&lock_);
    return true;
  }

  uint32_t dropped() {
    portENTER_CRITICAL(&lock_);
    const uint32_t result = dropped_;
    portEXIT_CRITICAL(&lock_);
    return result;
  }

 private:
  bulk::BulkRecord records_[kQueueCapacity]{};
  size_t head_ = 0;
  size_t tail_ = 0;
  size_t count_ = 0;
  uint32_t dropped_ = 0;
  portMUX_TYPE lock_ = portMUX_INITIALIZER_UNLOCKED;
};

Ring g_host_records;
Ring g_device_records;
portMUX_TYPE g_stats_lock = portMUX_INITIALIZER_UNLOCKED;
uint32_t g_host_record_count = 0;
uint32_t g_device_record_count = 0;
uint32_t g_framing_errors = 0;

void increment(uint32_t& counter) {
  portENTER_CRITICAL(&g_stats_lock);
  ++counter;
  portEXIT_CRITICAL(&g_stats_lock);
}

enum class ParseState : uint8_t {
  MagicLow,
  MagicHigh,
  PortLow,
  PortHigh,
  LengthLow,
  LengthHigh,
  Payload,
};

ParseState g_parse_state = ParseState::MagicLow;
uint16_t g_parse_port = 0;
uint16_t g_parse_length = 0;
uint16_t g_parse_offset = 0;
uint8_t g_parse_payload[bulk::kMaxPayload];

void reset_parser() {
  g_parse_state = ParseState::MagicLow;
  g_parse_port = 0;
  g_parse_length = 0;
  g_parse_offset = 0;
}

void ingest_host_bytes(const uint8_t* bytes, size_t length) {
  for (size_t index = 0; index < length; ++index) {
    const uint8_t byte = bytes[index];
    switch (g_parse_state) {
      case ParseState::MagicLow:
        g_parse_state = byte == static_cast<uint8_t>(bulk::kMagic) ? ParseState::MagicHigh
                                                                    : ParseState::MagicLow;
        break;
      case ParseState::MagicHigh:
        if (byte == static_cast<uint8_t>(bulk::kMagic >> 8)) {
          g_parse_state = ParseState::PortLow;
        } else {
          g_parse_state = byte == static_cast<uint8_t>(bulk::kMagic) ? ParseState::MagicHigh
                                                                      : ParseState::MagicLow;
        }
        break;
      case ParseState::PortLow:
        g_parse_port = byte;
        g_parse_state = ParseState::PortHigh;
        break;
      case ParseState::PortHigh:
        g_parse_port |= static_cast<uint16_t>(byte) << 8;
        g_parse_state = ParseState::LengthLow;
        break;
      case ParseState::LengthLow:
        g_parse_length = byte;
        g_parse_state = ParseState::LengthHigh;
        break;
      case ParseState::LengthHigh:
        g_parse_length |= static_cast<uint16_t>(byte) << 8;
        if (g_parse_length > bulk::kMaxPayload) {
          increment(g_framing_errors);
          reset_parser();
        } else if (g_parse_length == 0) {
          g_host_records.push(g_parse_port, nullptr, 0);
          increment(g_host_record_count);
          reset_parser();
        } else {
          g_parse_offset = 0;
          g_parse_state = ParseState::Payload;
        }
        break;
      case ParseState::Payload:
        g_parse_payload[g_parse_offset++] = byte;
        if (g_parse_offset == g_parse_length) {
          g_host_records.push(g_parse_port, g_parse_payload, g_parse_length);
          increment(g_host_record_count);
          reset_parser();
        }
        break;
    }
  }
}

struct PendingDeviceRecord {
  bulk::BulkRecord record{};
  uint8_t header[kHeaderLength]{};
  size_t offset = 0;
  size_t length = 0;
  bool active = false;
};

PendingDeviceRecord g_pending_device_record;

void load_next_device_record() {
  if (!g_device_records.pop(g_pending_device_record.record)) {
    return;
  }

  const bulk::BulkRecord& record = g_pending_device_record.record;
  g_pending_device_record.header[0] = static_cast<uint8_t>(bulk::kMagic);
  g_pending_device_record.header[1] = static_cast<uint8_t>(bulk::kMagic >> 8);
  g_pending_device_record.header[2] = static_cast<uint8_t>(record.udp_port);
  g_pending_device_record.header[3] = static_cast<uint8_t>(record.udp_port >> 8);
  g_pending_device_record.header[4] = static_cast<uint8_t>(record.payload_len);
  g_pending_device_record.header[5] = static_cast<uint8_t>(record.payload_len >> 8);
  g_pending_device_record.offset = 0;
  g_pending_device_record.length = kHeaderLength + record.payload_len;
  g_pending_device_record.active = true;
}

uint16_t build_vendor_descriptor(uint8_t* destination, uint8_t* interface_count) {
  if (*interface_count != 0) {
    return 0;
  }

  const uint8_t description_index = tinyusb_add_string_descriptor("AIdrone USB Bulk");
  const uint8_t descriptor[TUD_VENDOR_DESC_LEN] = {
      TUD_VENDOR_DESCRIPTOR(0, description_index, bulk::kBulkOutEndpoint, bulk::kBulkInEndpoint,
                            kEndpointPacketSize),
  };
  memcpy(destination, descriptor, sizeof(descriptor));
  *interface_count = 1;
  return sizeof(descriptor);
}

class VendorRegistration {
 public:
  VendorRegistration() {
    tinyusb_enable_interface(USB_INTERFACE_VENDOR, TUD_VENDOR_DESC_LEN, build_vendor_descriptor);
  }
};

VendorRegistration g_vendor_registration;

} // namespace

namespace bulk {

bool publish(uint16_t port, const uint8_t* payload, uint16_t payload_length) {
  const bool accepted = g_device_records.push(port, payload, payload_length);
  if (accepted) {
    increment(g_device_record_count);
  }
  return accepted;
}

bool take_host_record(BulkRecord& record) {
  return g_host_records.pop(record);
}

void pump_usb_tx() {
  if (!tud_vendor_n_mounted(0)) {
    return;
  }
  if (!g_pending_device_record.active) {
    load_next_device_record();
  }
  if (!g_pending_device_record.active) {
    return;
  }

  const uint32_t available = tud_vendor_n_write_available(0);
  if (available == 0) {
    return;
  }

  const uint8_t* bytes;
  size_t contiguous_length;
  if (g_pending_device_record.offset < kHeaderLength) {
    bytes = g_pending_device_record.header + g_pending_device_record.offset;
    contiguous_length = kHeaderLength - g_pending_device_record.offset;
  } else {
    const size_t payload_offset = g_pending_device_record.offset - kHeaderLength;
    bytes = g_pending_device_record.record.payload + payload_offset;
    contiguous_length = g_pending_device_record.record.payload_len - payload_offset;
  }

  size_t to_write = g_pending_device_record.length - g_pending_device_record.offset;
  if (to_write > contiguous_length) {
    to_write = contiguous_length;
  }
  if (to_write > available) {
    to_write = available;
  }

  const uint32_t written = tud_vendor_n_write(0, bytes, to_write);
  if (written == 0) {
    return;
  }
  g_pending_device_record.offset += written;
  tud_vendor_n_write_flush(0);
  if (g_pending_device_record.offset == g_pending_device_record.length) {
    g_pending_device_record.active = false;
  }
}

Stats stats() {
  Stats result{};
  portENTER_CRITICAL(&g_stats_lock);
  result.host_records = g_host_record_count;
  result.device_records = g_device_record_count;
  result.framing_errors = g_framing_errors;
  portEXIT_CRITICAL(&g_stats_lock);
  result.host_dropped = g_host_records.dropped();
  result.device_dropped = g_device_records.dropped();
  return result;
}

} // namespace bulk

extern "C" void tud_vendor_rx_cb(uint8_t interface_number, const uint8_t* bytes,
                                 uint16_t length) {
  if (interface_number == bulk::kVendorInterface && bytes != nullptr) {
    // The buffered TinyUSB vendor driver copies this direct callback payload
    // into its 64-byte RX FIFO too. We consume the direct copy above, so clear
    // the duplicate FIFO to rearm EP 0x01 for the next host transfer.
    ingest_host_bytes(bytes, length);
    tud_vendor_n_read_flush(interface_number);
  }
}
