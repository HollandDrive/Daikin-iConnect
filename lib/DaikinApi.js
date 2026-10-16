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

// Modes whose stemp is a real temperature, so a floor can apply to it.
const FLOOR_MODES = new Set(['cool', 'heat']);

class DaikinApi {
  constructor({ ip, key, log, minSetpoint = null }) {
    this.ip = ip;
    this.key = key;
    this.log = log || console.log;
    // Enforced on every outgoing control frame, not just explicit setpoint
    // writes: _executeControlInfo refills unspecified fields from the cache,
    // so a fan-speed action would otherwise re-transmit a stale sub-floor
    // stemp that a handset had set between polls.
    this.minSetpoint = minSetpoint;
    this.uuid = uuidv5('homey-daikin-brp072c', NAMESPACE_OID).replace(/-/g, '');
    this.baseUrl = `https://${ip}`;
    this.registered = false;
    this._controlCache = null;
    // Bumped on every accepted write. A read that was already in flight when a
    // write landed must not publish its (now stale) frame as the cache.
    this._writeSeq = 0;
    this._writeQueue = Promise.resolve();
    this._pendingBatch = null;

    this.agent = new https.Agent({
      rejectUnauthorized: false,
      secureOptions: require('constants').SSL_OP_LEGACY_SERVER_CONNECT,
      ciphers: 'DEFAULT:@SECLEVEL=0',
      keepAlive: true,
      // Must exceed poll interval (default 15s) so SETs land on a warm socket;
      // a cold legacy-TLS handshake to the BRP072C42 costs ~1.4s.
      keepAliveMsecs: 30000,
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
        timeout: 30000,
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
    const seq = this._writeSeq;
    const result = await this._request('/aircon/get_control_info');
    // Only adopt this frame if no write completed while it was outstanding;
    // otherwise it predates the write and would resurrect stale pow/stemp.
    if (seq === this._writeSeq) {
      this._controlCache = result;
    }
    return result;
  }

  async getModelInfo() {
    if (!this.registered) await this.register();
    return this._request('/aircon/get_model_info');
  }

  // A fresh, minimal read for callers that must revalidate immediately before
  // writing. getState() issues two further HTTP requests after its control read,
  // and the handset can change pow or stemp inside that gap.
  async getControlSnapshot() {
    const control = await this.getControlInfo();
    const temp = parseFloat(control.stemp);
    return {
      power: control.pow === '1',
      configuredMode: MODE_MAP[control.mode] || 'auto',
      targetTemperature: isNaN(temp) ? null : temp,
    };
  }

  async getState() {
    // BRP072C adapter accepts only one HTTP connection at a time; parallel
    // requests cause contention and dropped responses. Serialise the three GETs.
    const control = await this.getControlInfo();
    const sensor = await this.getSensorInfo();
    const basic = await this.getBasicInfo().catch(() => ({}));

    const pow = control.pow === '1';
    const mode = MODE_MAP[control.mode] || 'auto';
    // stemp is only a real setpoint in cool/heat. In dry/fan the unit returns
    // "--" or "M", and in auto it returns a -5..+5 offset. Report null rather
    // than substituting a number: the setpoint floor in device.js acts on this
    // value, and a fabricated default would make it correct a reading that was
    // never a temperature.
    const targetTemp = parseFloat(control.stemp);
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
      // The mode the unit is configured for, independent of power state. `mode`
      // above collapses to 'off' when powered down, which hides whether the
      // stored setpoint is a real temperature — the setpoint floor needs to act
      // on an off unit too, so that it starts up at a corrected value.
      configuredMode: mode,
      targetTemperature: isNaN(targetTemp) ? null : targetTemp,
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

  setControlInfo(params) {
    if (this._pendingBatch) {
      Object.assign(this._pendingBatch.params, params);
      return this._pendingBatch.promise;
    }

    const batch = { params: { ...params } };
    batch.promise = new Promise((resolve, reject) => {
      batch.resolve = resolve;
      batch.reject = reject;
    });
    this._pendingBatch = batch;

    setTimeout(() => {
      this._pendingBatch = null;
      const next = this._writeQueue.then(async () => {
        try {
          const result = await this._executeControlInfo(batch.params);
          batch.resolve(result);
          return result;
        } catch (err) {
          batch.reject(err);
          throw err;
        }
      });
      this._writeQueue = next.catch(() => {});
    }, 50);

    return batch.promise;
  }

  async _executeControlInfo(params) {
    if (!this.registered) await this.register();

    const current = this._controlCache || await this.getControlInfo();

    const update = {
      pow: params.pow !== undefined ? params.pow : current.pow,
      mode: params.mode !== undefined ? params.mode : current.mode,
      stemp: params.stemp !== undefined ? params.stemp : current.stemp,
      shum: params.shum !== undefined ? params.shum : current.shum,
      f_rate: params.f_rate !== undefined ? params.f_rate : current.f_rate,
      f_dir: params.f_dir !== undefined ? params.f_dir : current.f_dir,
    };

    if (this.minSetpoint !== null) {
      const outMode = MODE_MAP[update.mode];
      const outTemp = parseFloat(update.stemp);
      if (FLOOR_MODES.has(outMode) && !isNaN(outTemp) && outTemp < this.minSetpoint) {
        this.log(`Clamping outgoing stemp ${update.stemp} to floor ${this.minSetpoint}`);
        update.stemp = String(this.minSetpoint);
      }
    }

    try {
      const result = await this._request('/aircon/set_control_info', update);
      // The adapter answers HTTP 200 even when it refuses the frame, reporting
      // the real outcome in `ret` (e.g. "PARAM NG"). Without this check a
      // rejected write looks successful and callers publish state the unit
      // never accepted.
      if (result.ret !== 'OK') {
        throw new Error(`set_control_info rejected: ret=${result.ret || 'missing'}`);
      }
      this._writeSeq += 1;
      this._controlCache = { ...current, ...update };
      return result;
    } catch (err) {
      this._controlCache = null;
      throw err;
    }
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
