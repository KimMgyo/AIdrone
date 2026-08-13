#include "led.h"
#include <Arduino.h>
namespace led {
namespace {
// The WS2812 on PIN_RGB_LED is the only status surface a headless bridge has,
// so it is driven bright enough to read across a room but not so bright it
// blows out a camera pointed at the board.
constexpr uint8_t kLevel = 40;
// Tri-state: -1 means nothing has been painted yet, so the first update always
// writes whichever colour it decides on rather than trusting a boot default.
int8_t g_shown = -1;
}
void begin() {
  g_shown = -1;
  update(false);
}
void update(bool linked) {
  const int8_t next = linked ? 1 : 0;
  if (next == g_shown) return;
  g_shown = next;
  rgbLedWrite(PIN_RGB_LED, linked ? 0 : kLevel, linked ? kLevel : 0, 0);
}
}
