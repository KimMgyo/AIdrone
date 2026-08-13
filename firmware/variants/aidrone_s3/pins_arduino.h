#ifndef Pins_Arduino_h
#define Pins_Arduino_h
#include <stdint.h>
#include "soc/soc_caps.h"
#define USB_VID 0x303A
#define USB_PID 0x8AD2
#define PIN_RGB_LED 48
static const uint8_t LED_BUILTIN = SOC_GPIO_PIN_COUNT + PIN_RGB_LED;
#define BUILTIN_LED LED_BUILTIN
#define LED_BUILTIN LED_BUILTIN
#define RGB_BUILTIN LED_BUILTIN
#define RGB_BRIGHTNESS 64
static const uint8_t TX=43,RX=44,SDA=8,SCL=9,SS=10,MOSI=11,MISO=13,SCK=12;
static const uint8_t A0=1,A1=2,A2=3,A3=4,A4=5,A5=6,A6=7,A7=8,A8=9,A9=10,A10=11,A11=12,A12=13,A13=14,A14=15,A15=16,A16=17,A17=18,A18=19,A19=20;
static const uint8_t T1=1,T2=2,T3=3,T4=4,T5=5,T6=6,T7=7,T8=8,T9=9,T10=10,T11=11,T12=12,T13=13,T14=14;
#endif
