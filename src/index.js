const axios = require('axios');
const { exec } = require('child-process-promise');
const fs = require('fs').promises;
const path = require('path');

let Service, Characteristic;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  api.registerPlatform('SonosPlaylist', SonosPlaylistPlatform);
};

class SonosPlaylistPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = [];
    this.sonosApiPath = '/home/homebridge/.sonos-http-api';
    this.sonosApiPort = config.sonosApiPort || 5005;

    if (!this.config.playlists || !Array.isArray(this.config.playlists)) {
      this.log.error('No playlists configured or invalid configuration');
      return;
    }

    this.setupSonosHttpApi().then(() => {
      this.api.on('didFinishLaunching', () => {
        this.setupAccessories();
      });
    });
  }

  async setupSonosHttpApi() {
    try {
      // Check if sonos-http-api is installed
      await exec('npm list -g sonos-http-api', { timeout: 10000 });
      this.log.info('sonos-http-api is already installed');
    } catch (error) {
      this.log.info('Installing sonos-http-api...');
      try {
        await exec('sudo npm install -g sonos-http-api', { timeout: 60000 });
        this.log.info('sonos-http-api installed successfully');
      } catch (installError) {
        this.log.error('Failed to install sonos-http-api:', installError.message);
        return;
      }
    }

    // Create settings.json
    const settingsPath = path.join(this.sonosApiPath, 'settings.json');
    const settings = {
      port: this.sonosApiPort,
      basedir: this.sonosApiPath
    };
    await fs.mkdir(this.sonosApiPath, { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    await exec(`sudo chown homebridge:homebridge ${settingsPath}`);

    // Create presets directory
    const presetsPath = path.join(this.sonosApiPath, 'presets');
    await fs.mkdir(presetsPath, { recursive: true });
    await exec(`sudo chown -R homebridge:homebridge ${this.sonosApiPath}`);

    // Start sonos-http-api with pm2
    try {
      await exec('pm2 list', { timeout: 10000 });
    } catch (error) {
      await exec('sudo npm install -g pm2', { timeout: 60000 });
    }
    await exec(`pm2 start /home/homebridge/.npm-global/lib/node_modules/sonos-http-api/server.js --name sonos-http-api`, { timeout: 30000 });
    await exec('pm2 save', { timeout: 10000 });
    this.log.info('sonos-http-api started on port', this.sonosApiPort);

    // Test zone discovery
    try {
      const response = await axios.get(`http://127.0.0.1:${this.sonosApiPort}/zones`, { timeout: 5000 });
      this.log.info('Sonos zones discovered:', JSON.stringify(response.data));
    } catch (error) {
      this.log.error('Failed to discover Sonos zones:', error.message);
    }
  }

  setupAccessories() {
    this.config.playlists.forEach((playlistConfig, index) => {
      const uuid = this.api.hap.uuid.generate(`SonosPlaylist:${index}:${playlistConfig.name}`);
      const accessory = new this.api.platformAccessory(playlistConfig.name, uuid);

      accessory.category = this.api.hap.Categories.SWITCH;
      const service = accessory.addService(Service.Switch, playlistConfig.name);

      service.getCharacteristic(Characteristic.On)
        .on('set', (value, callback) => this.handleSwitchSet(playlistConfig, value, callback));

      this.accessories.push(accessory);
      this.api.registerPlatformAccessories('homebridge-sonos-playlist', 'SonosPlaylist', [accessory]);
      this.log.info(`Added accessory: ${playlistConfig.name}`);
    });
  }

  async handleSwitchSet(config, value, callback) {
    const { name, Zones, SpotifyPlaylistID, shuffle = 'off', repeat = 'off' } = config;
    const coordinator = Zones && Zones.split(',')[0] ? Zones.split(',')[0].trim() : 'Bedroom';
    const apiUrl = `http://127.0.0.1:${this.sonosApiPort}`;

    try {
      if (value) {
        // Group zones
        if (Zones && Zones !== 'ALL') {
          const zones = Zones.split(',').map(zone => zone.trim());
          for (const zone of zones.slice(1)) {
            await axios.get(`${apiUrl}/${encodeURIComponent(zone)}/join/${encodeURIComponent(coordinator)}`);
          }
        } else {
          const zonesResponse = await axios.get(`${apiUrl}/zones`);
          const zones = zonesResponse.data.map(group => group.coordinator.roomName);
          for (const zone of zones) {
            if (zone !== coordinator) {
              await axios.get(`${apiUrl}/${encodeURIComponent(zone)}/join/${encodeURIComponent(coordinator)}`);
            }
          }
        }

        // Play playlist
        await axios.get(`${apiUrl}/${encodeURIComponent(coordinator)}/spotify/now/${SpotifyPlaylistID}`);
        await axios.get(`${apiUrl}/${encodeURIComponent(coordinator)}/shuffle/${shuffle}`);
        await axios.get(`${apiUrl}/${encodeURIComponent(coordinator)}/repeat/${repeat}`);
        this.log.info(`Playing ${name} on ${coordinator} (shuffle: ${shuffle}, repeat: ${repeat})`);
      } else {
        // Pause
        await axios.get(`${apiUrl}/${encodeURIComponent(coordinator)}/pause`);
        this.log.info(`Paused ${name} on ${coordinator}`);
      }
      callback(null);
    } catch (error) {
      this.log.error(`Error controlling ${name}: ${error.message}`);
      callback(error);
    }
  }
}