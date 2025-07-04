const axios = require('axios');
const { exec } = require('child-process-promise');
const fs = require('fs').promises;
const path = require('path');

let Service, Characteristic;

class SonosSpotifyPlaylistPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this._accessories = [];
    this.sonosApiPath = '/home/homebridge/.sonos-http-api';
    this.sonosApiPort = config.sonosApiPort || 5005;
    this.activePlaylist = null;

    if (!this.config.playlists || !Array.isArray(this.config.playlists)) {
      this.log.error('No playlists configured or invalid configuration');
      return;
    }

    this.config.playlists.forEach((playlist, index) => {
      if (!playlist.name || !playlist.SpotifyPlaylistID) {
        this.log.error(`Playlist ${index} is invalid: 'name' and 'SpotifyPlaylistID' are required');
      }
    });

    this.setupSonosHttpApi().then(() => {
      this.checkFirewall().then(() => {
        this.api.on('didFinishLaunching', () => {
          this.log.info('didFinishLaunching event triggered');
          this.setupAccessories();
        });
      });
    }).catch(error => {
      this.log.error('Error in setupSonosHttpApi or checkFirewall:', error.message);
      this.api.on('didFinishLaunching', () => {
        this.log.info('didFinishLaunching event triggered despite setup error');
        this.setupAccessories();
      });
    });
  }

  accessories(callback) {
    callback(this._accessories);
  }

  async setupSonosHttpApi() {
    try {
      // Check if sonos-http-api is installed
      await exec('npm list -g sonos-http-api', { timeout: 10000 });
      this.log.info('sonos-http-api is already installed');
    } catch (error) {
      this.log.info('sonos-http-api not found, attempting to uninstall any existing version...');
      try {
        await exec('npm uninstall -g sonos-http-api', { timeout: 30000 });
        this.log.info('Uninstalled existing sonos-http-api');
      } catch (uninstallError) {
        this.log.warn('Could not uninstall sonos-http-api:', uninstallError.message);
      }

      this.log.info('Installing sonos-http-api from GitHub...');
      try {
        await exec('npm install -g jishi/node-sonos-http-api', { timeout: 60000 });
        this.log.info('sonos-http-api installed successfully');
      } catch (installError) {
        this.log.error('Failed to install sonos-http-api:', installError.message);
        return;
      }
    }

    try {
      // Check if the server is running
      await axios.get(`http://127.0.0.1:${this.sonosApiPort}/zones`, { timeout: 5000 });
      this.log.info('sonos-http-api is running and responsive on port', this.sonosApiPort);
    } catch (error) {
      this.log.info('sonos-http-api not running, starting...');
      try {
        // Ensure pm2 is installed
        await exec('pm2 list', { timeout: 10000 });
      } catch (pm2Error) {
        await exec('npm install -g pm2', { timeout: 60000 });
      }

      // Get the global node_modules path dynamically
      const { stdout: globalPrefix } = await exec('npm config get prefix');
      const nodeModulesPath = path.join(globalPrefix.trim(), 'lib', 'node_modules');
      const serverPath = path.join(nodeModulesPath, 'sonos-http-api', 'server.js');

      try {
        // Start the server with the correct path
        await exec(`pm2 start ${serverPath} --name sonos-http-api`, { timeout: 30000 });
        await exec('pm2 save', { timeout: 10000 });
        this.log.info('sonos-http-api started on port', this.sonosApiPort);

        // Wait 5 seconds for the server to initialize
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Check again if the server is responsive
        await axios.get(`http://127.0.0.1:${this.sonosApiPort}/zones`, { timeout: 5000 });
        this.log.info('Sonos zones discovered successfully');
      } catch (startError) {
        this.log.error(
          'Failed to connect to sonos-http-api on port', this.sonosApiPort,
          '. The port may be blocked by a firewall or in use by another process.',
          'Please ensure port', this.sonosApiPort, 'is open (e.g., run `sudo ufw allow', this.sonosApiPort, '`)',
          'and that no other application is using it. Check server logs with `pm2 logs sonos-http-api`.'
        );
      }
    }

    // Setup settings and presets
    const settingsPath = path.join(this.sonosApiPath, 'settings.json');
    const settings = {
      port: this.sonosApiPort,
      basedir: this.sonosApiPath
    };
    try {
      await fs.mkdir(this.sonosApiPath, { recursive: true });
      await fs.chmod(this.sonosApiPath, 0o700);
      await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
      await fs.chmod(settingsPath, 0o600);
    } catch (error) {
      this.log.error('Failed to create settings file:', error.message);
    }

    const presetsPath = path.join(this.sonosApiPath, 'presets');
    const presetPath = path.join(presetsPath, 'default.json');
    const defaultPreset = {
      players: [{ roomName: 'Bedroom', volume: 15 }],
      state: 'playing',
      playMode: { repeat: 'all' },
      uri: this.config.playlists[0]?.SpotifyPlaylistID || 'spotify:playlist:50h5sCtsaBWefyv51GAtmI'
    };
    try {
      await fs.mkdir(presetsPath, { recursive: true });
      await fs.chmod(presetsPath, 0o700);
      await fs.writeFile(presetPath, JSON.stringify(defaultPreset, null, 2));
      await fs.chmod(presetPath, 0o600);
    } catch (error) {
      this.log.error('Failed to create preset file:', error.message);
    }
  }

  async checkFirewall() {
    this.log.info('Please ensure your firewall allows the following ports for the plugin to function correctly: 1900/udp, 5005, 51826, 5353/udp');
    this.log.info('If using ufw, run the following commands to allow these ports:');
    this.log.info('  sudo ufw allow 1900/udp');
    this.log.info('  sudo ufw allow 5005');
    this.log.info('  sudo ufw allow 51826');
    this.log.info('  sudo ufw allow 5353/udp');
    this.log.info('  sudo ufw reload');
  }

  setupAccessories() {
    this.log.info('Starting setupAccessories...');
    this._accessories = [];
    this.log.info(`Found ${this.config.playlists.length} playlists in configuration`);

    this.config.playlists.forEach((playlistConfig, index) => {
      this.log.info(`Processing playlist ${index}: ${JSON.stringify(playlistConfig)}`);
      if (!playlistConfig.name || !playlistConfig.SpotifyPlaylistID) {
        this.log.error(`Skipping playlist ${index}: 'name' and 'SpotifyPlaylistID' are required');
        return;
      }
      const uuid = this.api.hap.uuid.generate(`SonosSpotifyPlaylist:${index}:${playlistConfig.name}`);
      this.log.info(`Generated UUID for ${playlistConfig.name}: ${uuid}`);
      const accessory = new this.api.platformAccessory(playlistConfig.name, uuid);

      accessory.category = this.api.hap.Categories.SWITCH;
      const service = accessory.addService(Service.Switch, playlistConfig.name);

      service.getCharacteristic(Characteristic.On)
        .onSet(async (value) => {
          try {
            await this.handleSwitchSet(playlistConfig, value, service);
          } catch (error) {
            this.log.error(`Error handling switch for ${playlistConfig.name}: ${error.message}`);
          }
        });

      this._accessories.push(accessory);
      this.log.info(`Added accessory: ${playlistConfig.name}`);
    });

    if (this._accessories.length > 0) {
      this.log.info(`Registering ${this._accessories.length} accessories with Homebridge`);
      try {
        this.api.registerPlatformAccessories('homebridge-sonos-spotify-playlist', 'SonosSpotifyPlaylist', this._accessories);
        this.log.info('Successfully registered all playlist accessories with Homebridge');
      } catch (error) {
        this.log.error('Failed to register accessories with Homebridge:', error.message);
      }
    } else {
      this.log.warn('No accessories were added. Check your playlist configuration.');
    }
  }

  async handleSwitchSet(config, value, currentService) {
    const { name, Zones, SpotifyPlaylistID, shuffle = 'off', repeat = 'off' } = config;
    const coordinator = Zones && Zones.split(',')[0] ? Zones.split(',')[0].trim() : 'Bedroom';
    const apiUrl = `http://127.0.0.1:${this.sonosApiPort}`;

    if (value) {
      for (const accessory of this._accessories) {
        const service = accessory.getService(Service.Switch);
        if (service !== currentService) {
          service.getCharacteristic(Characteristic.On).updateValue(false);
        }
      }
      this.activePlaylist = name;

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

      await axios.get(`${apiUrl}/${encodeURIComponent(coordinator)}/spotify/now/${SpotifyPlaylistID}`);
      await axios.get(`${apiUrl}/${encodeURIComponent(coordinator)}/shuffle/${shuffle}`);
      await axios.get(`${apiUrl}/${encodeURIComponent(coordinator)}/repeat/${repeat}`);
      this.log.info(`Playing ${name} on ${coordinator} (shuffle: ${shuffle}, repeat: ${repeat})`);
    } else {
      await axios.get(`${apiUrl}/${encodeURIComponent(coordinator)}/pause`);
      this.log.info(`Paused ${name} on ${coordinator}`);
      this.activePlaylist = null;
    }
  }
}

module.exports = {
  register: (api) => {
    Service = api.hap.Service;
    Characteristic = api.hap.Characteristic;
    api.registerPlatform('SonosSpotifyPlaylist', SonosSpotifyPlaylistPlatform);
  },
  SonosSpotifyPlaylistPlatform
};