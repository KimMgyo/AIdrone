#include "shuttle.h"

#include <WiFi.h>
#include <WiFiUdp.h>
#include <string.h>

#include "bulk.h"
#include "config.h"
#include "esp_netif.h"
#include "esp_private/wifi.h"

namespace {

constexpr uint16_t kTelloCommandPort = 8889;
constexpr uint16_t kTelloStatePort = 8890;
constexpr uint16_t kTelloVideoPort = 11111;
constexpr size_t kEthernetHeaderLength = 14;
constexpr size_t kIpv4MinimumHeaderLength = 20;
constexpr size_t kUdpHeaderLength = 8;

/// No reply or state packet for this long and the link is reported down, which
/// is ~20 missed state pushes at the drone's 10 Hz cadence.
constexpr uint32_t kLinkStaleMs = 2000;
/// A host that sent a command more recently than this owns the wire. The Tello
/// protocol carries no request id, so exactly one side may have a reply-bearing
/// command outstanding; the desktop app's own keepalive is 5 s, so this window
/// guarantees the bridge stays silent for as long as an app is alive.
constexpr uint32_t kHostIdleMs = 8000;
/// Probe cadence while the drone is associated but not yet answering.
constexpr uint32_t kLinkProbeMs = 2000;
/// Probe cadence once it answers - also what keeps the drone in SDK mode, whose
/// own idle timeout is 15 s.
constexpr uint32_t kKeepaliveMs = 5000;

WiFiUDP g_command_udp;
esp_netif_t* g_ap_netif = nullptr;
IPAddress g_tello_ip;
bool g_tello_leased = false;
portMUX_TYPE g_lock = portMUX_INITIALIZER_UNLOCKED;
/// Written from the Wi-Fi RX task, read from loop(). Aligned 32-bit, so a torn
/// read is not possible and no lock is warranted on the packet hot path.
volatile uint32_t g_last_tello_rx_ms = 0;
uint32_t g_last_host_command_ms = 0;
uint32_t g_last_probe_ms = 0;
bool g_host_command_seen = false;

uint16_t read_be_u16(const uint8_t* bytes) {
  return (static_cast<uint16_t>(bytes[0]) << 8) | bytes[1];
}

// The Wi-Fi AP RX callback sees packets arriving from the Tello. Its source
// port is not a stable routing key (the video sender may use an ephemeral
// port); the destination identifies the local Tello service to the host.
bool is_tello_ingress_port(uint16_t port) {
  return port == kTelloCommandPort || port == kTelloStatePort || port == kTelloVideoPort;
}

esp_err_t forward_to_lwip(void* buffer, uint16_t length, void* rx_buffer) {
  if (g_ap_netif) {
    // esp_netif_receive() takes ownership of rx_buffer on success.
    return esp_netif_receive(g_ap_netif, buffer, length, rx_buffer);
  }
  esp_wifi_internal_free_rx_buffer(rx_buffer);
  return ESP_OK;
}

/// Returns true when this is a Tello UDP payload that belongs on the USB
/// record stream. It deliberately consumes oversized tracked packets too:
/// letting such a video packet enter lwIP would only recreate the old mailbox
/// bottleneck, while it cannot be represented by the bounded USB protocol.
bool forward_tello_udp(const uint8_t* frame, uint16_t frame_length) {
  if (frame_length < kEthernetHeaderLength + kIpv4MinimumHeaderLength + kUdpHeaderLength ||
      read_be_u16(frame + 12) != 0x0800) {
    return false;
  }

  const uint8_t* ip = frame + kEthernetHeaderLength;
  const size_t ip_header_length = static_cast<size_t>(ip[0] & 0x0f) * 4;
  if ((ip[0] >> 4) != 4 || ip_header_length < kIpv4MinimumHeaderLength ||
      frame_length < kEthernetHeaderLength + ip_header_length + kUdpHeaderLength || ip[9] != 17) {
    return false;
  }

  const size_t ip_total_length = read_be_u16(ip + 2);
  if (ip_total_length < ip_header_length + kUdpHeaderLength ||
      frame_length < kEthernetHeaderLength + ip_total_length) {
    return false;
  }

  const uint8_t* udp = ip + ip_header_length;
  const uint16_t destination_port = read_be_u16(udp + 2);
  const size_t udp_length = read_be_u16(udp + 4);
  if (!is_tello_ingress_port(destination_port) || udp_length < kUdpHeaderLength ||
      udp_length > ip_total_length - ip_header_length) {
    return false;
  }

  const size_t payload_length = udp_length - kUdpHeaderLength;
  if (destination_port != kTelloVideoPort) {
    // Command replies and the 10 Hz state push prove SDK mode is live. Video
    // deliberately does not count: a drone that still believes an old
    // `streamon` is in effect can emit frames while answering nothing.
    g_last_tello_rx_ms = millis();
  }
  // Tag the record with the local destination so the host can route a video
  // datagram even when the Tello uses a transient source port.
  bulk::publish(destination_port, udp + kUdpHeaderLength, static_cast<uint16_t>(payload_length));
  return true;
}

/// Runs in the Wi-Fi driver's RX task. It must never wait on USB: bulk::publish
/// copies into a bounded ring and immediately returns. Packets that do not
/// belong to the Tello UDP stream remain owned by lwIP so DHCP/ARP and the
/// Soft-AP itself continue to work normally.
esp_err_t on_ap_receive(void* buffer, uint16_t length, void* rx_buffer) {
  const auto* frame = static_cast<const uint8_t*>(buffer);
  if (frame && forward_tello_udp(frame, length)) {
    esp_wifi_internal_free_rx_buffer(rx_buffer);
    return ESP_OK;
  }
  return forward_to_lwip(buffer, length, rx_buffer);
}

void install_receive_callback() {
  g_ap_netif = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
  if (g_ap_netif) {
    esp_wifi_internal_reg_rxcb(WIFI_IF_AP, on_ap_receive);
  }
}

void on_wifi_event(WiFiEvent_t event, WiFiEventInfo_t info) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_AP_START:
      // esp_netif reinstalls its own callback whenever the AP comes up.
      install_receive_callback();
      break;
    case ARDUINO_EVENT_WIFI_AP_STAIPASSIGNED:
      portENTER_CRITICAL(&g_lock);
      g_tello_ip = IPAddress(info.wifi_ap_staipassigned.ip.addr);
      g_tello_leased = true;
      portEXIT_CRITICAL(&g_lock);
      break;
    case ARDUINO_EVENT_WIFI_AP_STADISCONNECTED:
      // The AP allows exactly one station: if it disconnects, its lease cannot
      // safely remain a command destination.
      portENTER_CRITICAL(&g_lock);
      g_tello_ip = IPAddress();
      g_tello_leased = false;
      portEXIT_CRITICAL(&g_lock);
      break;
    default:
      break;
  }
}

/// Unicasts one SDK command to the leased station. False means there was no
/// lease to send to, which is not an error - it is the pre-association state.
bool send_to_tello(const uint8_t* payload, size_t length) {
  IPAddress target;
  bool leased;
  portENTER_CRITICAL(&g_lock);
  target = g_tello_ip;
  leased = g_tello_leased;
  portEXIT_CRITICAL(&g_lock);
  if (!leased || !g_command_udp.beginPacket(target, kTelloCommandPort)) {
    return false;
  }
  if (length != 0) {
    g_command_udp.write(payload, length);
  }
  g_command_udp.endPacket();
  return true;
}

bool link_is_live() {
  const uint32_t last = g_last_tello_rx_ms;
  return last != 0 && millis() - last < kLinkStaleMs;
}

/// Brings the drone into SDK mode without a host, and keeps it there.
///
/// The bridge is useful on its own: powering the board and the drone should be
/// enough to get a live link and a green LED, with no desktop app in the loop.
/// It stays out of the way whenever one IS in the loop - see kHostIdleMs for
/// why sharing the reply channel is not an option.
void drive_autonomous_link() {
  bool leased;
  portENTER_CRITICAL(&g_lock);
  leased = g_tello_leased;
  portEXIT_CRITICAL(&g_lock);
  if (!leased) {
    return;
  }
  const uint32_t now = millis();
  if (g_host_command_seen && now - g_last_host_command_ms < kHostIdleMs) {
    return;
  }
  const bool live = link_is_live();
  if (g_last_probe_ms != 0 && now - g_last_probe_ms < (live ? kKeepaliveMs : kLinkProbeMs)) {
    return;
  }
  g_last_probe_ms = now;
  // `command` is what enters SDK mode; once the drone answers, the cheaper
  // `battery?` is enough to hold it there and prove it is still listening.
  const char* probe = live ? "battery?" : "command";
  send_to_tello(reinterpret_cast<const uint8_t*>(probe), strlen(probe));
}

} // namespace

namespace shuttle {

bool begin() {
  WiFi.onEvent(on_wifi_event);
  WiFi.mode(WIFI_AP);
  WiFi.setSleep(false);
  if (!WiFi.softAP(AP_SSID, AP_PASS, AP_CHANNEL, false, 1)) {
    return false;
  }

  install_receive_callback();
  return g_ap_netif != nullptr && g_command_udp.begin(kTelloCommandPort) != 0;
}

void poll() {
  bulk::BulkRecord record;
  while (bulk::take_host_record(record)) {
    if (record.udp_port != kTelloCommandPort) {
      continue;
    }
    // Counted even when there is no lease to send it to: what matters for the
    // silence gate is that a host is driving, not that the drone heard it.
    g_last_host_command_ms = millis();
    g_host_command_seen = true;
    send_to_tello(record.payload, record.payload_len);
  }
  drive_autonomous_link();
}

bool tello_connected() {
  portENTER_CRITICAL(&g_lock);
  const bool connected = g_tello_leased;
  portEXIT_CRITICAL(&g_lock);
  return connected;
}

bool linked() {
  return tello_connected() && link_is_live();
}

IPAddress tello_ip() {
  portENTER_CRITICAL(&g_lock);
  const IPAddress ip = g_tello_ip;
  portEXIT_CRITICAL(&g_lock);
  return ip;
}

} // namespace shuttle
