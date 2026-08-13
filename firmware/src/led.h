#pragma once
namespace led {
void begin();
// Green once the drone is linked, red while it is not. Only a state change
// touches the LED, so this is safe to call every loop() iteration.
void update(bool linked);
}
