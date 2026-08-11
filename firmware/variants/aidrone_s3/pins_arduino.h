#ifndef Pins_Arduino_h
#define Pins_Arduino_h

#include <stdint.h>
#include "soc/soc_caps.h"

// ---------------------------------------------------------------------------
// Verbatim copy of framework-arduinoespressif32/variants/esp32s3/pins_arduino.h
// with ONE change: USB_PID.
//
// Why this file exists at all. The stock header defines USB_PID *unguarded*,
// and USB.cpp includes it before its own `#ifndef USB_PID` fallback -- so a
// -DUSB_PID=... build flag is silently overridden by the header. USB.begin()
// also runs from app_main() before setup(), so a runtime USB.PID() call is too
// late. Overriding the variant is the only deterministic hook.
//
// Why we care. Zadig/libwdi installs (usb_jtag_debug_unit.inf, shipped to
// anyone who has ever set up OpenOCD JTAG on an ESP32-S3) bind WinUSB to the
// *hardware* id `USB\VID_303A&PID_1001&MI_02`. Our CDC-NCM function lands on
// interface 2, and a hardware-id match outranks the compatible-id match
// (`USB\Class_02&SubClass_0d&Prot_00`) that Microsoft's in-box usbncm.inf uses.
// Result: WinUSB claims the NIC and no Ethernet adapter is ever created.
// Changing the PID takes us out of that INF's reach on every machine, instead
// of requiring `pnputil /delete-driver` (admin, machine-global, breaks JTAG).
//
// 0x8AD1 is a locally chosen, unregistered prototype PID. The only requirement
// is that it is not 0x1001.
// ---------------------------------------------------------------------------
#define USB_VID 0x303a
#define USB_PID 0x8AD1

// Some boards have too low voltage on this pin (board design bug)
// Use different pin with 3V and connect with 48
// and change this setup for the chosen pin (for example 38)
#define PIN_RGB_LED 48
// BUILTIN_LED can be used in new Arduino API digitalWrite() like in Blink.ino
static const uint8_t LED_BUILTIN = SOC_GPIO_PIN_COUNT + PIN_RGB_LED;
#define BUILTIN_LED LED_BUILTIN  // backward compatibility
#define LED_BUILTIN LED_BUILTIN  // allow testing #ifdef LED_BUILTIN
// RGB_BUILTIN and RGB_BRIGHTNESS can be used in new Arduino API rgbLedWrite()
#define RGB_BUILTIN    LED_BUILTIN
#define RGB_BRIGHTNESS 64

static const uint8_t TX = 43;
static const uint8_t RX = 44;

static const uint8_t SDA = 8;
static const uint8_t SCL = 9;

static const uint8_t SS = 10;
static const uint8_t MOSI = 11;
static const uint8_t MISO = 13;
static const uint8_t SCK = 12;

static const uint8_t A0 = 1;
static const uint8_t A1 = 2;
static const uint8_t A2 = 3;
static const uint8_t A3 = 4;
static const uint8_t A4 = 5;
static const uint8_t A5 = 6;
static const uint8_t A6 = 7;
static const uint8_t A7 = 8;
static const uint8_t A8 = 9;
static const uint8_t A9 = 10;
static const uint8_t A10 = 11;
static const uint8_t A11 = 12;
static const uint8_t A12 = 13;
static const uint8_t A13 = 14;
static const uint8_t A14 = 15;
static const uint8_t A15 = 16;
static const uint8_t A16 = 17;
static const uint8_t A17 = 18;
static const uint8_t A18 = 19;
static const uint8_t A19 = 20;

static const uint8_t T1 = 1;
static const uint8_t T2 = 2;
static const uint8_t T3 = 3;
static const uint8_t T4 = 4;
static const uint8_t T5 = 5;
static const uint8_t T6 = 6;
static const uint8_t T7 = 7;
static const uint8_t T8 = 8;
static const uint8_t T9 = 9;
static const uint8_t T10 = 10;
static const uint8_t T11 = 11;
static const uint8_t T12 = 12;
static const uint8_t T13 = 13;
static const uint8_t T14 = 14;

#endif /* Pins_Arduino_h */
