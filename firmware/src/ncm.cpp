#include "ncm.h"

#include <Arduino.h>
#include <USB.h>
#include <string.h>

#include "esp32-hal-tinyusb.h"
#include "esp_heap_caps.h"
#include "esp_mac.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "tusb.h"
#include "device/usbd_pvt.h" // usbd_defer_func(): run a callback in the TinyUSB task

#if !CFG_TUD_NCM
#error "CFG_TUD_NCM is 0. The prebuilt arduino-esp32 TinyUSB must have CONFIG_TINYUSB_NCM_ENABLED=1."
#endif

// TinyUSB requires these two symbols from the application.
uint8_t tud_network_mac_address[6];

namespace {

// ---- MAC addresses ---------------------------------------------------------
// tud_network_mac_address is what the HOST's NIC adopts (it is handed over in
// the iMACAddress string descriptor). Our own end must differ, so we flip the
// low bit of the last octet -- bit 0 of octet 0 is the multicast bit and must
// stay clear, bit 1 of octet 0 marks the address locally administered.
uint8_t g_dev_mac[6];
char g_mac_str[13];              // 12 uppercase hex chars, NCM spec
const char *g_ncm_desc = "AIdrone NCM";
uint8_t g_desc_stridx = 0;
uint8_t g_mac_stridx = 0;

void derive_macs() {
  uint8_t base[6];
  esp_read_mac(base, ESP_MAC_WIFI_STA);

  tud_network_mac_address[0] = 0x02; // locally administered, unicast
  memcpy(tud_network_mac_address + 1, base + 1, 5);
  tud_network_mac_address[5] &= 0xFE; // host side: even
  memcpy(g_dev_mac, tud_network_mac_address, 6);
  g_dev_mac[5] |= 0x01; // device side: odd

  static const char hex[] = "0123456789ABCDEF";
  for (int i = 0; i < 6; i++) {
    g_mac_str[i * 2] = hex[tud_network_mac_address[i] >> 4];
    g_mac_str[i * 2 + 1] = hex[tud_network_mac_address[i] & 0x0F];
  }
  g_mac_str[12] = '\0';
}

// ---- Descriptor ------------------------------------------------------------
uint16_t ncm_descriptor_cb(uint8_t *dst, uint8_t *itf) {
  // Notification is IN-only; the bulk pair shares one endpoint number.
  const uint8_t ep_notif = tinyusb_get_free_in_endpoint();
  if (!ep_notif) {
    return 0;
  }
  const uint8_t ep_data = tinyusb_get_free_duplex_endpoint();
  if (!ep_data) {
    return 0;
  }

  const uint8_t desc[] = {TUD_CDC_NCM_DESCRIPTOR(*itf, g_desc_stridx, g_mac_stridx, (uint8_t)(0x80 | ep_notif), 64,
                                                 ep_data, (uint8_t)(0x80 | ep_data), CFG_TUD_NET_ENDPOINT_SIZE,
                                                 CFG_TUD_NET_MTU)};
  *itf += 2; // NCM spans a control interface and a data interface
  memcpy(dst, desc, sizeof(desc));
  return sizeof(desc);
}

// The interface MUST be registered before tinyusb_init() runs, and with
// ARDUINO_USB_CDC_ON_BOOT=1 the core calls USB.begin() from app_main() -- i.e.
// BEFORE setup(). (USB.h:25 redefines ARDUINO_USB_ON_BOOT unguarded, so a
// -DARDUINO_USB_ON_BOOT=0 on the command line cannot suppress that call.)
// Registering from a global constructor is how USBCDC itself solves this:
// C++ ctors run in do_global_ctors() before app_main() is ever entered, and
// tinyusb_enable_interface() only appends to arrays that live in .data/.bss.
bool g_registered = false;

struct NcmRegistrar {
  NcmRegistrar() {
    derive_macs();
    // Descriptor strings are stored by POINTER, so they must outlive this.
    g_desc_stridx = tinyusb_add_string_descriptor(g_ncm_desc);
    g_mac_stridx = tinyusb_add_string_descriptor(g_mac_str);
    g_registered =
        tinyusb_enable_interface(USB_INTERFACE_CUSTOM, TUD_CDC_NCM_DESC_LEN, ncm_descriptor_cb) == ESP_OK;
  }
};

const NcmRegistrar g_registrar;

// ---- Ring ------------------------------------------------------------------
// Byte ring of [uint16 length][payload] records. Single consumer (the pump
// task); producers are the Wi-Fi RX callback and the bench task, serialised by
// a spinlock. Full ring evicts the OLDEST record: in live video a stale frame
// has negative value, and blocking or growing the queue only converts loss
// into latency that never drains.
uint8_t *g_ring = nullptr;
size_t g_cap = 0;
size_t g_head = 0; // read cursor
size_t g_tail = 0; // write cursor
size_t g_used = 0;
portMUX_TYPE g_lock = portMUX_INITIALIZER_UNLOCKED;

ncm::Stats g_stats;
TaskHandle_t g_armer = nullptr;
ncm::HostSink g_sink = nullptr;

inline void ring_write(const uint8_t *src, size_t n) {
  const size_t first = (n < g_cap - g_tail) ? n : g_cap - g_tail;
  memcpy(g_ring + g_tail, src, first);
  if (n > first) {
    memcpy(g_ring, src + first, n - first);
  }
  g_tail = (g_tail + n) % g_cap;
}

inline void ring_copy_out(uint8_t *dst, size_t n) {
  const size_t first = (n < g_cap - g_head) ? n : g_cap - g_head;
  memcpy(dst, g_ring + g_head, first);
  if (n > first) {
    memcpy(dst + first, g_ring, n - first);
  }
  g_head = (g_head + n) % g_cap;
}

inline void ring_skip(size_t n) { g_head = (g_head + n) % g_cap; }

// Caller holds the lock. Discards the oldest record.
void drop_oldest() {
  uint8_t hdr[2];
  hdr[0] = g_ring[g_head];
  hdr[1] = g_ring[(g_head + 1) % g_cap];
  const size_t len = (size_t)hdr[0] | ((size_t)hdr[1] << 8);
  ring_skip(2 + len);
  g_used -= 2 + len;
  g_stats.drop_full++;
}

// ---- Pump ------------------------------------------------------------------
// EVERY call into the TinyUSB NCM driver happens in the TinyUSB task. That is
// not a style preference, it is the difference between a working link and a
// permanently dead one.
//
// ncm_device.c keeps its NTB pool in two plain arrays (xmit_free_ntb[],
// xmit_ready_ntb[]) with no locking, and the TX-complete path touches them from
// the TinyUSB task. Calling tud_network_xmit() from a task of our own races
// that, and the loser is silent: xmit_put_ntb_into_ready_list() gives up with a
// debug log and drops the NTB pointer on the floor. One leaked NTB and
// xmit_get_free_ntb() returns NULL forever -- the TX path is dead while
// tud_ready() still cheerfully reports "up".
//
// Measured on this board before the change: a 12 Mb/s step wedged the link
// permanently. The host went to 0 pkt/s and never came back, `stall` pinned at
// ~1000/s (one per 1 ms retry tick), and the ring stayed frozen at 62.7k of
// 64k for minutes after the generator had stopped.
//
// The driver is a prebuilt binary in framework-arduinoespressif32-libs, so it
// cannot be fixed in place. usbd_defer_func() posts a callback into the device
// event queue, which tud_task() then runs in the TinyUSB task -- serialised
// with the driver's own callbacks by construction.
//
// Consequence for anyone editing this: g_staging, g_pending and g_stall_run are
// TinyUSB-task-only state. Do not touch them from anywhere else.
//
// tud_network_xmit_cb() runs synchronously inside tud_network_xmit(), so the
// staging buffer is free again the moment that call returns -- no in-flight
// ownership to track. We pop BEFORE asking tud_network_can_xmit(), because
// asking with one length and then transmitting a different (larger) frame
// would overrun the NTB the driver just sized for us.
uint8_t g_staging[CFG_TUD_NET_MTU];
uint16_t g_pending = 0;    // frame popped from the ring, not yet accepted
uint32_t g_stall_run = 0;  // consecutive steps that could not transmit
bool g_armed = false;      // guarded by g_lock: at most one step in flight
bool g_tx_blocked = false; // guarded by g_lock: g_pending is stuck on a busy NTB

// A leaked NTB cannot be repaired from outside the driver, so past this many
// consecutive failed steps we bounce the link instead: disconnect/connect makes
// the host re-enumerate, and netd_init() rebuilds the NTB pool from scratch.
// At one step per armer tick that is about a second of total TX failure, which
// is already far outside anything a healthy link does.
constexpr uint32_t kStallRunLimit = 1000;

// How long recover_link() holds the USB detach. A measured value, not a guess.
//
// Measured, in the order tried: a 50 ms bounce leaves Windows holding the same
// wedged NIC instance - the device re-enumerates, PnP reports the NCM function
// OK, and the adapter stays Disconnected / 0 bps. `ESP.restart()`: the same.
// `Restart-NetAdapter` (desktop/nic-restart.ps1, admin): the same, even against
// a freshly restarted device. A 3 s bounce: the same, re-confirmed against a
// live wedge where the device reported `usb=up` with zero stalls throughout.
// The two combined: the same.
//
// The ONE thing that ever worked is a reflash, every time - and what a reflash
// does that none of the above does is park the board in ROM, with no NCM
// function on the bus at all, for **~12 s**. Long absence is the only variable
// that correlates with the cure, so this is set to match it rather than to be
// merely longer than a USB debounce.
//
// Stalling tud_task() while detached costs nothing: there is no USB to service
// until we reconnect.
constexpr uint32_t kBounceDetachMs = 12000;

// Every cure shares one cooldown, because the cure is a multi-second outage that
// the host announces with a device-disconnect chime. A watchdog that treats a
// condition its bounce cannot fix -- a host with nothing draining the NIC --
// turns into an endless detach/attach cycle that is worse than the stall it is
// treating. One bounce per window, whoever asks.
//
// Expressed relative to the detach so the two cannot drift apart: what matters
// is the LIVE time between bounces, and a longer detach must not eat into it.
constexpr uint32_t kBounceCooldownMs = kBounceDetachMs + 30000;
uint32_t g_last_bounce_ms = 0;

// Runs in the TinyUSB task.
void recover_link() {
  const uint32_t now = millis();
  if (g_last_bounce_ms && now - g_last_bounce_ms < kBounceCooldownMs) {
    g_stall_run = 0; // suppressed: restart the count instead of spinning at the limit
    return;
  }
  g_last_bounce_ms = now;

  portENTER_CRITICAL(&g_lock);
  g_stats.recoveries++;
  // Whatever is queued is stale by now, and a drop-oldest ring has no interest
  // in stale frames.
  g_head = g_tail = g_used = 0;
  g_tx_blocked = false;
  portEXIT_CRITICAL(&g_lock);
  g_pending = 0;
  g_stall_run = 0;

  // Long, deliberately: see kBounceDetachMs.
  tud_disconnect();
  vTaskDelay(pdMS_TO_TICKS(kBounceDetachMs));
  tud_connect();
}

// usbd_defer_func() shim so any task can ask for a bounce: the disconnect must
// happen in the TinyUSB task, never from loop().
void recover_cb(void *) { recover_link(); }

// Runs in the TinyUSB task. Drains as much of the ring as the driver will take.
void pump_step(void *) {
  for (;;) {
    if (!tud_ready()) {
      g_pending = 0;
      g_stall_run = 0;
      break;
    }

    if (!g_pending) {
      portENTER_CRITICAL(&g_lock);
      if (g_used) {
        uint8_t hdr[2];
        hdr[0] = g_ring[g_head];
        hdr[1] = g_ring[(g_head + 1) % g_cap];
        ring_skip(2);
        const uint16_t len = (uint16_t)hdr[0] | ((uint16_t)hdr[1] << 8);
        ring_copy_out(g_staging, len);
        g_used -= 2 + len;
        g_pending = len;
      }
      portEXIT_CRITICAL(&g_lock);
    }
    if (!g_pending) {
      g_stall_run = 0;
      break;
    }

    if (!tud_network_can_xmit(g_pending)) {
      portENTER_CRITICAL(&g_lock);
      g_stats.stalls++;
      g_tx_blocked = true;
      portEXIT_CRITICAL(&g_lock);
      // Refusal is the one host failure the device CAN see, and measuring it
      // settled a long-running question. In the real failure the host refuses
      // every frame forever: stalls pinned at ~1130/s, tx=0, the ring at
      // high-water dropping everything, tud_ready() still up. With no receiver
      // running the host does the opposite -- it accepts every frame and
      // discards it (measured over 60 s: stall=0, tx=168p/s, drop=0). So a
      // sustained stall run means the link, never merely an idle host, and
      // bouncing on it is safe. Verified: this exact condition, cured by one
      // bounce, stalls 1130/s -> 0 with TX resuming immediately.
      //
      // (The host's own adapter may still read Disconnected afterwards -- that
      // half is invisible from here and belongs to desktop/rx.ts + nic-restart.)
      if (++g_stall_run >= kStallRunLimit) {
        recover_link();
      }
      break; // the armer kicks us again
    }

    tud_network_xmit(g_staging, g_pending);
    portENTER_CRITICAL(&g_lock);
    g_stats.tx_pkts++;
    g_stats.tx_bytes += g_pending;
    g_tx_blocked = false;
    portEXIT_CRITICAL(&g_lock);
    g_pending = 0;
    g_stall_run = 0;
  }

  portENTER_CRITICAL(&g_lock);
  g_armed = false;
  portEXIT_CRITICAL(&g_lock);
}

// Callable from any task. Schedules at most one step at a time, so a fast
// producer can never flood the device event queue.
void arm_step() {
  bool post = false;
  portENTER_CRITICAL(&g_lock);
  if (!g_armed) {
    g_armed = true;
    post = true;
  }
  portEXIT_CRITICAL(&g_lock);
  if (post) {
    usbd_defer_func(pump_step, nullptr, false);
  }
}

// The only job left for a task of our own: guarantee a step still gets
// scheduled when the producer has gone quiet with a frame stuck behind a busy
// NTB pool. It deliberately touches no TinyUSB state.
void armer_task(void *) {
  for (;;) {
    bool work;
    portENTER_CRITICAL(&g_lock);
    work = (g_used != 0) || g_tx_blocked;
    portEXIT_CRITICAL(&g_lock);
    if (work) {
      arm_step();
    }
    vTaskDelay(1);
  }
}

} // namespace

// ---- TinyUSB application callbacks -----------------------------------------

uint16_t tud_network_xmit_cb(uint8_t *dst, void *ref, uint16_t arg) {
  memcpy(dst, ref, arg);
  return arg;
}

bool tud_network_recv_cb(const uint8_t *src, uint16_t size) {
  // The only liveness signal we get. A dead Windows datapath sends nothing, so
  // this counter freezing while tx_pkts climbs is the failure's signature.
  portENTER_CRITICAL(&g_lock);
  g_stats.rx_pkts++;
  portEXIT_CRITICAL(&g_lock);
  if (g_sink) {
    g_sink(src, size);
  }
  // Safe from inside the callback: the NCM driver guards re-entry explicitly
  // and re-runs the transfer loop afterwards.
  tud_network_recv_renew();
  return true;
}

// Required by net_device.h so netd_init() links, but the NCM driver never
// actually calls it -- verified: a full tud_disconnect()/tud_connect() cycle,
// which the host observes as a replug, leaves this untouched. So it cannot be
// used to detect a host-side datapath teardown; see link_up() in ncm.h.
void tud_network_init_cb(void) {
  portENTER_CRITICAL(&g_lock);
  g_head = g_tail = g_used = 0;
  g_tx_blocked = false;
  portEXIT_CRITICAL(&g_lock);
  g_pending = 0;
  g_stall_run = 0;
}

// ---- Public API ------------------------------------------------------------

namespace ncm {

bool begin(size_t ring_bytes) {
  if (!g_registered) {
    return false;
  }

  g_ring = (uint8_t *)heap_caps_malloc(ring_bytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  if (!g_ring) {
    return false;
  }
  g_cap = ring_bytes;

  // Idempotent: with ARDUINO_USB_CDC_ON_BOOT this already ran in app_main(),
  // and ESPUSB::begin() short-circuits on its _started flag.
  if (!USB.begin()) {
    return false;
  }

  // Priority above the Arduino loop so a busy sketch cannot starve the data
  // plane; core 1 keeps it off the Wi-Fi driver's core. All it ever does is
  // post to the USB event queue, so it needs very little stack.
  return xTaskCreatePinnedToCore(armer_task, "ncm_arm", 2048, nullptr, 5, &g_armer, 1) == pdPASS;
}

bool registered() { return g_registered; }

bool link_up() { return tud_ready(); }

void recover() { usbd_defer_func(recover_cb, nullptr, false); }

bool queue(const uint8_t *frame, uint16_t len) {
  if (!len || len > CFG_TUD_NET_MTU) {
    g_stats.drop_big++;
    return false;
  }
  const size_t need = 2u + len;
  if (need > g_cap) {
    g_stats.drop_big++;
    return false;
  }

  portENTER_CRITICAL(&g_lock);
  while (g_cap - g_used < need) {
    drop_oldest();
  }
  const uint8_t hdr[2] = {(uint8_t)(len & 0xFF), (uint8_t)(len >> 8)};
  ring_write(hdr, 2);
  ring_write(frame, len);
  g_used += need;
  if (g_used > g_stats.hiwater) {
    g_stats.hiwater = (uint32_t)g_used;
  }
  g_stats.q_pkts++;
  g_stats.q_bytes += len;
  portEXIT_CRITICAL(&g_lock);

  if (g_armer) { // still false before begin(): USB is not running yet
    arm_step();
  }
  return true;
}

void on_host_frame(HostSink sink) { g_sink = sink; }

const uint8_t *host_mac() { return tud_network_mac_address; }
const uint8_t *device_mac() { return g_dev_mac; }

void snapshot(Stats &out) {
  portENTER_CRITICAL(&g_lock);
  out = g_stats;
  g_stats.hiwater = (uint32_t)g_used;
  portEXIT_CRITICAL(&g_lock);
}

void reset_stats() {
  portENTER_CRITICAL(&g_lock);
  memset(&g_stats, 0, sizeof(g_stats));
  portEXIT_CRITICAL(&g_lock);
}

} // namespace ncm
