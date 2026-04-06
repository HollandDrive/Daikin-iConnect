'use strict';

const Homey = require('homey');

class DaikinBRP072CApp extends Homey.App {
  async onInit() {
    this.log('Daikin iConnect app started');
  }
}

module.exports = DaikinBRP072CApp;
