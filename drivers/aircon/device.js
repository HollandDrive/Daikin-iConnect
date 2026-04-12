'use strict';

const Homey = require('homey');
const DaikinApi = require('../../lib/DaikinApi');

class AirconDevice extends Homey.Device {
  async onInit() {
    this.log('Daikin device initialized:', this.getName());

    const { ip, key, poll_interval } = this.getSettings();
    this.api = new DaikinApi({ ip, key, log: this.log.bind(this) });

    this.registerCapabilityListener('thermostat_mode', async (value) => {
      this.log('Set mode:', value);
      const apiMode = this._toApiMode(value);
      await this.api.setMode(apiMode);
      await this._pollState();
    });

    this.registerCapabilityListener('target_temperature', async (value) => {
      this.log('Set target temperature:', value);
      await this.api.setTargetTemperature(value);
      await this._pollState();
    });

    this.registerCapabilityListener('fan_speed', async (value) => {
      this.log('Set fan speed:', value);
      await this.api.setFanSpeed(value);
      await this._pollState();
    });

    this.registerCapabilityListener('swing_mode', async (value) => {
      this.log('Set swing mode:', value);
      await this.api.setSwingMode(value);
      await this._pollState();
    });

    if (this.hasCapability('daikin_powerful')) {
      this.registerCapabilityListener('daikin_powerful', async (value) => {
        this.log('Set powerful mode:', value);
        if (value && this.hasCapability('daikin_econo') && this.getCapabilityValue('daikin_econo')) {
          await this.setCapabilityValue('daikin_econo', false).catch(this.error);
        }
        await this.api.setPowerful(value);
        await this._pollState();
      });
    }

    if (this.hasCapability('daikin_econo')) {
      this.registerCapabilityListener('daikin_econo', async (value) => {
        this.log('Set econo mode:', value);
        if (value && this.hasCapability('daikin_powerful') && this.getCapabilityValue('daikin_powerful')) {
          await this.setCapabilityValue('daikin_powerful', false).catch(this.error);
        }
        await this.api.setEcono(value);
        await this._pollState();
      });
    }

    if (this.hasCapability('daikin_streamer')) {
      this.registerCapabilityListener('daikin_streamer', async (value) => {
        this.log('Set streamer mode:', value);
        await this.api.setStreamer(value);
        await this._pollState();
      });
    }

    await this._pollState();

    const interval = (poll_interval || 15) * 1000;
    this._pollInterval = this.homey.setInterval(() => {
      this._pollState().catch((err) => {
        this.log('Poll error:', err.message);
        this.setUnavailable(err.message).catch(this.error);
      });
    }, interval);

    this.log('Daikin device ready');
  }

  _toApiMode(homeyMode) {
    const map = { heatcool: 'auto', fan_only: 'fan' };
    return map[homeyMode] || homeyMode;
  }

  _toHomeyMode(apiMode) {
    const map = { auto: 'heatcool', fan: 'fan_only' };
    return map[apiMode] || apiMode;
  }

  async _pollState() {
    try {
      const state = await this.api.getState();

      await this.setCapabilityValue('thermostat_mode', this._toHomeyMode(state.mode)).catch(this.error);
      await this.setCapabilityValue('target_temperature', state.targetTemperature).catch(this.error);

      if (state.currentTemperature !== null) {
        await this.setCapabilityValue('measure_temperature', state.currentTemperature).catch(this.error);
      }

      if (state.outsideTemperature !== null && this.hasCapability('measure_temperature.outside')) {
        await this.setCapabilityValue('measure_temperature.outside', state.outsideTemperature).catch(this.error);
      }

      await this.setCapabilityValue('fan_speed', state.fanSpeed).catch(this.error);
      await this.setCapabilityValue('swing_mode', state.swingMode).catch(this.error);

      if (this.hasCapability('daikin_powerful')) {
        await this.setCapabilityValue('daikin_powerful', state.powerful).catch(this.error);
      }
      if (this.hasCapability('daikin_econo')) {
        await this.setCapabilityValue('daikin_econo', state.econo).catch(this.error);
      }
      if (this.hasCapability('daikin_streamer')) {
        await this.setCapabilityValue('daikin_streamer', state.streamer).catch(this.error);
      }

      if (!this.getAvailable()) {
        await this.setAvailable();
      }
    } catch (err) {
      this.log('Failed to poll state:', err.message);
      throw err;
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('ip') || changedKeys.includes('key')) {
      const ip = newSettings.ip || oldSettings.ip;
      const key = newSettings.key || oldSettings.key;
      this.api = new DaikinApi({ ip, key, log: this.log.bind(this) });
      this.api.registered = false;
      await this._pollState();
    }

    if (changedKeys.includes('poll_interval')) {
      if (this._pollInterval) {
        this.homey.clearInterval(this._pollInterval);
      }
      const interval = (newSettings.poll_interval || 15) * 1000;
      this._pollInterval = this.homey.setInterval(() => {
        this._pollState().catch((err) => {
          this.log('Poll error:', err.message);
          this.setUnavailable(err.message).catch(this.error);
        });
      }, interval);
    }
  }

  onDeleted() {
    if (this._pollInterval) {
      this.homey.clearInterval(this._pollInterval);
    }
    this.log('Daikin device deleted');
  }
}

module.exports = AirconDevice;
