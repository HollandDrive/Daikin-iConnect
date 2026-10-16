'use strict';

// Setpoint-floor regression tests. No framework: `node test/floor.test.js`.
// device.js requires 'homey', which only resolves inside the Homey runtime, so
// stub it before loading the driver.
const Module = require('module');

const _resolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'homey') return 'homey-stub';
  return _resolve.call(this, req, ...rest);
};
require.cache['homey-stub'] = {
  id: 'homey-stub', filename: 'homey-stub', loaded: true, exports: { Device: class {} },
};

const DaikinApi = require('../lib/DaikinApi');
const AirconDevice = require('../drivers/aircon/device');

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, detail || ''); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COOL_22 = {
  pow: '0', mode: '3', stemp: '22.0', shum: '0', f_rate: 'A', f_dir: '3',
};
const BELOW_FLOOR = { configuredMode: 'cool', targetTemperature: 22, mode: 'cool' };

function mkApi(opts = {}) {
  const api = new DaikinApi({
    ip: '1.2.3.4', key: 'k', log: () => {}, minSetpoint: 24,
  });
  api.registered = true;
  api.sent = [];
  api._request = async (path, params = {}) => {
    api.sent.push({ path, params });
    if (path.includes('get_control_info')) {
      if (opts.readDelay) await sleep(opts.readDelay);
      if (opts.readFails) throw new Error('ECONNRESET');
      return { ret: 'OK', ...(opts.frame || COOL_22) };
    }
    if (opts.writeDelay) await sleep(opts.writeDelay);
    return { ret: opts.writeRet || 'OK' };
  };
  api._controlCache = { ...(opts.frame || COOL_22) };
  return api;
}

function mkDevice(api) {
  const d = Object.create(AirconDevice.prototype);
  Object.assign(d, {
    api,
    _lastWriteAt: 0,
    _pendingUserWrites: 0,
    _floorAttempts: 0,
    _lastFloorWriteAt: 0,
    log: () => {},
    error: () => {},
    caps: {},
    warnings: [],
  });
  d.setCapabilityValue = async (k, v) => { d.caps[k] = v; };
  d.setWarning = async (m) => { d.warnings.push(m); };
  d.unsetWarning = async () => { d.warnings.push(null); };
  return d;
}

const writes = (api) => api.sent.filter((s) => s.path.includes('set_control_info'));
const params = (api) => JSON.stringify(writes(api).map((w) => w.params));

(async () => {
  console.log('ret validation');
  {
    const api = mkApi({ writeRet: 'PARAM NG' });
    let threw = null;
    try { await api.setTargetTemperature(24); } catch (e) { threw = e; }
    check('rejected write throws', threw && /PARAM NG/.test(threw.message), threw && threw.message);
    check('cache invalidated on reject', api._controlCache === null);
  }
  {
    const api = mkApi();
    let threw = null;
    try { await api.setTargetTemperature(24); } catch (e) { threw = e; }
    check('accepted write resolves', threw === null, threw && threw.message);
  }

  console.log('outgoing frame clamp');
  {
    const api = mkApi();
    await api.setFanSpeed('3');
    check('fan action does not retransmit cached 22', writes(api)[0].params.stemp === '24', params(api));
    check('fan action still applies f_rate', writes(api)[0].params.f_rate === '5', params(api));
  }
  {
    const api = mkApi({
      frame: {
        pow: '1', mode: '6', stemp: '--', shum: '0', f_rate: 'A', f_dir: '0',
      },
    });
    await api.setFanSpeed('3');
    check('fan_only stemp untouched', writes(api)[0].params.stemp === '--', params(api));
  }
  {
    const api = mkApi({
      frame: {
        pow: '1', mode: '1', stemp: '0', shum: '0', f_rate: 'A', f_dir: '0',
      },
    });
    await api.setFanSpeed('3');
    check('auto-mode offset untouched', writes(api)[0].params.stemp === '0', params(api));
  }
  {
    const api = mkApi({ frame: { ...COOL_22, stemp: '28.0' } });
    await api.setFanSpeed('3');
    check('above-floor setpoint passes through unchanged', writes(api)[0].params.stemp === '28.0', params(api));
  }

  console.log('power preservation');
  for (const [pow, label] of [['0', 'off unit stays off'], ['1', 'on unit stays on']]) {
    const api = mkApi({ frame: { ...COOL_22, pow } });
    await api.setTargetTemperature(24);
    check(label, writes(api)[0].params.pow === pow, params(api));
  }

  console.log('snapshot');
  {
    const api = mkApi();
    api._request = async () => ({
      ret: 'OK', pow: '0', mode: '3', stemp: '22.0',
    });
    const s = await api.getControlSnapshot();
    check('reads pow/mode/temp', s.power === false && s.configuredMode === 'cool' && s.targetTemperature === 22, JSON.stringify(s));
  }
  {
    const api = mkApi();
    api._request = async () => ({
      ret: 'OK', pow: '1', mode: '6', stemp: '--',
    });
    check('unparseable stemp -> null', (await api.getControlSnapshot()).targetTemperature === null);
  }

  console.log('floor is a floor, not a flattening');
  {
    const api = mkApi();
    const d = mkDevice(api);
    await d._enforceSetpointFloor({ configuredMode: 'cool', targetTemperature: 28, mode: 'cool' });
    check('28C left alone', writes(api).length === 0, params(api));
  }

  console.log('user command during revalidation wins');
  {
    const api = mkApi({ readDelay: 60 });
    const d = mkDevice(api);
    const p = d._enforceSetpointFloor(BELOW_FLOOR);
    await sleep(20);
    d._lastWriteAt = Date.now();
    await p;
    check('no correction over user command', writes(api).length === 0, params(api));
    check('aborted attempt refunded', d._floorAttempts === 0, `attempts=${d._floorAttempts}`);
  }
  {
    const api = mkApi({ readDelay: 10 });
    const d = mkDevice(api);
    await d._enforceSetpointFloor(BELOW_FLOOR);
    check('uninterrupted correction writes 24', writes(api).length === 1 && writes(api)[0].params.stemp === '24', params(api));
  }

  console.log('user write still in flight blocks correction');
  {
    // Guard has lapsed (slow write), but the write is still queued: it would
    // execute before anything we enqueue now, so the correction must stand down.
    const api = mkApi();
    const d = mkDevice(api);
    d._lastWriteAt = Date.now() - 60000;
    d._pendingUserWrites = 1;
    await d._enforceSetpointFloor(BELOW_FLOOR);
    check('no correction while user write pending', writes(api).length === 0, params(api));
    check('blocked attempt not counted', d._floorAttempts === 0, `attempts=${d._floorAttempts}`);
  }
  {
    const api = mkApi({ readDelay: 60 });
    const d = mkDevice(api);
    d._lastWriteAt = Date.now() - 60000;
    const p = d._enforceSetpointFloor(BELOW_FLOOR);
    await sleep(20);
    d._pendingUserWrites = 1;
    await p;
    check('post-revalidation pending check also blocks', writes(api).length === 0, params(api));
  }
  {
    const api = mkApi({ writeDelay: 30 });
    const d = mkDevice(api);
    let during = null;
    await d._userWrite(async () => {
      during = d._pendingUserWrites;
      await api.setTargetTemperature(28);
    });
    check('_userWrite tracks in-flight count', during === 1, `during=${during}`);
    check('_userWrite clears count after', d._pendingUserWrites === 0);
    check('_userWrite re-stamps on completion', Date.now() - d._lastWriteAt < 50);
  }

  console.log('failure accounting');
  {
    const api = mkApi({ readFails: true });
    const d = mkDevice(api);
    for (let i = 0; i < 3; i++) {
      d._lastFloorWriteAt = 0;
      await d._enforceSetpointFloor(BELOW_FLOOR);
    }
    check('revalidation failures counted', d._floorAttempts === 3, `attempts=${d._floorAttempts}`);
    check('warns after repeated failures', d.warnings.some((w) => w && /revalidation failed/.test(w)), JSON.stringify(d.warnings));
  }
  {
    const api = mkApi({ readFails: true });
    const d = mkDevice(api);
    d._lastFloorWriteAt = 0;
    await d._enforceSetpointFloor(BELOW_FLOOR);
    check('single transient failure stays silent', d.warnings.length === 0, JSON.stringify(d.warnings));
  }

  console.log('recovery');
  {
    const api = mkApi();
    const d = mkDevice(api);
    Object.assign(d, { _floorAttempts: 3, _lastFloorWriteAt: Date.now(), _floorWarned: true });
    await d._enforceSetpointFloor({ configuredMode: 'cool', targetTemperature: 24, mode: 'cool' });
    check('attempts and timer cleared', d._floorAttempts === 0 && d._lastFloorWriteAt === 0);
    check('warning cleared', d.warnings[d.warnings.length - 1] === null, JSON.stringify(d.warnings));
  }

  console.log('late read must not clobber a newer write');
  {
    const api = mkApi({ readDelay: 60 });
    const readP = api.getControlInfo();
    await sleep(20);
    api._controlCache = { ...COOL_22, pow: '1', stemp: '24.0' };
    api._writeSeq += 1;
    await readP;
    check('cache keeps newer write', api._controlCache.stemp === '24.0' && api._controlCache.pow === '1', JSON.stringify(api._controlCache));
  }
  {
    const api = mkApi({ readDelay: 10 });
    api._controlCache = null;
    await api.getControlInfo();
    check('uncontended read populates cache', api._controlCache.stemp === '22.0');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
