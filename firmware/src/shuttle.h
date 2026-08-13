#pragma once

#include <Arduino.h>

namespace shuttle {

/// Starts the Soft-AP, claims its pre-lwIP receive callback, and binds the
/// ESP32-side Tello command socket to UDP/8889.
bool begin();

/// Sends host-originated USB bulk command records to the leased Tello, and -
/// when no host is driving - keeps the drone in SDK mode by itself.
void poll();

bool tello_connected();

/// True when the drone is not merely associated but answering: a leased station
/// plus command-reply or state traffic seen in the last couple of seconds. This
/// is what the status LED reports, because an associated drone that never
/// entered SDK mode is not a usable link.
bool linked();

IPAddress tello_ip();

} // namespace shuttle
