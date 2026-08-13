#include "bench.h"
#include "bulk.h"
#include "config.h"
#include <Arduino.h>
namespace bench {
void tick() {
#if BENCH_INTERVAL_MS > 0
  static uint32_t at=0,seq=0;
  uint32_t now=millis();
  if((int32_t)(now-at)<0)return;
  at=now+BENCH_INTERVAL_MS;
  uint8_t p[8]={(uint8_t)seq,(uint8_t)(seq>>8),(uint8_t)(seq>>16),(uint8_t)(seq>>24),(uint8_t)now,(uint8_t)(now>>8),(uint8_t)(now>>16),(uint8_t)(now>>24)};
  ++seq;
  bulk::publish(9999,p,sizeof(p));
#endif
}
}
