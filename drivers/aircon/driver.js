'use strict';

const Homey = require('homey');
const DaikinApi = require('../../lib/DaikinApi');

class AirconDriver extends Homey.Driver {
  async onInit() {
    this.log('Daikin Aircon driver initialized');
  }

  async onPairListDevices() {
    return [];
  }

  async onPair(session) {
    let ip = '';
    let key = '';

    session.setHandler('login', async (data) => {
      ip = data.username.trim();
      key = data.password.trim();

      if (!ip || !key) {
        throw new Error('IP address and API key are required');
      }

      // Test connection
      const api = new DaikinApi({ ip, key, log: this.log.bind(this) });
      try {
        await api.register();
        const info = await api.getBasicInfo();
        const state = await api.getState();

        this.log('Connected to Daikin:', info.name || ip);
        this.log('Current state:', JSON.stringify(state));

        return true;
      } catch (err) {
        this.log('Connection failed:', err.message);
        throw new Error(`Could not connect to Daikin at ${ip}: ${err.message}`);
      }
    });

    session.setHandler('list_devices', async () => {
      const api = new DaikinApi({ ip, key, log: this.log.bind(this) });
      await api.register();
      const info = await api.getBasicInfo();

      const name = info.name
        ? decodeURIComponent(info.name)
        : `Daikin ${ip}`;

      return [
        {
          name,
          data: {
            id: `daikin-${ip.replace(/\./g, '-')}`,
          },
          settings: {
            ip,
            key,
          },
        },
      ];
    });
  }
}

module.exports = AirconDriver;
