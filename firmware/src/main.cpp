// =============================================================================
// AIdrone - ESP32-S3 USB-NCM bridge, measurement build
//
//   Tello --(Wi-Fi, deployment soft-AP)--> ESP32-S3 --(USB-C, CDC-NCM)--> laptop
//
// The laptop sees a plain Ethernet NIC and receives the Tello's UDP video as
// UDP. No cloud hop, no WebSocket, no TCP head-of-line blocking, no lwIP
// mailbox on the forwarding path, and no command relay that can freeze the
// video for seconds at a time.
//
// This build exists to MEASURE that claim before the desktop app is written.
// Two modes share one transmit path:
//
//   bench   synthetic UDP blast at a chosen rate -> isolates the USB link.
//           Needs no drone, no DHCP, no host configuration.
//   bridge  the real soft-AP + L2 shuttle -> end-to-end with the Tello.
//
// The AP is always up with the credentials the Tello is already provisioned
// for, so it associates on power-up with no re-provisioning.
//
// The console is TEE'd to both USB CDC and UART0 (the DevKitC's CH343 port).
// That matters during bring-up: if the native USB link is unplugged or fails
// to enumerate, the one thing you need to read is the log explaining why.
//
// Console:
//   b [kbps] [payload]  start the bench      (default 2000 kbps, 1450 B)
//   s                   stop the bench
//   w on|off            attach/detach the Wi-Fi shuttle's USB leg
//   r                   reset counters
//   i                   info
//   h                   help
// =============================================================================

#include <Arduino.h>
#include <WiFi.h>

#include "bench.h"
#include "config.h"
#include "ncm.h"
#include "shuttle.h"

namespace {

constexpr uint32_t kReportMs = 1000;

// Print to both links, accept input from whichever one has it. USB CDC writes
// are non-blocking (tx timeout 0), so an unplugged cable cannot stall UART0.
class TeeConsole : public Print {
 public:
  void begin() {
    Serial0.begin(115200);
    Serial.begin(115200);
    Serial.setTxTimeoutMs(0);
  }
  size_t write(uint8_t c) override {
    Serial0.write(c);
    return Serial.write(c);
  }
  size_t write(const uint8_t *b, size_t n) override {
    Serial0.write(b, n);
    return Serial.write(b, n);
  }
  int available() { return Serial.available() + Serial0.available(); }
  int read() { return Serial.available() ? Serial.read() : Serial0.read(); }
};

TeeConsole con;

char g_line[64];
uint8_t g_line_len = 0;

uint32_t g_last_report = 0;
ncm::Stats g_prev_ncm;
shuttle::Stats g_prev_shuttle;

// ---- status LED -------------------------------------------------------------
// The board's single WS2812 on GPIO48 (see variants/aidrone_s3/pins_arduino.h).
//
// It reports the DRONE's half of the path and nothing else: green once the Tello
// is associated with the soft-AP AND holds a lease, red until then. The host has
// a whole screen for the USB half; this LED is the only thing an operator can
// read while looking at the aircraft instead of the laptop.
//
// `tello_ip()` rather than `clients()` on purpose. An associated station that
// has not been given an address yet cannot be talked to, so calling that green
// would be a claim the bridge cannot back. The gap is one DHCP exchange wide.
constexpr uint8_t kLedLevel = 40; // of 255; the onboard WS2812 is painful at full

void update_led() {
  const bool linked = shuttle::tello_ip() != 0;
  // Write only on change: rgbLedWrite() bit-bangs the WS2812 with interrupts
  // masked, and loop() runs every 5 ms. Repainting an unchanged colour 200 times
  // a second would be 200 needless critical sections on the core the shuttle
  // shares.
  static int8_t painted = -1;
  if (painted == (int8_t)linked) {
    return;
  }
  painted = (int8_t)linked;
  rgbLedWrite(RGB_BUILTIN, linked ? 0 : kLedLevel, linked ? kLedLevel : 0, 0);
}

String mac_str(const uint8_t *m) {
  char buf[18];
  snprintf(buf, sizeof(buf), "%02X:%02X:%02X:%02X:%02X:%02X", m[0], m[1], m[2], m[3], m[4], m[5]);
  return String(buf);
}

// bytes over an interval -> "x.xxMb/s"
String rate(uint32_t bytes, uint32_t ms) {
  if (!ms) {
    return String("0.00Mb/s");
  }
  const double mbps = (double)bytes * 8.0 / (double)ms / 1000.0;
  char buf[16];
  snprintf(buf, sizeof(buf), "%.2fMb/s", mbps);
  return String(buf);
}

void print_help() {
  con.println(F("commands:"));
  con.println(F("  b [kbps] [payload]  start bench (default 2000 1450)"));
  con.println(F("  s                   stop bench"));
  con.println(F("  w on|off            wifi shuttle USB leg"));
  con.println(F("  r                   reset counters"));
  con.println(F("  i                   info"));
  con.println(F("  x                   detach USB 12 s - revives a dead host NIC"));
  con.println(F("  h                   help"));
}

void print_info() {
  con.println(F("---- info ----"));
  con.printf("ncm iface  : %s\n", ncm::registered() ? "registered" : "NOT REGISTERED");
  // "up" only means USB is configured; the host datapath can still be dead.
  con.printf("usb link   : %s\n", ncm::link_up() ? "up" : "down (host not enumerated / cable in UART port only)");
  con.printf("host nic   : %s\n", mac_str(ncm::host_mac()).c_str());
  con.printf("device nic : %s\n", mac_str(ncm::device_mac()).c_str());
  con.printf("soft-AP    : %s ch%d  ip %s\n", AP_SSID, AP_CHANNEL, WiFi.softAPIP().toString().c_str());
  con.printf("clients    : %u\n", shuttle::clients());
  const uint32_t ip = shuttle::tello_ip();
  con.printf("tello lease: %s\n", ip ? IPAddress(ip).toString().c_str() : "(none yet)");
  // Printed beside the lease it is derived from, so a green LED with no lease
  // would be visible as the contradiction it is.
  con.printf("status led : %s\n", ip ? "green (drone linked)" : "red (no drone)");
  con.printf("shuttle    : %s\n", shuttle::enabled() ? "on" : "off");
  con.printf("bench      : %s", bench::running() ? "running" : "stopped");
  if (bench::running()) {
    con.printf("  %lukbps payload=%u frame=%u", (unsigned long)bench::kbps(), bench::payload(), bench::frame_bytes());
  }
  con.println();
  con.printf("ring       : %u bytes internal SRAM\n", (unsigned)NCM_RING_BYTES);
  con.printf("free heap  : %u internal / %u total\n", (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getHeapSize());
  con.println(F("--------------"));
}

void handle_line(char *line) {
  while (*line == ' ') {
    line++;
  }
  if (!*line) {
    return;
  }

  switch (line[0]) {
    case 'b': {
      uint32_t kbps = 2000;
      uint16_t payload = BENCH_PAYLOAD;
      const char *arg = strchr(line, ' ');
      if (arg) {
        char *end = nullptr;
        const unsigned long v = strtoul(arg, &end, 10);
        if (v) {
          kbps = (uint32_t)v;
        }
        if (end) {
          const unsigned long p = strtoul(end, nullptr, 10);
          if (p) {
            payload = (uint16_t)p;
          }
        }
      }
      bench::start(kbps, payload);
      con.printf("[bench] %lukbps payload=%u frame=%u interval=%luus\n", (unsigned long)bench::kbps(),
                 bench::payload(), bench::frame_bytes(),
                 (unsigned long)((uint64_t)bench::frame_bytes() * 8000ull / bench::kbps()));
      break;
    }
    case 's':
      bench::stop();
      con.println(F("[bench] stopped"));
      break;
    case 'w': {
      const bool on = strstr(line, "off") == nullptr;
      shuttle::set_enabled(on);
      con.printf("[shuttle] %s\n", on ? "on" : "off");
      break;
    }
    case 'r':
      ncm::reset_stats();
      shuttle::reset_stats();
      ncm::snapshot(g_prev_ncm);
      shuttle::snapshot(g_prev_shuttle);
      con.println(F("[stats] reset"));
      break;
    case 'i':
      print_info();
      break;
    case 'x':
      // The host NCM datapath dies while link_up() still says "up". Measured
      // remedies, in the order they were tried and what each did:
      //   50 ms USB bounce       - no (device re-enumerates, adapter stays dead)
      //   ESP.restart()          - no (same: PnP reports the NCM function OK)
      //   Restart-NetAdapter     - no (even against a freshly restarted device)
      //   3 s USB bounce         - no (re-confirmed against a live wedge: the
      //                            device read usb=up, stall=0 the whole time)
      //   reflash (~12 s in ROM) - yes, every time
      // Long absence is the only variable that tracks the cure, so the detach
      // now matches the reflash's ~12 s rather than merely beating a debounce;
      // see kBounceDetachMs in ncm.cpp. The CDC console survives the wedge,
      // which is what makes this reachable at all: the host detects the silence
      // and can ask for the cure.
      con.println(F("[ncm] detaching USB for 12 s to force the host to rebuild the NIC"));
      con.flush();
      ncm::recover();
      break;
    default:
      print_help();
      break;
  }
}

void poll_console() {
  while (con.available()) {
    const int c = con.read();
    if (c < 0) {
      break;
    }
    if (c == '\r' || c == '\n') {
      if (g_line_len) {
        g_line[g_line_len] = '\0';
        handle_line(g_line);
        g_line_len = 0;
      }
    } else if (g_line_len < sizeof(g_line) - 1) {
      g_line[g_line_len++] = (char)c;
    }
  }
}

// One line per second. The two numbers that decide the whole design:
//   ring drop  - frames the ESP32 itself threw away (its own fault)
//   usb tx     - what actually crossed the cable; compare against the
//                receiver's count to get the USB link's own loss.
void report() {
  const uint32_t now = millis();
  const uint32_t dt = now - g_last_report;
  if (dt < kReportMs) {
    return;
  }
  g_last_report = now;

  ncm::Stats n;
  shuttle::Stats s;
  ncm::snapshot(n);
  shuttle::snapshot(s);

  const uint32_t tx_pkts = n.tx_pkts - g_prev_ncm.tx_pkts;
  const uint32_t tx_bytes = n.tx_bytes - g_prev_ncm.tx_bytes;
  const uint32_t q_pkts = n.q_pkts - g_prev_ncm.q_pkts;
  const uint32_t drops = n.drop_full - g_prev_ncm.drop_full;
  const uint32_t big = n.drop_big - g_prev_ncm.drop_big;
  const uint32_t stalls = n.stalls - g_prev_ncm.stalls;
  const uint32_t recov = n.recoveries - g_prev_ncm.recoveries;
  const uint32_t rx_pkts = n.rx_pkts - g_prev_ncm.rx_pkts;
  const uint32_t rx_host = s.rx_host - g_prev_shuttle.rx_host;
  const uint32_t rx_group = s.rx_group - g_prev_shuttle.rx_group;
  const uint32_t rx_self = s.rx_self - g_prev_shuttle.rx_self;
  const uint32_t tx_wifi = s.tx_wifi - g_prev_shuttle.tx_wifi;
  const uint32_t tx_wifi_err = s.tx_wifi_err - g_prev_shuttle.tx_wifi_err;

  g_prev_ncm = n;
  g_prev_shuttle = s;

  con.printf("[%6lus] usb=%s ap=%u", (unsigned long)(now / 1000), ncm::link_up() ? "up  " : "down",
             shuttle::clients());
  con.printf(" | wifi rx host=%lu grp=%lu self=%lu tx=%lu err=%lu", (unsigned long)rx_host, (unsigned long)rx_group,
             (unsigned long)rx_self, (unsigned long)tx_wifi, (unsigned long)tx_wifi_err);
  con.printf(" | ring q=%lu hi=%.1fk drop=%lu/%lu", (unsigned long)q_pkts, n.hiwater / 1024.0, (unsigned long)drops,
             (unsigned long)big);
  // recov prints delta/total: a bounce takes the USB link down, so the very line
  // that reports it is the one most likely to be lost. The running total is what
  // survives, and it is the only way to tell "bounced once" from "bouncing".
  con.printf(" | usb tx=%lup %s rx=%lu stall=%lu recov=%lu/%lu\n", (unsigned long)tx_pkts,
             rate(tx_bytes, dt).c_str(), (unsigned long)rx_pkts, (unsigned long)stalls, (unsigned long)recov,
             (unsigned long)n.recoveries);

  // No dead-datapath watchdog here, and that is a decision, not an omission. The
  // failure it would treat -- the Windows NCM adapter going Disconnected while
  // tud_ready() still reports up -- is invisible from this side: measured, the
  // host keeps ACCEPTING frames at full rate (stall stays 0) and simply drops
  // them, so the only candidate signal is "no host frames arriving". That signal
  // cannot be trusted: with no receiver running the host is legitimately quiet,
  // and Windows on its own emits ARP/mDNS bursts that hold a 3 s streak, so
  // neither silence nor traffic distinguishes a dead datapath from an idle one.
  //
  // Built anyway, it bounced USB every few seconds -- audible as a
  // disconnect/connect chime -- while curing nothing. Detection belongs to the
  // receiver (desktop/rx.ts knows whether frames arrive); the cure stays here,
  // reachable via the `x` console command and ncm::recover().
}

} // namespace

void setup() {
  con.begin();
  con.println();
  con.println(F("=== AIdrone ESP32-S3 USB-NCM measurement build ==="));
  con.printf("[boot] ncm interface %s at static init\n", ncm::registered() ? "registered" : "FAILED to register");

  if (!ncm::begin(NCM_RING_BYTES)) {
    for (;;) {
      con.println(F("[fatal] ncm::begin failed - no ring, or USB refused to start"));
      delay(2000);
    }
  }

  if (!bench::begin()) {
    con.println(F("[warn] bench task not created"));
  }
  if (!shuttle::begin()) {
    con.println(F("[warn] soft-AP / shuttle not started"));
  }

  delay(1500); // let the host enumerate before the banner scrolls past

  print_info();
  print_help();
  con.println();

  // Red before the first loop() rather than dark: an unlit LED and a dead board
  // look identical, and the whole point of this thing is to be readable from
  // across the room with the laptop closed.
  update_led();

  g_last_report = millis();
  ncm::snapshot(g_prev_ncm);
  shuttle::snapshot(g_prev_shuttle);
}

void loop() {
  poll_console();
  report();
  update_led();
  delay(5);
}
