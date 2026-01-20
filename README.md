# Cisco Room Release

A macro for Cisco video devices that lets users release room bookings early, freeing up the room for others.

## What it does

Lets users release a room booking before it ends, freeing up the room for others. Two release methods:

- **Manual**: Tap "Release room" in the Control Panel to release immediately
- **Automatic**: After a call ends, a countdown prompt appears and auto-releases if no one responds

Works on both RoomOS and Microsoft Teams Rooms (MTR) devices.

## Requirements

- Cisco video device (Room, Board, or Desk series)
- RoomOS 10+ or MTR mode
- Device registered to Cisco Control Hub
- Hybrid Calendar connected (for booking integration)
- Macro provisioning enabled on the device

## Installation

1. Open the Cisco device's web interface
2. Navigate to **Customization > Macro Editor**
3. Create a new macro and paste the contents of `Room Release v3.1.js`
4. Save and enable the macro

## Configuration

Edit the `CONFIG` object at the top of the file:

| Option | Default | Description |
|--------|---------|-------------|
| `COUNTDOWN_SEC` | `180` | Seconds before auto-release after call ends |
| `PANEL_NAME` | `Release room` | Button label in Control Panel |
| `PANEL_COLOR` | `#232323` | Button background color |
| `DEBUG` | `false` | Enable console logging |

## How it works

The macro subscribes to call disconnect events and checks if there's an active booking. If so, it displays a prompt with a countdown timer. When the timer expires (or the user confirms), it calls `Bookings.Respond` with `Decline` and deletes the booking, making the room available in the calendar system.

On MTR devices, the macro monitors `MicrosoftTeams.Calling.InCall` status instead of `CallDisconnect` events to avoid false triggers during call setup.

## License

MIT

## Author

Anders Solstad — anders.solstad@atea.no
ATEA AS
