# Homebridge Vantage Controls
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

A [Homebridge](https://homebridge.io/) plugin for Vantage Controls InFusion system. 
This plugin replaces the one sold on smarterhome.io allowing anyone to download on the platform of their choice.

## Features

- **Lighting Control**: Supports dimmers, RGB lights, and relays
- **Fan Control**: Loads whose name contains `fan` appear as HomeKit fans with a speed slider
- **Thermostat Control**: Full HVAC control with heating/cooling modes
- **Blind Control**: Window covering automation
- **Real-time Updates**: Live status updates from your InFusion controller
- **SSL Support**: Secure connections to your controller
- **Device Filtering**: Include or exclude devices by type, omit list, or VID range
- **Safe Configuration Cache**: Downloads fresh controller configuration on every startup while keeping a persistent last-known-good fallback
- **Controller Discovery**: Uses the configured IP first, then mDNS if that address does not respond

## Installation

1. Install Homebridge:
```bash
npm install -g homebridge
```

2. Install this plugin:
```bash
npm install -g @smarterhomeapp/homebridge-vantage
```

3. Add the platform to your `config.json`:
```json
{
  "platforms": [
    {
      "platform": "VantageControls",
      "name": "Vantage Controls",
      "ipaddress": "192.168.1.100",
      "username": "your_username",
      "password": "your_password",
      "usecache": true,
      "forceSSL": false,
      "includeLights": true,
      "includeBlinds": true,
      "includeThermostats": true,
      "includeSensors": true,
      "omit": "1234,5678",
      "range": "0-2290"
    }
  ]
}
```

`platform` must stay `"VantageControls"`. `name` is only a label for logs and the Config UI.

## Configuration

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `platform` | string | Yes | Must be `"VantageControls"` |
| `name` | string | Yes | Display name for this platform entry |
| `ipaddress` | string | No | Controller IP. Leave blank to discover an InFusion controller with mDNS. If a configured IP stops responding, the plugin also tries mDNS. |
| `username` | string | No | Username for authentication. If login fails or times out, the plugin still attempts the configuration download. The common typo `admin` is retried as `administrator`. |
| `password` | string | No | Password for authentication. Used with `username`; a rejected login does not skip discovery. |
| `forceSSL` | boolean | No | Skip insecure ports and use 3010/2010 directly (default: false) |
| `usecache` | boolean | No | Maintain a persistent last-known-good configuration fallback while still attempting fresh controller discovery on every startup (default: true). If this is off and a live download fails, existing HomeKit accessories are kept. |
| `includeLights` | boolean | No | Include Vantage loads, dimmers, relays, RGB loads, and similar switch/light devices (default: true) |
| `includeBlinds` | boolean | No | Include Vantage blinds, shades, and window coverings (default: true) |
| `includeThermostats` | boolean | No | Include Vantage thermostats and HVAC zones (default: true) |
| `includeSensors` | boolean | No | Include dry contacts, temperature sensors, light sensors, and Omni sensors (default: true) |
| `omit` | string | No | Comma-separated list of VIDs to exclude |
| `range` | string | No | VID range using `min-max`, e.g. `1000-2000`. Legacy comma format, e.g. `1000,2000`, is still supported. |

## Configuration Discovery and Cache

On each Homebridge startup, the plugin first attempts to download the current Vantage controller configuration. If the downloaded configuration is valid and complete, it is used immediately and saved atomically as the persistent last-known-good configuration.

When `usecache` is enabled, the persistent cache is only a fallback. If the controller is offline, returns malformed XML, returns an empty configuration, or returns a suspiciously incomplete configuration, the plugin preserves the existing cache and uses the last-known-good configuration instead.

The cache is stored under Homebridge's configured storage directory in a plugin-specific `vantage` folder. Cache filenames are keyed by controller IP, for example `vantage-10.0.0.100.dc`, so multiple platform instances using different VID ranges for the same controller share one full-controller cache. Restarts naturally pick up controller/DC changes; users do not need to manually clear the cache.

The plugin also writes a copy to `/tmp/vantage.dc` for local tools such as Organize Home. That dump is updated from the configuration Homebridge actually uses: a successful live download, or the persistent last-known-good cache if live discovery fails. Incomplete or rejected downloads are not written there.

## HomeKit Accessory Limit and Child Bridges

HomeKit allows about 149 accessories on one bridge. If discovery finds more than that, split the controller with two `VantageControls` entries and different `range` values.

On Homebridge 2, every extra instance of the same dynamic platform must be a child bridge. Put `_bridge` on each split instance, with a unique username and port. Each child bridge is paired separately in the Home app.

```json
{
  "platforms": [
    {
      "platform": "VantageControls",
      "name": "Vantage Low",
      "ipaddress": "192.168.1.100",
      "range": "0-2290",
      "_bridge": {
        "username": "0E:AA:BB:CC:DD:02",
        "port": 51839
      }
    },
    {
      "platform": "VantageControls",
      "name": "Vantage High",
      "ipaddress": "192.168.1.100",
      "range": "2291-999999999",
      "_bridge": {
        "username": "0E:AA:BB:CC:DD:03",
        "port": 51840
      }
    }
  ]
}
```

Homebridge 1.x still accepts one instance on the main bridge and one child bridge. That layout is rejected on Homebridge 2.

## Supported Devices

### Lighting
- **Dimmers**: Variable brightness control
- **RGB Lights**: Full color control with HSL values
- **Relays**: On/off switches for non-dimmable loads

### Fans
- **Named loads**: If a load name contains `fan` (for example `Master Fan`), HomeKit shows a fan with on/off and a 0–100 speed slider. Speed is the Vantage dim level. HVAC contacts named Fan are still omitted.

### HVAC
- **Thermostats**: Temperature control with heating/cooling modes
- **Auto Mode**: Automatic temperature regulation
- **Temperature Units**: Celsius/Fahrenheit support

### Window Coverings
- **Blinds**: Position control (0-100%)
- **Shades**: Motorized window coverings

### Sensors
- **Dry contacts**: Contact sensors, including motion-style contacts
- **Temperature and Omni sensors**: Indoor temperature and similar Omni values
- **Light sensors**: Ambient light level

Load groups and blind groups are not exposed as HomeKit accessories. Use HomeKit rooms or scenes to group devices.

## Development

1. Clone the repository:
```bash
git clone https://github.com/smarterhomeapp/homebridge-vantage.git
cd homebridge-vantage
```

2. Install dependencies:
```bash
npm install
```

3. Build the project:
```bash
npm run build
```

4. Link for development:
```bash
npm link
```

## Troubleshooting

### Connection Issues
- Verify the IP address is correct, or leave it blank so mDNS can find the controller
- Check if SSL is required (ports 3010/2010 vs 3001/2001)
- Ensure username/password are correct if authentication is enabled

### Device Not Appearing
- Check the `omit` and `range` parameters
- Verify the device VID is within the specified range
- On Homebridge 2, pair each child bridge in the Home app. The main hub may have no Vantage devices.
- Check Homebridge logs for discovery errors

### Performance Issues
- Reduce the number of devices by using the `omit` parameter
- Restart Homebridge to force a fresh controller configuration download
- Consider using device ranges to limit discovery

## License

MIT License - see LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## Support

For issues and questions:
- [GitHub Issues](https://github.com/smarterhomeapp/homebridge-vantage/issues)
- [Homebridge Community](https://github.com/homebridge/homebridge) 
