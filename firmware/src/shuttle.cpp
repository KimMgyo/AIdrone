#include "shuttle.h"

#include <Arduino.h>
#include <WiFi.h>
#include <string.h>

#include "config.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "esp_private/wifi.h"
#include "ncm.h"

namespace {

esp_netif_t *g_ap_netif = nullptr;
uint8_t g_ap_mac[6] = {0};
volatile bool g_enabled = true;
volatile uint32_t g_tello_ip = 0;
shuttle::Stats g_stats;
portMUX_TYPE g_lock = portMUX_INITIALIZER_UNLOCKED;

// Runs in the Wi-Fi driver's RX task. It MUST NOT block: ncm::queue() copies
// into a ring and returns, and esp_wifi_internal_tx()/esp_netif_receive() are
// the only other calls. Anything that waited on USB readiness here would stall
// the radio.
esp_err_t ap_rx(void *buffer, uint16_t len, void *eb) {
  const uint8_t *frame = (const uint8_t *)buffer;

  if (len < 14) {
    portENTER_CRITICAL(&g_lock);
    g_stats.rx_runt++;
    portEXIT_CRITICAL(&g_lock);
    esp_wifi_internal_free_rx_buffer(eb);
    return ESP_OK;
  }

  const bool group = (frame[0] & 0x01) != 0;
  const bool to_self = memcmp(frame, g_ap_mac, 6) == 0;

  if (group) {
    portENTER_CRITICAL(&g_lock);
    g_stats.rx_group++;
    portEXIT_CRITICAL(&g_lock);
    if (g_enabled) {
      ncm::queue(frame, len);
    }
    // esp_netif_receive takes ownership of eb.
    return esp_netif_receive(g_ap_netif, buffer, len, eb);
  }

  if (to_self) {
    portENTER_CRITICAL(&g_lock);
    g_stats.rx_self++;
    portEXIT_CRITICAL(&g_lock);
    return esp_netif_receive(g_ap_netif, buffer, len, eb);
  }

  portENTER_CRITICAL(&g_lock);
  g_stats.rx_host++;
  g_stats.rx_host_bytes += len;
  portEXIT_CRITICAL(&g_lock);
  if (g_enabled) {
    ncm::queue(frame, len);
  }
  esp_wifi_internal_free_rx_buffer(eb);
  return ESP_OK;
}

// Host -> Wi-Fi. esp_wifi_internal_tx() copies the buffer, so `frame` needs no
// lifetime beyond this call.
void from_host(const uint8_t *frame, uint16_t len) {
  if (!g_enabled || len < 14) {
    return;
  }
  const esp_err_t err = esp_wifi_internal_tx(WIFI_IF_AP, (void *)frame, len);
  portENTER_CRITICAL(&g_lock);
  if (err == ESP_OK) {
    g_stats.tx_wifi++;
  } else {
    g_stats.tx_wifi_err++;
  }
  portEXIT_CRITICAL(&g_lock);
}

void hook_rxcb() {
  esp_wifi_get_mac(WIFI_IF_AP, g_ap_mac);
  g_ap_netif = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
  if (g_ap_netif) {
    esp_wifi_internal_reg_rxcb(WIFI_IF_AP, ap_rx);
  }
}

void on_wifi_event(WiFiEvent_t event, WiFiEventInfo_t info) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_AP_START:
      // esp_netif reinstalls its own RX callback whenever the interface comes
      // up, so we must take it back every time.
      hook_rxcb();
      break;
    case ARDUINO_EVENT_WIFI_AP_STAIPASSIGNED:
      g_tello_ip = info.wifi_ap_staipassigned.ip.addr;
      break;
    default:
      break;
  }
}

} // namespace

namespace shuttle {

bool begin() {
  ncm::on_host_frame(from_host);

  WiFi.onEvent(on_wifi_event);
  WiFi.mode(WIFI_AP);
  if (!WiFi.softAP(AP_SSID, AP_PASS, AP_CHANNEL)) {
    return false;
  }
  hook_rxcb();
  return g_ap_netif != nullptr;
}

void set_enabled(bool on) { g_enabled = on; }
bool enabled() { return g_enabled; }

uint8_t clients() { return WiFi.softAPgetStationNum(); }
uint32_t tello_ip() { return g_tello_ip; }

void snapshot(Stats &out) {
  portENTER_CRITICAL(&g_lock);
  out = g_stats;
  portEXIT_CRITICAL(&g_lock);
}

void reset_stats() {
  portENTER_CRITICAL(&g_lock);
  memset(&g_stats, 0, sizeof(g_stats));
  portEXIT_CRITICAL(&g_lock);
}

} // namespace shuttle
