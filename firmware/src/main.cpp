#include <Arduino.h>
#include <USB.h>
#include <USBCDC.h>
#include <tusb.h>
#include "bench.h"
#include "led.h"
#include "bulk.h"
#include "shuttle.h"
// CDC-on-boot is disabled; provide the explicitly registered CDC function.
USBCDC USBSerial(0);
class TeeConsole:public Print{public:TeeConsole(HardwareSerial&u,USBCDC&c):uart(u),cdc(c){}size_t write(uint8_t b)override{size_t n=uart.write(b);cdc.write(b);return n;}size_t write(const uint8_t*b,size_t n)override{size_t r=uart.write(b,n);cdc.write(b,n);return r;}private:HardwareSerial&uart;USBCDC&cdc;};
TeeConsole Console(Serial0,USBSerial);uint32_t report_at=0;
namespace {
// Arduino-ESP32 3.1.1 changes the device class to CDC when CDC and WebUSB are
// both enabled. Keep the composite/IAD device class so Windows exposes the
// vendor function as a WinUSB child; the core still serves its BOS/MS OS 2.0
// descriptors for interface 0.
constexpr uint8_t kCompositeDeviceDescriptor[] = {
    0x12, 0x01, 0x10, 0x02, 0xEF, 0x02, 0x01, 0x40,
    0x3A, 0x30, 0xD2, 0x8A, 0x01, 0x01, 0x01, 0x02,
    0x03, 0x01,
};
} // namespace

extern "C" uint8_t const* tud_descriptor_device_cb(void) {
  return kCompositeDeviceDescriptor;
}

// `USB.webUSB(true)` is not about WebUSB: the Arduino core gates its MS OS 2.0
// descriptor-set reply on that one flag (esp32-hal-tinyusb.c, tud_vendor_control_xfer_cb),
// and that reply is what makes Windows bind WinUSB to the vendor interface
// instead of leaving it driverless. The same flag also answers the landing-page
// request, which is why Chrome pops "go to docs.espressif.com to connect" every
// time the board is plugged in. The core's BOS descriptor is static and its
// tud_descriptor_bos_cb is a strong symbol, so the WebUSB capability cannot be
// dropped from our side - but the URL behind it can be emptied, and an empty
// landing page is not a page Chrome can offer. MS OS 2.0 is untouched.
static void suppressWebUsbLandingPage() {
  USB.webUSB(true);
  USB.webUSBURL("");
}

void setup(){Serial0.begin(115200);suppressWebUsbLandingPage();USB.usbClass(TUSB_CLASS_MISC);USB.usbSubClass(MISC_SUBCLASS_COMMON);USB.usbProtocol(MISC_PROTOCOL_IAD);USB.firmwareVersion(0x0101);USB.begin();USBSerial.begin(115200);Console.println(F("[boot] AIdrone USB bulk bridge"));Console.printf("[usb] vendor mounted=%u rx=%lu tx=%lu\n",tud_vendor_n_mounted(0),(unsigned long)tud_vendor_n_available(0),(unsigned long)tud_vendor_n_write_available(0));led::begin();shuttle::begin();}
void loop(){shuttle::poll();bench::tick();bulk::pump_usb_tx();const bool linked=shuttle::linked();led::update(linked);uint32_t now=millis();if((int32_t)(now-report_at)>=0){report_at=now+1000;auto s=bulk::stats();Console.printf("[bulk] mount=%u link=%s tello=%s host=%lu/%lu device=%lu/%lu frame=%lu\n",tud_vendor_n_mounted(0),linked?"green":"red",shuttle::tello_connected()?shuttle::tello_ip().toString().c_str():"waiting",(unsigned long)s.host_records,(unsigned long)s.host_dropped,(unsigned long)s.device_records,(unsigned long)s.device_dropped,(unsigned long)s.framing_errors);}yield();}
