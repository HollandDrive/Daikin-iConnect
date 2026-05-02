# Daikin iConnect for Homey

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Direct local control for Daikin air conditioners with encrypted C-type WiFi adapters. No cloud required.

## Supported Adapters

- **BRP072C** (e.g., BRP072C42)
- **BRP069C** (e.g., BRP069C4x)

These are the newer encrypted adapters that communicate over HTTPS (port 443). If your Daikin uses the Daikin Onecta/Residential Controller app, this adapter is likely what you have.

## Features

- Mode control (Cool, Heat, Auto, Dry, Fan)
- Target temperature
- Indoor & outdoor temperature readings
- Fan speed (Auto, Silence, 1-5)
- Swing mode (Off, Vertical, Horizontal, 3D)
- Powerful mode
- Economy mode
- Streamer (air purification)
- Configurable polling interval

## Setup

1. Install the app on your Homey
2. Add a device: **+ Add Device > Daikin iConnect > Daikin Aircon**
3. Enter your Daikin's **IP address** and **API key**
4. The device will be added with full control

### Finding Your API Key

The API key is printed on a sticker on the WiFi adapter module inside your indoor unit. It can also be found in Home Assistant if you've previously set up the Daikin integration there.

### Network Requirements

- Your Homey must be on the **same subnet** as the Daikin unit
- The Daikin must have a **static IP** (DHCP is not recommended)
- Port **443** must be accessible between Homey and the Daikin

## Google Home Voice Control

This app uses the `thermostat` device class for Google Home compatibility. The following voice commands work **natively**:

| Command | Example |
|---|---|
| Set mode | "Hey Google, set the Office Aircon to cool" |
| Set mode off | "Hey Google, set the Office Aircon to off" |
| Query temperature | "Hey Google, what is the temperature of the Office Aircon?" |

### Limitations (Homey Self-Hosted)

Due to how Homey's cloud bridge communicates with Google Home, some commands **do not work natively** and require Google Home Routines/Automations as workarounds:

| Command | Issue | Workaround |
|---|---|---|
| "Turn on the Aircon" | Google sends OnOff trait, which Homey's bridge ignores for thermostat devices | Create a Google Home automation that maps "Turn on the [name]" to `ThermostatSetMode: cool` |
| "Turn off the Aircon" | Same OnOff trait issue | Create a Google Home automation that maps "Turn off the [name]" to `ThermostatSetMode: off` |
| "Set temperature to 24" | Temperature EXECUTE commands never reach Homey through the bridge (app slider works fine) | Create a Google Home automation for each temperature value |

### Setting Up Google Home Automations

Create automations using either the **Google Home app** (Automations tab) or the **Script Editor** at [home.google.com](https://home.google.com). **Important:** Due to a Google bug, each voice command must be a separate script — multiple `assistant.event.OkGoogle` starters in one script will only trigger the first one.

**Turn on (sets mode to cool):**

```yaml
metadata:
  name: Office Aircon On
  description: Turn on the office aircon
automations:
  - starters:
      - type: assistant.event.OkGoogle
        eventData: query
        is: "Turn on the office aircon"
    actions:
      - type: device.command.ThermostatSetMode
        devices:
          - Office Aircon - Office
        thermostatMode: cool
```

**Turn off:**

```yaml
metadata:
  name: Office Aircon Off
  description: Turn off the office aircon
automations:
  - starters:
      - type: assistant.event.OkGoogle
        eventData: query
        is: "Turn off the office aircon"
    actions:
      - type: device.command.ThermostatSetMode
        devices:
          - Office Aircon - Office
        thermostatMode: "off"
```

**Set temperature (one script per value):**

```yaml
metadata:
  name: Office Aircon 24
  description: Set the office aircon to 24
automations:
  - starters:
      - type: assistant.event.OkGoogle
        eventData: query
        is: "Set the office aircon to 24"
    actions:
      - type: device.command.ThermostatTemperatureSetpoint
        devices:
          - Office Aircon - Office
        thermostatTemperatureSetpoint: 24C
```

Replace `Office Aircon - Office` with your device's `Device Name - Room` as shown in Google Home.

## How It Works

This app communicates directly with your Daikin's encrypted local API over HTTPS. It uses the same protocol as Home Assistant's Daikin integration (pydaikin), ported to Node.js for Homey.

No cloud services, no external dependencies, no account required.

## Design Notes

The BRP072C is a slow, single-threaded embedded HTTPS server with a 1–2 s commit lag (longer for the first call after idle). Hitting it naively from a Homey app produces several annoying symptoms — modes silently reverting after a write, "Some actions may not have started" from Google Home, AC physically blipping on for ~1 s then turning back off. The app contains four deliberate workarounds for these:

1. **No post-write poll inside capability listeners.** The Homey SDK auto-applies the listener's `value` on success; re-reading the device immediately after a write would race the commit lag and overwrite the just-set capability with stale data. (Same pattern pydaikin uses upstream.)
2. **Write guard on the periodic poll.** Each capability listener stamps `_lastWriteAt`; the periodic `_pollState` skips writing controllable capabilities (mode/temp/fan/swing/special-mode) within `WRITE_GUARD_MS` of the last user write. Sensor capabilities (`measure_temperature`, `measure_temperature.outside`) always update.
3. **Serialised + batched `setControlInfo`.** The BRP072C's `set_control_info` requires all six fields in one query string. Voice commands like "turn on" arrive as two PUTs (mode + setpoint) ~10 ms apart; without serialisation they race through the shared cache and clobber each other. The fix is a per-instance promise queue **plus** a 50 ms collection window that coalesces near-simultaneous calls into one HTTP write — taking combined commands from ~3 s to ~700 ms.
4. **`keepAlive` on the `https.Agent`.** The legacy TLS handshake the BRP072C requires (`SSL_OP_LEGACY_SERVER_CONNECT`) is expensive on its slow CPU. Reusing the TCP socket saves ~100–300 ms per HTTPS call after the first.

If you fork this app for a different Daikin adapter family or another quirky embedded HTTPS device, those four patterns are likely to apply unchanged.

## Credits

Protocol based on [pydaikin](https://github.com/fredrike/pydaikin) by Fredrik Erlandsson.

## License

MIT
