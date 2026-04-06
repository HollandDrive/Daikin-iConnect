'use strict';

const https = require('https');
const { v5: uuidv5 } = require('uuid');
const { URL } = require('url');

const NAMESPACE_OID = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';

// Daikin mode mapping
const MODE_MAP = {
  0: 'auto',
  1: 'auto',
  2: 'dry',
  3: 'cool',
  4: 'heat',
  6: 'fan',
  7: 'auto',
};

const REVERSE_MODE_MAP = {
  auto: 0,
  dry: 2,
  cool: 3,
  heat: 4,
  fan: 6,
};

// Fan rate mapping
const FAN_RATE_MAP = {
  A: 'auto',
  B: 'silence',
  3: '1',
  4: '2',
  5: '3',
  6: '4',
  7: '5',
};

const REVERSE_FAN_RATE_MAP = {
  auto: 'A',
  silence: 'B',
  '1': '3',
  '2': '4',
  '3': '5',
  '4': '6',
  '5': '7',
};

// Swing mode mapping
const SWING_MAP = {
  '0': 'off',
  '1': 'vertical',
  '2': 'horizontal',
  '3': 'both',
};

const REVERSE_SWING_MAP = {
  off: '0',
  vertical: '1',
  horizontal: '2',
  both: '3',
};

// Advanced mode mapping
const ADV_MAP = {
  '': [],
  '2': ['powerful'],
  '12': ['econo'],
  '13': ['streamer'],
  '2/13': ['powerful', 'streamer'],
  '12/13': ['econo', 'streamer'],
};

class DaikinApi {
  constructor({ ip, key, log }) {
    this.ip = ip;
    this.key = key;
    this.log = log || console.log;
    this.uuid = uuidv5('homey-daikin-brp072c', NAMESPACE_OID).replace(/-/g, '');
    this.baseUrl = `https://${ip}`;
    this.registered = false;

    this.agent = new https.Agent({
      rejectUnauthorized: false,
      secureOptions: require('constants').SSL_OP_LEGACY_SERVER_CONNECT,
      ciphers: 'DEFAULT:@SECLEVEL=0',
    });
  }

  async _request(path, params = {}) {
    const url = new URL(path, this.baseUrl);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.ip,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: this.agent,
        headers: {
          'X-Daikin-uuid': this.uuid,
        },
        timeout: 10000,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            return;
          }
          resolve(this._parseResponse(data));
        });
      });

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.end();
    });
  }

  _parseResponse(data) {
    const result = {};
    data.split(',').forEach((pair) => {
      const [key, ...rest] = pair.split('=');
      if (key) {
        result[key.trim()] = rest.join('=').trim();
      }
    });
    return result;
  }

  async register() {
    try {
      await this._request('/common/register_terminal', { key: this.key });
      this.registered = true;
      this.log('Registered with Daikin unit');
    } catch (err) {
      this.log('Registration failed:', err.message);
      throw err;
    }
  }

  async getBasicInfo() {
    if (!this.registered) await this.register();
    return this._request('/common/basic_info');
  }

  async getSensorInfo() {
    if (!this.registered) await this.register();
    return this._request('/aircon/get_sensor_info');
  }

  async getControlInfo() {
    if (!this.registered) await this.register();
    return this._request('/aircon/get_control_info');
  }

  async getModelInfo() {
    if (!this.registered) await this.register();
    return this._request('/aircon/get_model_info');
  }

  async getState() {
    const [control, sensor, basic] = await Promise.all([
      this.getControlInfo(),
      this.getSensorInfo(),
      this.getBasicInfo().catch(() => ({})),
    ]);

    const pow = control.pow === '1';
    const mode = MODE_MAP[control.mode] || 'auto';
    const targetTemp = parseFloat(control.stemp) || 22;
    const currentTemp = parseFloat(sensor.htemp);
    const outsideTemp = parseFloat(sensor.otemp);
    const fanRate = FAN_RATE_MAP[control.f_rate] || 'auto';
    const swingMode = SWING_MAP[control.f_dir] || 'off';

    // Parse advanced/special modes
    const advModes = ADV_MAP[control.adv] || [];
    const powerful = advModes.includes('powerful');
    const econo = advModes.includes('econo');
    const streamer = advModes.includes('streamer') || basic.en_streamer === '1';

    return {
      power: pow,
      mode: pow ? mode : 'off',
      targetTemperature: targetTemp,
      currentTemperature: isNaN(currentTemp) ? null : currentTemp,
      outsideTemperature: isNaN(outsideTemp) ? null : outsideTemp,
      fanSpeed: fanRate,
      swingMode,
      powerful,
      econo,
      streamer,
      raw: { control, sensor, basic },
    };
  }

  async setControlInfo(params) {
    if (!this.registered) await this.register();

    const current = await this.getControlInfo();

    const update = {
      pow: params.pow !== undefined ? params.pow : current.pow,
      mode: params.mode !== undefined ? params.mode : current.mode,
      stemp: params.stemp !== undefined ? params.stemp : current.stemp,
      shum: params.shum !== undefined ? params.shum : current.shum,
      f_rate: params.f_rate !== undefined ? params.f_rate : current.f_rate,
      f_dir: params.f_dir !== undefined ? params.f_dir : current.f_dir,
    };

    return this._request('/aircon/set_control_info', update);
  }

  async setPower(on) {
    return this.setControlInfo({ pow: on ? '1' : '0' });
  }

  async setMode(mode) {
    if (mode === 'off') {
      return this.setPower(false);
    }
    const daikinMode = REVERSE_MODE_MAP[mode];
    if (daikinMode === undefined) throw new Error(`Unknown mode: ${mode}`);
    return this.setControlInfo({ pow: '1', mode: String(daikinMode) });
  }

  async setTargetTemperature(temp) {
    return this.setControlInfo({ stemp: String(temp) });
  }

  async setFanSpeed(speed) {
    const rate = REVERSE_FAN_RATE_MAP[speed];
    if (rate === undefined) throw new Error(`Unknown fan speed: ${speed}`);
    return this.setControlInfo({ f_rate: rate });
  }

  async setSwingMode(mode) {
    const dir = REVERSE_SWING_MAP[mode];
    if (dir === undefined) throw new Error(`Unknown swing mode: ${mode}`);
    return this.setControlInfo({ f_dir: dir });
  }

  async setSpecialMode(modeKind, on) {
    if (!this.registered) await this.register();
    // spmode_kind: 0=streamer, 1=powerful, 2=econo
    const kindMap = { powerful: '1', econo: '2', streamer: '0' };
    const kind = kindMap[modeKind];
    if (kind === undefined) throw new Error(`Unknown special mode: ${modeKind}`);

    return this._request('/aircon/set_special_mode', {
      spmode_kind: kind,
      set_spmode: on ? '1' : '0',
    });
  }

  async setStreamer(on) {
    if (!this.registered) await this.register();
    return this._request('/aircon/set_special_mode', {
      en_streamer: on ? '1' : '0',
    });
  }

  async setPowerful(on) {
    return this.setSpecialMode('powerful', on);
  }

  async setEcono(on) {
    return this.setSpecialMode('econo', on);
  }
}

module.exports = DaikinApi;
