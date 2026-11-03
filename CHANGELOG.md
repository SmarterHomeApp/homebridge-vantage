# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.6] - 2026-11-03

### Added
- Loads whose name contains `fan` are HomeKit fans with an on/off control and a 0–100 speed slider. Speed uses the same Vantage dim level as a light (`Load.Ramp`). HVAC helper contacts named Fan stay hidden.

## [1.1.5] - 2026-11-03

### Fixed
- If a load or sensor's Area VID is missing from the Area list, add a placeholder room to `/tmp/vantage.dc` (Area `0` is named Unassigned). Organize Home aborts on the first HomeKit accessory it cannot map to a room.

## [1.1.4] - 2026-11-03

### Fixed
- Write `/tmp/vantage.dc` the way 1.0.8 did: Infusion `AreaID` is emitted as `Area` so Organize Home can map loads, relays, blinds, and thermostats into rooms.

## [1.1.3] - 2026-11-03

### Fixed
- Write `/tmp/vantage.dc` as text-only elements so the SmarterHome iOS XML parser can convert it to JSON. Mixed content such as `<Parent>14<Position>1</Position></Parent>` made Organize Home fail; nested objects now keep only their text (e.g. `<Parent>14</Parent>`). Relay loads stay in the dump as `<Load>` objects.
- Omit DryContact, Temperature, LightSensor, and OmniSensor from `/tmp/vantage.dc`. Those objects use Area `0`, and Organize Home aborts when it cannot map a HomeKit accessory to a room.

## [1.1.2] - 2026-11-03

### Fixed
- Stop emitting xml2js `_` character data as `<_>` tags in reconstructed configuration XML. That threw `obj[charkey].match is not a function` and rejected a valid live download.

## [1.1.1] - 2026-11-03

### Fixed
- Do not treat an Area-only configuration download as complete. That was causing `no discoverable Vantage objects` after a child-bridge restart, especially with `usecache` disabled.
- If live discovery fails and cache is off or missing, keep existing Homebridge accessories instead of failing startup.
- After a plugin update, retry the configured controller IP before mDNS, and retry the live configuration download once. A busy InFusion during child-bridge SIGTERM was being treated as a dead IP.
- Always write `/tmp/vantage.dc` from the configuration Homebridge actually uses, including persistent-cache fallback. Organize Home reads that dump, not the Homebridge storage cache, so a failed live download previously left it stale even with `usecache` on.
- Serialize nested Vantage object fields as XML elements in `/tmp/vantage.dc` instead of `[object Object]`.

## [1.1.0] - 2026-11-02

### Added
- mDNS discovery when no controller IP is configured, or when the configured address does not respond. Reconnects also retry discovery after a power-cycle IP change.
- Include flags for lights, blinds, thermostats, and sensors.
- If login as `admin` fails or times out, retry as `administrator` before continuing unauthenticated discovery.
- Broader discovery: original Vantage families plus extra load, blind, thermostat, and sensor types classified by exact family first, then capability fields.
- HomeKit name sanitization for HAP 2.3 (`"`, `?`, trailing punctuation).
- Tests for cache safety, VID ranges, include flags, classification, thermostat sentinels, and HomeKit names.

### Changed
- Fresh controller download is always attempted first. The persistent cache is only a last-known-good fallback.
- Invalid thermostat values such as `999` or `0` are ignored or replaced with legal HomeKit setpoints so pairing does not stall.
- Config UI and README now treat `name` as a label, `ipaddress` as optional, and document Homebridge 2 child-bridge splits.

### Fixed
- Thermostat helper dry contacts and child temperature objects are no longer registered as standalone sensors.

## [1.0.2] - 2025-09-11

### Fixed
- Correct plugin identifier registration by setting `PLUGIN_NAME` to `@smarterhomeapp/homebridge-vantage`.
- Resolved false negatives in port detection by probing 3001 and 2001 sequentially with backoff.
- Addressed TypeScript error when assigning `Promise.all` results; now using local results with boolean coercion.

### Changed
- Standardized XML parsing on `xml2js` to match implementation and dependencies.
- Minor logging improvements for port probing and connection lifecycle.

## [1.0.1] - 2025-09-27

### Fixed
- Fixed 1% brightness issue where lights would be set to 1% even when turned off or set to other percentages
- Removed redundant `setRelayOrDim` function that was causing inconsistent brightness behavior
- Improved brightness state management to match original implementation
- Updated real-time status updates to use modern Homebridge API (replaced deprecated `getValue()`)

### Changed
- Simplified brightness control logic by using `setBrightness` and `setRelay` functions directly
- Updated status update handling to prevent UI conflicts during slider interactions
- Real-time status updates
- SSL/TLS support
- Device filtering and range selection
- Configuration caching
- TypeScript implementation
- Modern Homebridge plugin architecture

### Features
- **Lighting**: Full control of dimmers, RGB lights, and relays
- **HVAC**: Complete thermostat control with auto mode
- **Window Coverings**: Position control for blinds and shades
- **Security**: SSL/TLS encrypted connections
- **Performance**: Configuration caching for faster discovery
- **Flexibility**: Device filtering and range selection

### Technical
- Converted from legacy JavaScript to TypeScript
- Updated to modern Homebridge plugin format
- Improved error handling and logging
- Better type safety and code organization
- Comprehensive documentation 