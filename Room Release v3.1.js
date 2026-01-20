/**
 * Room Release Macro v3.1
 * ──────────────────────────────────────────────────────────
 * ATEA AS | Anders Solstad | anders.solstad@atea.no
 * 2026-01-20
 *
 * Allows users to release a room booking early, freeing up the room for others.
 *
 * Features:
 * - Adds a "Release room" button to the Control Panel
 * - Shows a 2-minute countdown after a call ends, then auto-releases the booking
 * - Works on both MTR and RoomOS devices (auto-detects mode)
 * - Removes legacy panel versions on startup
 * ──────────────────────────────────────────────────────────
 */

import xapi from 'xapi';

/***********************************************
 * CONFIGURATION
 ***********************************************/
const CONFIG = Object.freeze({
  PANEL_ID: 'release-room',
  PANEL_NAME: 'Release room',
  PANEL_COLOR: '#232323',
  ICON_URL: 'https://wxsd-sales.github.io/kiosk-demos/icons/calendar-xmark-white.png',
  COUNTDOWN_SEC: 180,
  FEEDBACK_ID: 'release_prompt',
  DEBUG: false,
  // Old panel IDs to remove (from previous versions)
  LEGACY_PANELS: ['decline-booking']
});

/***********************************************
 * STATE (minimal - per Cisco best practice)
 ***********************************************/
let timer = null;
let iconId = null;
let isMTR = false;

/***********************************************
 * LOGGING
 ***********************************************/
const log = CONFIG.DEBUG
  ? (m) => console.log(`[RoomRelease] ${m}`)
  : () => {};

/***********************************************
 * INIT - staggered to reduce resource spike
 ***********************************************/
function init() {
  setTimeout(() => {
    // 0. Remove legacy panels from old macro versions
    cleanupLegacyPanels();
  }, 50);

  setTimeout(async () => {
    // 1. Detect mode (proven method from your device)
    isMTR = await detectMTR();
    log(`Mode: ${isMTR ? 'MTR' : 'RoomOS'}`);
  }, 100);

  setTimeout(async () => {
    // 2. Download icon once
    try {
      const r = await xapi.Command.UserInterface.Extensions.Icon.Download({ Url: CONFIG.ICON_URL });
      iconId = r.IconId;
    } catch (e) { /* fallback icon */ }
  }, 300);

  setTimeout(() => {
    // 3. Create panel
    updatePanel();
  }, 600);

  setTimeout(() => {
    // 4. Subscribe events
    xapi.Event.UserInterface.Extensions.Panel.Clicked.on(onPanelClick);
    xapi.Event.UserInterface.Extensions.Widget.Action.on(onWidgetAction);
    xapi.Event.UserInterface.Message.Prompt.Response.on(onPromptResponse);

    // Call end detection - use appropriate method for each mode
    if (isMTR) {
      // MTR mode: ONLY use Teams InCall status (CallDisconnect fires incorrectly during MTR call setup)
      xapi.Status.MicrosoftTeams.Calling.InCall.on(onMTRCallChange);
    } else {
      // RoomOS mode: use CallDisconnect event
      xapi.Event.CallDisconnect.on(onCallDisconnect);
    }

    log('Ready');
  }, 1000);
}

/***********************************************
 * CLEANUP LEGACY PANELS
 ***********************************************/
function cleanupLegacyPanels() {
  CONFIG.LEGACY_PANELS.forEach(panelId => {
    xapi.Command.UserInterface.Extensions.Panel.Remove({ PanelId: panelId })
      .then(() => log(`Removed legacy panel: ${panelId}`))
      .catch(() => {});
  });
}

/***********************************************
 * MTR DETECTION - Check actual runtime mode
 ***********************************************/
async function detectMTR() {
  try {
    // Check if device is actually running in MTR mode
    const mode = await xapi.Status.MicrosoftTeams.Status.get();
    log(`MicrosoftTeams.Status: ${mode}`);
    return mode === 'Available' || mode === 'Registered';
  } catch (e) {
    log(`MTR detection failed: ${e.message}`);
    // Try alternative: check if MicrosoftTeams config exists and is enabled
    try {
      const enabled = await xapi.Config.MicrosoftTeams.Mode.get();
      log(`MicrosoftTeams.Mode config: ${enabled}`);
      return enabled === 'On';
    } catch (e2) {
      log(`MTR config check failed: ${e2.message}`);
      return false;
    }
  }
}

/***********************************************
 * CALL END HANDLERS
 ***********************************************/
async function onMTRCallChange(value) {
  if (value === 'False') {
    // Delay to let system settle (Cisco best practice)
    setTimeout(() => triggerReleaseCheck(), 2000);
  }
}

function onCallDisconnect() {
  setTimeout(() => triggerReleaseCheck(), 2000);
}

async function triggerReleaseCheck() {
  try {
    // Query system state instead of tracking (Cisco best practice)
    const calls = await xapi.Status.SystemUnit.State.NumberOfActiveCalls.get();
    if (parseInt(calls, 10) > 0) return;

    const bookingId = await xapi.Status.Bookings.Current.Id.get();
    if (bookingId && bookingId !== '') {
      showCountdown(bookingId);
    }
  } catch (e) {
    log(`Check failed: ${e.message}`);
  }
}

/***********************************************
 * UI EVENT HANDLERS
 ***********************************************/
async function onPanelClick(event) {
  if (event.PanelId !== CONFIG.PANEL_ID) return;

  try {
    const id = await xapi.Status.Bookings.Current.Id.get();
    if (id && id !== '') {
      const details = await getBookingDetails(id);
      updatePanel(details);
    } else {
      updatePanel(null);
    }
  } catch (e) {
    updatePanel(null);
  }
}

function onWidgetAction(event) {
  if (!event.WidgetId.startsWith(CONFIG.PANEL_ID)) return;
  if (event.Type !== 'clicked') return;

  if (event.WidgetId.endsWith('-cancel')) {
    xapi.Command.UserInterface.Extensions.Panel.Close().catch(() => {});
    return;
  }

  if (event.WidgetId.includes('-release-')) {
    const id = event.WidgetId.split('-release-')[1];
    if (isValidId(id)) {
      releaseBooking(id);
    }
  }
}

function onPromptResponse(event) {
  if (event.FeedbackId !== CONFIG.FEEDBACK_ID) return;

  clearTimer();

  if (event.OptionId === '1') {
    xapi.Status.Bookings.Current.Id.get()
      .then(id => { if (id) releaseBooking(id); })
      .catch(() => {});
  } else {
    xapi.Command.UserInterface.Message.Prompt.Clear({ FeedbackId: CONFIG.FEEDBACK_ID }).catch(() => {});
  }
}

/***********************************************
 * BOOKING OPERATIONS
 ***********************************************/
async function getBookingDetails(id) {
  try {
    const r = await xapi.Command.Bookings.Get({ Id: id });
    const b = r.Booking;
    return {
      id,
      title: sanitize(b.Title || 'Meeting'),
      start: fmtTime(b.Time.StartTime),
      end: fmtTime(b.Time.EndTime),
      meetingId: b.MeetingId
    };
  } catch (e) {
    return null;
  }
}

async function releaseBooking(bookingId) {
  clearTimer();

  // Close prompt and extension panel
  xapi.Command.UserInterface.Message.Prompt.Clear({ FeedbackId: CONFIG.FEEDBACK_ID }).catch(() => {});
  xapi.Command.UserInterface.Extensions.Panel.Close().catch(() => {});

  try {
    // Verify still current (prevent releasing wrong booking)
    const currentId = await xapi.Status.Bookings.Current.Id.get();
    if (currentId !== bookingId) {
      log('Booking changed, abort');
      return;
    }

    const details = await getBookingDetails(bookingId);
    if (!details || !details.meetingId) return;

    await xapi.Command.Bookings.Respond({ Type: 'Decline', MeetingId: details.meetingId });
    await xapi.Command.Bookings.Delete({ MeetingId: details.meetingId });

    xapi.Command.UserInterface.Message.Alert.Display({
      Title: 'Room Released',
      Text: 'Thank you!',
      Duration: 3
    }).catch(() => {});

    log('Released: ' + bookingId);
  } catch (e) {
    log(`Release error: ${e.message}`);
  }
}

/***********************************************
 * COUNTDOWN
 ***********************************************/
function showCountdown(bookingId) {
  clearTimer();
  let sec = CONFIG.COUNTDOWN_SEC;

  const tick = () => {
    if (sec <= 0) {
      clearTimer();
      releaseBooking(bookingId);
      return;
    }

    const m = Math.floor(sec / 60);
    const s = sec % 60;

    xapi.Command.UserInterface.Message.Prompt.Display({
      Title: 'Release room?',
      Text: `Auto-release in ${m > 0 ? m + 'm ' : ''}${s}s`,
      FeedbackId: CONFIG.FEEDBACK_ID,
      'Option.1': 'Yes',
      'Option.2': 'No'
    }).catch(() => clearTimer());

    sec--;
  };

  tick();
  timer = setInterval(tick, 1000);
}

function clearTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/***********************************************
 * PANEL
 ***********************************************/
function updatePanel(booking) {
  const icon = iconId
    ? `<Icon>Custom</Icon><CustomIcon><Id>${iconId}</Id></CustomIcon>`
    : '<Icon>Concierge</Icon>';

  const rows = booking
    ? `<Row><Widget><WidgetId>${CONFIG.PANEL_ID}-t</WidgetId><Name>${booking.title}</Name><Type>Text</Type><Options>size=4;align=center</Options></Widget></Row>
       <Row><Widget><WidgetId>${CONFIG.PANEL_ID}-time</WidgetId><Name>${booking.start} - ${booking.end}</Name><Type>Text</Type><Options>size=4;align=center</Options></Widget></Row>
       <Row><Widget><WidgetId>${CONFIG.PANEL_ID}-cancel</WidgetId><Name>Cancel</Name><Type>Button</Type><Options>size=2</Options></Widget>
            <Widget><WidgetId>${CONFIG.PANEL_ID}-release-${booking.id}</WidgetId><Name>Release</Name><Type>Button</Type><Options>size=2</Options></Widget></Row>`
    : `<Row><Widget><WidgetId>${CONFIG.PANEL_ID}-none</WidgetId><Name>No active booking</Name><Type>Text</Type><Options>size=4;align=center</Options></Widget></Row>
       <Row><Widget><WidgetId>${CONFIG.PANEL_ID}-cancel</WidgetId><Name>Close</Name><Type>Button</Type><Options>size=2</Options></Widget></Row>`;

  const xml = `<Extensions><Panel>
    <Location>ControlPanel</Location><Type>Home</Type>
    ${icon}<Color>${CONFIG.PANEL_COLOR}</Color>
    <Name>${CONFIG.PANEL_NAME}</Name><ActivityType>Custom</ActivityType>
    <Page><Name>${CONFIG.PANEL_NAME}</Name>${rows}<Options>hideRowNames=1</Options></Page>
  </Panel></Extensions>`;

  xapi.Command.UserInterface.Extensions.Panel.Save({ PanelId: CONFIG.PANEL_ID }, xml).catch(() => {});
}

/***********************************************
 * UTILITIES
 ***********************************************/
function sanitize(s) {
  return typeof s === 'string' ? s.replace(/[<>&"']/g, '').slice(0, 50) : '';
}

function isValidId(id) {
  return typeof id === 'string' && /^[\w-]{1,128}$/.test(id);
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return '--:--';
  }
}

/***********************************************
 * START
 ***********************************************/
init();
