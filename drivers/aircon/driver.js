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
    let modelInfo = {};

    session.setHandler('login', async (data) => {
      ip = data.username.trim();
      key = data.password.trim();

      if (!ip || !key) {
        throw new Error('IP address and API key are required');
      }

      const api = new DaikinApi({ ip, key, log: this.log.bind(this) });
      try {
        await api.register();
        const info = await api.getBasicInfo();
        modelInfo = await api.getModelInfo();
        const state = await api.getState();

        this.log('Connected to Daikin:', info.name || ip);
        this.log('Model info:', JSON.stringify(modelInfo));

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

      // Build capabilities based on model support
      const capabilities = [
        'thermostat_mode',
        'target_temperature',
        'measure_temperature',
        'measure_temperature.outside',
        'fan_speed',
        'swing_mode',
      ];

      const supportsSpecialModes = modelInfo.en_spmode === '1';
      if (supportsSpecialModes) {
        capabilities.push('daikin_powerful');
        capabilities.push('daikin_econo');
      }

      this.log(`Special modes supported: ${supportsSpecialModes} (en_spmode=${modelInfo.en_spmode})`);

      return [
        {
          name,
          data: {
            id: `daikin-${ip.replace(/\./g, '-')}`,
          },
          capabilities,
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
