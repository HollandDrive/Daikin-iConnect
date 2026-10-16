'use strict';

const Homey = require('homey');
const DaikinApi = require('../../lib/DaikinApi');

const WRITE_GUARD_MS = 5000;
const POLL_FAILURE_THRESHOLD = 3;

// Household setpoint floor. The IR handset and the unit's own ON/OFF button
// write straight to the BRP072C over IR, bypassing Homey entirely, so capping
// the UI slider in app.json is not enough on its own — _enforceSetpointFloor
// reconciles the unit on the regular poll.
const MIN_SETPOINT = 24;
// Only cool/heat carry a real degrees-C setpoint (see DaikinApi.getState).
const FLOOR_ENFORCED_MODES = ['cool', 'heat'];
const FLOOR_RETRY_MS = 60000;
const FLOOR_MAX_ATTEMPTS = 3;
const FLOOR_BACKOFF_MS = 900000;

class AirconDevice extends Homey.Device {
  async onInit() {
    this.log('Daikin device initialized:', this.getName());

    const { ip, key, poll_interval } = this.getSettings();
    this.api = new DaikinApi({ ip, key, log: this.log.bind(this), minSetpoint: MIN_SETPOINT });
    this._lastWriteAt = 0;
    this._pendingUserWrites = 0;
    this._pollFailures = 0;

    // Migration: add special-mode capabilities to devices paired before
    // the en_spmode model-detect gate worked correctly.
    if (!this.hasCapability('daikin_powerful')) {
      await this.addCapability('daikin_powerful').catch(this.error);
    }
    if (!this.hasCapability('daikin_econo')) {
      await this.addCapability('daikin_econo').catch(this.error);
    }

    this.registerCapabilityListener('thermostat_mode', async (value) => this._userWrite(async () => {
      this.log('Set mode:', value);
      const apiMode = this._toApiMode(value);
      await this.api.setMode(apiMode);
    }));

    this.registerCapabilityListener('target_temperature', async (value) => this._userWrite(async () => {
      // BRP072C units don't accept half-degree setpoints; round to integer before sending.
      // Clamp to the floor too, so a direct API call or an older flow card can't
      // duck under it. The capability keeps the caller's value until the next poll
      // reconciles it — deliberately not corrected here, because the SDK applies
      // the listener's own value after this resolves and would overwrite it.
      const rounded = Math.max(MIN_SETPOINT, Math.round(value));
      this.log('Set target temperature:', rounded);
      await this.api.setTargetTemperature(rounded);
    }));

    this.registerCapabilityListener('fan_speed', async (value) => this._userWrite(async () => {
      this.log('Set fan speed:', value);
      await this.api.setFanSpeed(value);
    }));

    this.registerCapabilityListener('swing_mode', async (value) => this._userWrite(async () => {
      this.log('Set swing mode:', value);
      await this.api.setSwingMode(value);
    }));

    // Listener registration is unconditional — all devices now have these
    // capabilities after the onInit migration block above. Wrapping the
    // listener registration in `if (hasCapability(...))` can race the
    // addCapability await on first init and silently skip registration.
    this.registerCapabilityListener('daikin_powerful', async (value) => this._userWrite(async () => {
      this.log('Set powerful mode:', value);
      if (value && this.hasCapability('daikin_econo') && this.getCapabilityValue('daikin_econo')) {
        await this.setCapabilityValue('daikin_econo', false).catch(this.error);
      }
      await this.api.setPowerful(value);
    }));

    this.registerCapabilityListener('daikin_econo', async (value) => this._userWrite(async () => {
      this.log('Set econo mode:', value);
      if (value && this.hasCapability('daikin_powerful') && this.getCapabilityValue('daikin_powerful')) {
        await this.setCapabilityValue('daikin_powerful', false).catch(this.error);
      }
      await this.api.setEcono(value);
    }));

    if (this.hasCapability('daikin_streamer')) {
      this.registerCapabilityListener('daikin_streamer', async (value) => this._userWrite(async () => {
        this.log('Set streamer mode:', value);
        await this.api.setStreamer(value);
      }));
    }

    await this._pollState();

    const interval = (poll_interval || 15) * 1000;
    this._pollInterval = this.homey.setInterval(() => {
      this._pollState().catch((err) => this._onPollFailure(err));
    }, interval);

    this.log('Daikin device ready');
  }

  // Wraps every capability listener. Tracks writes that are still in flight and
  // re-stamps on completion: _lastWriteAt alone marks when a write *started*, so
  // a write slower than WRITE_GUARD_MS (a cold BRP072C handshake can take 7s+)
  // would let the guard lapse while it is still queued, and a correction queued
  // behind it would then land last and overwrite it.
  async _userWrite(fn) {
    this._pendingUserWrites = (this._pendingUserWrites || 0) + 1;
    this._lastWriteAt = Date.now();
    try {
      return await fn();
    } finally {
      this._pendingUserWrites = Math.max(0, this._pendingUserWrites - 1);
      this._lastWriteAt = Date.now();
    }
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
      const inWriteWindow = (Date.now() - this._lastWriteAt) < WRITE_GUARD_MS;

      if (state.currentTemperature !== null) {
        await this.setCapabilityValue('measure_temperature', state.currentTemperature).catch(this.error);
      }

      if (state.outsideTemperature !== null && this.hasCapability('measure_temperature.outside')) {
        await this.setCapabilityValue('measure_temperature.outside', state.outsideTemperature).catch(this.error);
      }

      if (!inWriteWindow) {
        await this.setCapabilityValue('thermostat_mode', this._toHomeyMode(state.mode)).catch(this.error);
        if (state.targetTemperature !== null && state.targetTemperature >= MIN_SETPOINT) {
          await this.setCapabilityValue('target_temperature', state.targetTemperature).catch(this.error);
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
      }

      await this._enforceSetpointFloor(state);

      this._pollFailures = 0;
      if (!this.getAvailable()) {
        await this.setAvailable();
      }
    } catch (err) {
      this.log('Failed to poll state:', err.message);
      throw err;
    }
  }

  // Writes the floor back to the unit when something outside Homey (IR handset,
  // the unit's ON/OFF button) has set a colder setpoint.
  async _enforceSetpointFloor(state) {
    if (!FLOOR_ENFORCED_MODES.includes(state.configuredMode)) return;
    if (state.targetTemperature === null) return;

    if (state.targetTemperature >= MIN_SETPOINT) {
      await this._floorResolved();
      return;
    }

    const now = Date.now();
    if (now - this._lastWriteAt < WRITE_GUARD_MS) return;
    // A user write still in the queue will execute before anything we enqueue
    // now, so our correction would land last and win. Let it finish; the next
    // poll re-evaluates against the result.
    if (this._pendingUserWrites > 0) return;
    const retryDelay = (this._floorAttempts || 0) >= FLOOR_MAX_ATTEMPTS
      ? FLOOR_BACKOFF_MS
      : FLOOR_RETRY_MS;
    if (now - (this._lastFloorWriteAt || 0) < retryDelay) return;

    // Claim the attempt before awaiting anything, so a slow revalidation can't
    // let successive polls stack up concurrent corrections, and so a run of
    // failed revalidations still reaches the backoff and the warning.
    this._floorAttempts = (this._floorAttempts || 0) + 1;
    this._lastFloorWriteAt = now;
    const writeStamp = this._lastWriteAt;

    // Revalidate against a fresh read. `state` came from getState(), which
    // issued two more HTTP requests after its control read; the handset can
    // switch the unit off inside that gap. _executeControlInfo carries the
    // cached pow through, so correcting on stale state could switch a
    // just-turned-off unit back on.
    let fresh;
    try {
      fresh = await this.api.getControlSnapshot();
    } catch (err) {
      this.log('Setpoint floor revalidation failed:', err.message);
      await this._maybeWarnFloorStuck(state.targetTemperature, `revalidation failed: ${err.message}`);
      return;
    }

    // A user command landed while we were revalidating. Theirs is newer and
    // already floor-clamped by the capability listener, so let it stand rather
    // than stamping MIN_SETPOINT over an explicit choice. Give back the attempt:
    // being interrupted is not the unit refusing to hold the floor.
    if (this._lastWriteAt !== writeStamp || this._pendingUserWrites > 0) {
      this.log('Setpoint floor correction aborted: user command during revalidation');
      this._floorAttempts = Math.max(0, (this._floorAttempts || 1) - 1);
      return;
    }

    if (!FLOOR_ENFORCED_MODES.includes(fresh.configuredMode)) return;
    if (fresh.targetTemperature === null) return;
    if (fresh.targetTemperature >= MIN_SETPOINT) {
      await this._floorResolved();
      return;
    }

    this.log(
      `Setpoint ${fresh.targetTemperature}C is below the ${MIN_SETPOINT}C floor `
      + `(${fresh.configuredMode}, pow=${fresh.power ? 1 : 0}) - correcting, `
      + `attempt ${this._floorAttempts}`,
    );

    try {
      // setTargetTemperature carries the unit's current pow through unchanged,
      // so correcting an off unit does not switch it on.
      await this.api.setTargetTemperature(MIN_SETPOINT);
      await this.setCapabilityValue('target_temperature', MIN_SETPOINT).catch(this.error);
    } catch (err) {
      // Never rethrow: a failed correction must not count as a poll failure and
      // mark the device unavailable. The backoff above caps the retry rate.
      this.log('Setpoint floor correction failed:', err.message);
      await this._maybeWarnFloorStuck(fresh.targetTemperature, err.message);
      return;
    }

    // The write was accepted (ret=OK), but the unit can still fail to hold it.
    await this._maybeWarnFloorStuck(fresh.targetTemperature, 'unit keeps reverting');
  }

  async _floorResolved() {
    this._floorAttempts = 0;
    // Clear the rate limiter too: it exists to stop hammering a unit that is
    // refusing corrections, not to delay the next genuine handset change.
    this._lastFloorWriteAt = 0;
    if (this._floorWarned) {
      this._floorWarned = false;
      await this.unsetWarning().catch(this.error);
    }
  }

  // Only speaks up once corrections have genuinely stopped working, so a single
  // transient HTTP failure doesn't raise a warning on the device tile.
  async _maybeWarnFloorStuck(reading, reason) {
    if ((this._floorAttempts || 0) < FLOOR_MAX_ATTEMPTS) return;
    this._floorWarned = true;
    await this.setWarning(
      `Setpoint stuck at ${reading}C - cannot enforce the ${MIN_SETPOINT}C floor (${reason})`,
    ).catch(this.error);
  }

  _onPollFailure(err) {
    this._pollFailures = (this._pollFailures || 0) + 1;
    this.log(`Poll error (${this._pollFailures}/${POLL_FAILURE_THRESHOLD}):`, err.message);
    if (this._pollFailures >= POLL_FAILURE_THRESHOLD) {
      this.setUnavailable(err.message).catch(this.error);
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('ip') || changedKeys.includes('key')) {
      const ip = newSettings.ip || oldSettings.ip;
      const key = newSettings.key || oldSettings.key;
      this.api = new DaikinApi({ ip, key, log: this.log.bind(this), minSetpoint: MIN_SETPOINT });
      this.api.registered = false;
      await this._pollState();
    }

    if (changedKeys.includes('poll_interval')) {
      if (this._pollInterval) {
        this.homey.clearInterval(this._pollInterval);
      }
      const interval = (newSettings.poll_interval || 15) * 1000;
      this._pollInterval = this.homey.setInterval(() => {
        this._pollState().catch((err) => this._onPollFailure(err));
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
