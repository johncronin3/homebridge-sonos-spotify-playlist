const axios = require('axios');
const { exec } = require('child-process-promise');
const fs = require('fs').promises;
const path = require('path');

let Service, Characteristic;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  api.registerPlatform('SonosSpotifyPlaylist', SonosSpotifyPlaylistPlatform);
};

class SonosSpotifyPlaylistPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = [];
    this.sonosApiPath = '/home/homebridge/.sonos-http-api';
    this.sonosApiPort = config.sonosApiPort || 5005;
    this.activePlaylist = null;

    if (!this.config.playlists || !Array.isArray(this.config.playlists)) {
      this.log.error('No playlists configured or invalid configuration');
      return;
    }

    this.config.playlists.forEach((playlist, index) => {
      if (!playlist.name || !playlist.SpotifyPlaylistID) {
        this.log.error("Playlist ${index} is invalid: 'name' and 'SpotifyPlaylistID' are required");
      }
    });

    this.setupSonosHttpApi().then(() => {
      this.checkFirewall().then(() => {
        this.api.on('didFinishLaunching', () => {
          this.setupAccessories();
        });
      });
    });
  }

  accessories(callback) {
    callback(this.accessories);
  }

  async setupSonosHttpApi() {
    try {
      await exec('npm list -g node-sonos-http-api', { timeout: 10000 });
      this.log.info('node-sonos-http-api is already installed');
    } catch (error) {
      this.log.info('Installing node-sonos-http-api from GitHub...');
      try {
        await exec('sudo npm install -g jishi/node-sonos-http-api', { timeout: 60000 });
        this.log.info('node-sonos-http-api installed successfully');
      } catch (installError) {
        this.log.error('Failed to install node-sonos-http-api:', installError.message);
        return;
      }
    }

    try {
      await axios.get(`http://127.0.0.1:${this.sonosApiPort}/zones`, { timeout: 5000 });
      this.log.info('node-sonos-http-api is running and responsive on port', this.sonosApiPort);
    } catch (error) {
      this.log.info('node-sonos-http-api not running, starting...');
      try {
        await exec('pm2 list', { timeout: 10000 });
      } catch (pm2Error) {
        await exec('sudo npm install -g pm2', { timeout: 60000 });
      }
      await exec(`pm2 start /home/homebridge/.npm-global/lib/node_modules/node-sonos-http-api/server.js --name sonos-http-api`, { timeout: 30000 });
      await exec('pm2 save', { timeout: 10000 });
      this.log.info('node-sonos-http-api started on port', this.sonosApiPort);
    }

    const settingsPath = path.join(this.sonosApiPath, 'settings.json');
    const settings = {
      port: this.sonosApiPort,
      basedir: this.sonosApiPath
    };
    await fs.mkdir(this.sonosApiPath, { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    await exec(`sudo chown homebridge:homebridge ${settingsPath}`);

    const presetsPath = path.join(this.sonosApiPath, 'presets');
    await fs.mkdir(presetsPath, { recursive: true });
    const presetPath = path.join(presetsPath, 'default.json');
    const defaultPreset = {
      players: [{ roomName: 'Bedroom', volume: 15 }],
      state: 'playing',
      playMode: { repeat: 'all' },
      uri: this.config.playlists[0]?.SpotifyPlaylistID || 'spotify:playlist:50h5sCtsaBWefyv51GAtmI'
    };
    await fs.writeFile(presetPath, JSON.stringify(defaultPreset, null, 2));
    await exec(`sudo chown -R homebridge:homebridge ${this.sonosApiPath}`);

    try {
      const response = await axios.get(`http://127.0.0.1:${this.sonosApiPort}/zones`, { timeout: 5000 });
      this.log.info('Sonos zones discovered:', JSON.stringify(response.data));
    } catch (error) {
      this.log.error('Failed to discover Sonos zones:', error.message);
    }
  }

  async checkFirewall() {
    try {
      await exec('sudo ufw status', { timeout: 5000 });
      const ufwStatus = await exec('sudo ufw status numbered', { timeout: 5000 });
      if (ufwStatus.stdout.includes('Status: active')) {
        const requiredPorts = ['1900/udp', this.sonosApiPort.toString(), '51826', '5353/udp'];
        const rules = ufwStatus.stdout.split('\n');
        const missingPorts = requiredPorts.filter(port => !rules.some(rule => rule.includes(port)));
        if (missingPorts.length > 0) {
          this.log.warn(`Firewall (ufw) may block plugin functionality. Missing ports: ${missingPorts.join(', ')}. Run:
            sudo ufw allow 1900/udp
            sudo ufw allow proto udp to 239.255.255.250 port 1900
            sudo ufw allow proto udp from 192.168.1.0/24 port 1900
            sudo ufw allow ${this.sonosApiPort}
            sudo ufw allow 51826
            sudo ufw allow 5353/udp
            sudo ufw reload
          `);
        } else {
          this.log.info('Firewall (ufw) appears configured for required ports');
        }
      } else {
        this.log.info('ufw is inactive; ensure no other firewall blocks ports 1900/udp, 5005, 51826, 5353/udp');
      }
    } catch (error) {
      this.log.warn('Could not check ufw status:', error.message);
      this.log.warn('Ensure firewall allows ports 1900/udp, 5005, 51826, 5353/udp');
    }
  }

  setupAccessories() {
    this.accessories = [];
    this.config.playlists.forEach((playlistConfig, index) => {
      if (!playlistConfig.name || !playlistConfig.SpotifyPlaylistID) {
        this.log.error(`Skipping playlist ${index}: 'name' and 'SpotifyPlaylistID' are required`);
        return;
      }
      const uuid = this.api.hap.uuid.generate(`SonosSpotifyPlaylist:${index}:${playlistConfig.name}`);
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

      this.accessories.push(accessory);
      this.api.publishExternalAccessories('homebridge-sonos-spotify-playlist', [accessory]);
      this.log.info(`Added accessory: ${playlistConfig.name}`);
    });
  }

  async handleSwitchSet(config, value, currentService) {
    const { name, Zones, SpotifyPlaylistID, shuffle = 'off', repeat = 'off' } = config;
    const coordinator = Zones && Zones.split(',')[0] ? Zones.split(',')[0].trim() : 'Bedroom';
    const apiUrl = `http://127.0.0.1:${this.sonosApiPort}`;

    if (value) {
      for (const accessory of this.accessories) {
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