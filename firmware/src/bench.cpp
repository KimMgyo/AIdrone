#include "bench.h"

#include <Arduino.h>
#include <string.h>

#include "config.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "ncm.h"

namespace {

constexpr uint16_t kEthHdr = 14;
constexpr uint16_t kIpHdr = 20;
constexpr uint16_t kUdpHdr = 8;
constexpr uint16_t kHdrs = kEthHdr + kIpHdr + kUdpHdr; // 42
constexpr uint16_t kMaxPayload = 1514 - kHdrs;         // 1472
constexpr uint16_t kMinPayload = 16;

// Payload layout, little-endian to match the x86 receiver without swapping.
constexpr uint16_t kOffMagic = kHdrs;      // 4 bytes "AIDR"
constexpr uint16_t kOffSeq = kHdrs + 4;    // uint32
constexpr uint16_t kOffTime = kHdrs + 8;   // uint32, device millis()

uint8_t g_frame[1514];
uint16_t g_frame_len = 0;
volatile bool g_run = false;
volatile uint32_t g_kbps = 0;
volatile uint16_t g_payload = 0;
volatile uint32_t g_interval_us = 0;
volatile uint32_t g_seq = 0;
TaskHandle_t g_task = nullptr;

void put_be16(uint8_t *p, uint16_t v) {
  p[0] = (uint8_t)(v >> 8);
  p[1] = (uint8_t)v;
}

void put_le32(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
  p[2] = (uint8_t)(v >> 16);
  p[3] = (uint8_t)(v >> 24);
}

uint16_t ip_checksum(const uint8_t *hdr, size_t len) {
  uint32_t sum = 0;
  for (size_t i = 0; i + 1 < len; i += 2) {
    sum += ((uint32_t)hdr[i] << 8) | hdr[i + 1];
  }
  while (sum >> 16) {
    sum = (sum & 0xFFFF) + (sum >> 16);
  }
  return (uint16_t)(~sum);
}

// Built once per start(): only the sequence number and timestamp change per
// packet, and neither is covered by a checksum we ship (the UDP checksum is
// legally zero over IPv4), so nothing has to be recomputed in the hot loop.
void build_template(uint16_t payload) {
  memset(g_frame, 0, sizeof(g_frame));
  g_frame_len = kHdrs + payload;

  memset(g_frame + 0, 0xFF, 6); // dst: Ethernet broadcast
  memcpy(g_frame + 6, ncm::device_mac(), 6);
  put_be16(g_frame + 12, 0x0800); // IPv4

  uint8_t *ip = g_frame + kEthHdr;
  ip[0] = 0x45; // IPv4, IHL 5
  ip[1] = 0x00;
  put_be16(ip + 2, kIpHdr + kUdpHdr + payload);
  put_be16(ip + 4, 0);    // id, fixed so the header checksum stays constant
  put_be16(ip + 6, 0);    // no flags, no fragment offset
  ip[8] = 64;             // TTL
  ip[9] = 17;             // UDP
  put_be16(ip + 10, 0);   // checksum placeholder
  ip[12] = 192; ip[13] = 168; ip[14] = 4; ip[15] = 1;      // src 192.168.4.1
  memset(ip + 16, 0xFF, 4);                                 // dst 255.255.255.255
  put_be16(ip + 10, ip_checksum(ip, kIpHdr));

  uint8_t *udp = g_frame + kEthHdr + kIpHdr;
  put_be16(udp + 0, BENCH_PORT);
  put_be16(udp + 2, BENCH_PORT);
  put_be16(udp + 4, kUdpHdr + payload);
  put_be16(udp + 6, 0); // checksum omitted (allowed for IPv4)

  memcpy(g_frame + kOffMagic, "AIDR", 4);
  for (uint16_t i = kHdrs + 12; i < g_frame_len; i++) {
    g_frame[i] = (uint8_t)i;
  }
}

void emit() {
  put_le32(g_frame + kOffSeq, g_seq++);
  put_le32(g_frame + kOffTime, millis());
  ncm::queue(g_frame, g_frame_len);
}

// Token-bucket pacing against the microsecond timer. Catching up in small
// bursts (rather than one packet per tick) is both closer to how video
// actually arrives and immune to the 1 ms FreeRTOS tick being coarser than
// the inter-packet interval.
void bench_task(void *) {
  int64_t epoch = esp_timer_get_time();
  uint64_t due_total = 0;

  for (;;) {
    if (!g_run) {
      epoch = esp_timer_get_time();
      due_total = 0;
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }

    const uint32_t interval = g_interval_us;
    if (!interval) {
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }

    const uint64_t elapsed = (uint64_t)(esp_timer_get_time() - epoch);
    const uint64_t target = elapsed / interval;
    uint32_t burst = 0;
    while (due_total < target && burst < 64) {
      emit();
      due_total++;
      burst++;
    }
    vTaskDelay(1);
  }
}

} // namespace

namespace bench {

bool begin() {
  return xTaskCreatePinnedToCore(bench_task, "bench", 3072, nullptr, 4, &g_task, 1) == pdPASS;
}

void start(uint32_t kbps_in, uint16_t payload_in) {
  if (!kbps_in) {
    stop();
    return;
  }
  uint16_t payload = payload_in;
  if (payload < kMinPayload) payload = kMinPayload;
  if (payload > kMaxPayload) payload = kMaxPayload;

  g_run = false;
  vTaskDelay(pdMS_TO_TICKS(5)); // let the generator settle before we retemplate

  build_template(payload);
  g_payload = payload;
  g_kbps = kbps_in;
  g_seq = 0;

  // interval_us = 1e6 * frame_bits / bits_per_second
  const uint64_t frame_bits = (uint64_t)g_frame_len * 8ull;
  uint64_t iv = (frame_bits * 1000000ull) / ((uint64_t)kbps_in * 1000ull);
  if (!iv) iv = 1;
  g_interval_us = (uint32_t)iv;
  g_run = true;
}

void stop() { g_run = false; }

bool running() { return g_run; }
uint32_t kbps() { return g_kbps; }
uint16_t payload() { return g_payload; }
uint16_t frame_bytes() { return g_frame_len; }
uint32_t sent() { return g_seq; }

} // namespace bench
