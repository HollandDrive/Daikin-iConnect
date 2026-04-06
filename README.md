# Daikin iConnect for Homey

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

## How It Works

This app communicates directly with your Daikin's encrypted local API over HTTPS. It uses the same protocol as Home Assistant's Daikin integration (pydaikin), ported to Node.js for Homey.

No cloud services, no external dependencies, no account required.

## Credits

Protocol based on [pydaikin](https://github.com/fredrike/pydaikin) by Fredrik Erlandsson.

## License

MIT
