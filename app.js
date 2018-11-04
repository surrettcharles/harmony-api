// TODO - remove ALL eslint-disable comments

const path = require('path');
const mqtt = require('mqtt');
const express = require('express');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const parameterize = require('parameterize');
const config = require('config');

const HarmonyHubDiscover = require('harmonyhubjs-discover');
const harmony = require('harmonyhubjs-client');

const harmonyHubClients = {};
const harmonyActivitiesCache = {};
const harmonyActivityUpdateInterval = 1 * 60 * 1000; // 1 minute
const harmonyActivityUpdateTimers = {};

const harmonyHubStates = {};
const harmonyStateUpdateInterval = 5 * 1000; // 5 seconds
const harmonyStateUpdateTimers = {};

const harmonyDevicesCache = {};
const harmonyDeviceUpdateInterval = 1 * 60 * 1000; // 1 minute
const harmonyDeviceUpdateTimers = {};

const mqttClient = config.has('mqtt_options')
  ? mqtt.connect(config.get('mqtt_host'), config.get('mqtt_options'))
  : mqtt.connect(config.get('mqtt_host'));
const TOPIC_NAMESPACE = config.get('topic_namespace') || 'harmony-api';

const enableHTTPserver = config.has('enableHTTPserver')
  ? config.enableHTTPserver : true;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

const logFormat = '\'[:date[iso]] - :remote-addr - :method :url :status :response-time ms - :res[content-length]b\'';
app.use(morgan(logFormat));

// Middleware
// Check to make sure we have a harmonyHubClient to connect to
const hasHarmonyHubClient = (req, res, next) => {
  if (Object.keys(harmonyHubClients).length > 0) {
    next();
  } else {
    res.status(500).json({ message: 'No hubs available' });
  }
};
app.use(hasHarmonyHubClient);

const discover = new HarmonyHubDiscover(61991);

discover.on('online', (hubInfo) => {
  // Triggered when a new hub was found
  console.log(`Hub discovered: ${hubInfo.friendlyName} at ${hubInfo.ip}.`);

  if (hubInfo.ip) {
    harmony(hubInfo.ip).then((client) => {
      startProcessing(parameterize(hubInfo.friendlyName), client); // eslint-disable-line
    });
  }
});

discover.on('offline', (hubInfo) => {
  // Triggered when a hub disappeared
  console.log(`Hub lost: ${hubInfo.friendlyName} at ${hubInfo.ip}.`);
  if (!hubInfo.friendlyName) { return; }
  const hubSlug = parameterize(hubInfo.friendlyName);

  clearInterval(harmonyStateUpdateTimers[hubSlug]);
  clearInterval(harmonyActivityUpdateTimers[hubSlug]);
  delete (harmonyHubClients[hubSlug]);
  delete (harmonyActivitiesCache[hubSlug]);
  delete (harmonyHubStates[hubSlug]);
});

// Look for hubs:
console.log('Starting discovery.');
discover.start();

// mqtt api

mqttClient.on('connect', () => {
  mqttClient.subscribe(`${TOPIC_NAMESPACE}/hubs/+/activities/+/command`);
  mqttClient.subscribe(`${TOPIC_NAMESPACE}/hubs/+/devices/+/command`);
  mqttClient.subscribe(`${TOPIC_NAMESPACE}/hubs/+/command`);
});

mqttClient.on('message', (topic, message) => {
  const activityCommandPattern = new RegExp(/hubs\/(.*)\/activities\/(.*)\/command/);
  const deviceCommandPattern = new RegExp(/hubs\/(.*)\/devices\/(.*)\/command/);
  const currentActivityCommandPattern = new RegExp(/hubs\/(.*)\/command/);
  const activityCommandMatches = topic.match(activityCommandPattern);
  const deviceCommandMatches = topic.match(deviceCommandPattern);
  const currentActivityCommandMatches = topic.match(currentActivityCommandPattern);

  if (activityCommandMatches) {
    const hubSlug = activityCommandMatches[1];
    const activitySlug = activityCommandMatches[2];
    const state = message.toString();

    const activity = activityBySlugs(hubSlug, activitySlug); // eslint-disable-line
    if (!activity) { return; }

    if (state === 'on') {
      startActivity(hubSlug, activity.id); // eslint-disable-line
    } else if (state === 'off') {
      off(hubSlug); // eslint-disable-line
    }
  } else if (deviceCommandMatches) {
    const hubSlug = deviceCommandMatches[1];
    const deviceSlug = deviceCommandMatches[2];
    const messageComponents = message.toString().split(':');
    const repeat = messageComponents[1];

    const command = commandBySlugs(hubSlug, deviceSlug, messageComponents[0]); // eslint-disable-line
    if (!command) { return; }

    sendAction(hubSlug, command.action, repeat); // eslint-disable-line
  } else if (currentActivityCommandMatches) {
    const hubSlug = currentActivityCommandMatches[1];
    const messageComponents = message.toString().split(':');
    const commandSlug = messageComponents[0];
    const repeat = messageComponents[1];

    const hubState = harmonyHubStates[hubSlug];
    if (!hubState) { return; }

    const activity = activityBySlugs(hubSlug, hubState.current_activity.slug); // eslint-disable-line
    if (!activity) { return; }

    const command = activity.commands[commandSlug];
    if (!command) { return; }

    sendAction(hubSlug, command.action, repeat); // eslint-disable-line
  }
});

function startProcessing(hubSlug, harmonyClient) {
  harmonyHubClients[hubSlug] = harmonyClient;

  // update the list of activities
  updateActivities(hubSlug); // eslint-disable-line
  // then do it on the set interval
  clearInterval(harmonyActivityUpdateTimers[hubSlug]);
  harmonyActivityUpdateTimers[hubSlug] = setInterval(() => { updateActivities(hubSlug); }, harmonyActivityUpdateInterval); // eslint-disable-line

  // update the state
  updateState(hubSlug); // eslint-disable-line
  // update the list of activities on the set interval
  clearInterval(harmonyStateUpdateTimers[hubSlug]);
  harmonyStateUpdateTimers[hubSlug] = setInterval(() => { updateState(hubSlug); }, harmonyStateUpdateInterval); // eslint-disable-line

  // update devices
  updateDevices(hubSlug); // eslint-disable-line
  // update the list of devices on the set interval
  clearInterval(harmonyDeviceUpdateTimers[hubSlug]);
  harmonyDeviceUpdateTimers[hubSlug] = setInterval(() => { updateDevices(hubSlug); }, harmonyDeviceUpdateInterval); // eslint-disable-line
}

function updateActivities(hubSlug) {
  const harmonyHubClient = harmonyHubClients[hubSlug];

  if (!harmonyHubClient) { return; }
  console.log(`Updating activities for ${hubSlug}.`);

  try {
    harmonyHubClient.getActivities().then((activities) => {
      const foundActivities = {};
      activities.some((activity) => { // eslint-disable-line
        foundActivities[activity.id] = {
          id: activity.id,
          slug: parameterize(activity.label),
          label: activity.label,
          isAVActivity: activity.isAVActivity,
        };
        Object.defineProperty(foundActivities[activity.id], 'commands', {
          enumerable: false,
          writeable: true,
          value: getCommandsFromControlGroup(activity.controlGroup), // eslint-disable-line
        });
      });
      harmonyActivitiesCache[hubSlug] = foundActivities;
    });
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
  }
}

function updateState(hubSlug) {
  const harmonyHubClient = harmonyHubClients[hubSlug];

  if (!harmonyHubClient) { return; }
  console.log(`Updating state for ${hubSlug}.`);

  // save for comparing later after we get the true current state
  const previousActivity = currentActivity(hubSlug); // eslint-disable-line

  try {
    harmonyHubClient.getCurrentActivity().then((activityId) => {
      let data = { off: true };

      const activity = harmonyActivitiesCache[hubSlug][activityId];
      const commands = Object.keys(activity.commands).map(commandSlug => activity.commands[commandSlug]); // eslint-disable-line

      if (activityId !== -1 && activity) {
        data = { off: false, current_activity: activity, activity_commands: commands };
      } else {
        data = { off: true, current_activity: activity, activity_commands: commands };
      }

      // cache state for later
      harmonyHubStates[hubSlug] = data;

      if (!previousActivity || (activity.id !== previousActivity.id)) {
        publish(`hubs/${hubSlug}/current_activity`, activity.slug, { retain: true }); // eslint-disable-line
        publish(`hubs/${hubSlug}/state`, activity.id === -1 ? 'off' : 'on', { retain: true }); // eslint-disable-line

        for (let i = 0; i < cachedHarmonyActivities(hubSlug).length; i += 1) { // eslint-disable-line
          const activities = cachedHarmonyActivities(hubSlug); // eslint-disable-line
          const cachedActivity = activities[i];

          if (activity === cachedActivity) {
            publish(`hubs/${hubSlug}/activities/${cachedActivity.slug}/state`, 'on', { retain: true }); // eslint-disable-line
          } else {
            publish(`hubs/${hubSlug}/activities/${cachedActivity.slug}/state`, 'off', { retain: true }); // eslint-disable-line
          }
        }
      }
    });
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
  }
}

function updateDevices(hubSlug) {
  const harmonyHubClient = harmonyHubClients[hubSlug];

  if (!harmonyHubClient) { return; }
  console.log(`Updating devices for ${hubSlug}.`);
  try {
    harmonyHubClient.getAvailableCommands().then((commands) => {
      const foundDevices = {};
      commands.device.some((device) => { // eslint-disable-line
        const deviceCommands = getCommandsFromControlGroup(device.controlGroup); // eslint-disable-line
        foundDevices[device.id] = {
          id: device.id,
          slug: parameterize(device.label),
          label: device.label,
        };
        Object.defineProperty(foundDevices[device.id], 'commands', {
          enumerable: false,
          writeable: true,
          value: deviceCommands,
        });
      });

      harmonyDevicesCache[hubSlug] = foundDevices;
    });
  } catch (err) {
    console.log(`Devices ERROR: ${err.message}`);
  }
}

function getCommandsFromControlGroup(controlGroup) {
  const deviceCommands = {};
  controlGroup.some((group) => { // eslint-disable-line
    group.function.some((func) => { // eslint-disable-line
      const slug = parameterize(func.label);
      deviceCommands[slug] = { name: func.name, slug, label: func.label };
      Object.defineProperty(deviceCommands[slug], 'action', {
        enumerable: false,
        writeable: true,
        value: func.action.replace(/:/g, '::'),
      });
    });
  });
  return deviceCommands;
}

function cachedHarmonyActivities(hubSlug) {
  const activities = harmonyActivitiesCache[hubSlug];
  if (!activities) { return []; }

  return Object.keys(harmonyActivitiesCache[hubSlug]).map(key => harmonyActivitiesCache[hubSlug][key]); // eslint-disable-line
}

function currentActivity(hubSlug) {
  const harmonyHubClient = harmonyHubClients[hubSlug];
  const harmonyHubState = harmonyHubStates[hubSlug];
  if (!harmonyHubClient || !harmonyHubState) { return null; }

  return harmonyHubState.current_activity;
}

function activityBySlugs(hubSlug, activitySlug) {
  let activity;
  cachedHarmonyActivities(hubSlug).some((a) => { // eslint-disable-line
    if (a.slug === activitySlug) {
      activity = a;
      return true;
    }
  });

  return activity;
}

function activityCommandsBySlugs(hubSlug, activitySlug) { // eslint-disable-line
  const activity = activityBySlugs(hubSlug, activitySlug);

  if (activity) {
    return Object.keys(activity.commands).map(commandSlug => activity.commands[commandSlug]);
  }
}

function cachedHarmonyDevices(hubSlug) {
  const devices = harmonyDevicesCache[hubSlug];
  if (!devices) { return []; }

  return Object.keys(harmonyDevicesCache[hubSlug]).map(key => harmonyDevicesCache[hubSlug][key]);
}

function deviceBySlugs(hubSlug, deviceSlug) {
  let device;
  cachedHarmonyDevices(hubSlug).some((d) => { // eslint-disable-line
    if (d.slug === deviceSlug) {
      device = d;
      return true;
    }
  });

  return device;
}

function commandBySlugs(hubSlug, deviceSlug, commandSlug) {
  let command;
  const device = deviceBySlugs(hubSlug, deviceSlug);
  if (device) {
    if (commandSlug in device.commands) {
      command = device.commands[commandSlug];
    }
  }

  return command;
}

function off(hubSlug) {
  const harmonyHubClient = harmonyHubClients[hubSlug];
  if (!harmonyHubClient) { return; }

  harmonyHubClient.turnOff().then(() => {
    updateState(hubSlug);
  });
}

function startActivity(hubSlug, activityId) {
  const harmonyHubClient = harmonyHubClients[hubSlug];
  if (!harmonyHubClient) { return; }

  harmonyHubClient.startActivity(activityId).then(() => {
    updateState(hubSlug);
  });
}

function sendAction(hubSlug, action, repeat) {
  repeat = Number.parseInt(repeat, 10) || 1; // eslint-disable-line
  const harmonyHubClient = harmonyHubClients[hubSlug];
  if (!harmonyHubClient) { return; }

  const pressAction = `action=${action}:status=press:timestamp=0`;
  const releaseAction = `action=${action}:status=release:timestamp=55`;
  for (let i = 0; i < repeat; i += 1) {
    harmonyHubClient.send('holdAction', pressAction).then(() => {
      harmonyHubClient.send('holdAction', releaseAction);
    });
  }
}

function publish(topic, message, options) {
  mqttClient.publish(`${TOPIC_NAMESPACE}/${topic}`, message, options);
}

app.get('/_ping', (req, res) => {
  res.send('OK');
});

app.get('/', (req, res) => {
  res.sendfile('index.html');
});

app.get('/hubs', (req, res) => {
  res.json({ hubs: Object.keys(harmonyHubClients) });
});

app.get('/hubs/:hubSlug/activities', (req, res) => {
  const { hubSlug } = req.params;
  const harmonyHubClient = harmonyHubClients[hubSlug];

  if (harmonyHubClient) {
    res.json({ activities: cachedHarmonyActivities(hubSlug) });
  } else {
    res.status(404).json({ message: 'Not Found' });
  }
});

app.get('/hubs/:hubSlug/activities/:activitySlug/commands', (req, res) => {
  const { hubSlug, activitySlug } = req.params;
  const commands = activityCommandsBySlugs(hubSlug, activitySlug);

  if (commands) {
    res.json({ commands });
  } else {
    res.status(404).json({ message: 'Not Found' });
  }
});

app.get('/hubs/:hubSlug/devices', (req, res) => {
  const { hubSlug } = req.params;
  const harmonyHubClient = harmonyHubClients[hubSlug];

  if (harmonyHubClient) {
    res.json({ devices: cachedHarmonyDevices(hubSlug) });
  } else {
    res.status(404).json({ message: 'Not Found' });
  }
});

app.get('/hubs/:hubSlug/devices/:deviceSlug/commands', (req, res) => {
  const { hubSlug, deviceSlug } = req.params;
  const device = deviceBySlugs(hubSlug, deviceSlug);

  if (device) {
    const commands = Object.keys(device.commands).map(commandSlug => device.commands[commandSlug]);
    res.json({ commands });
  } else {
    res.status(404).json({ message: 'Not Found' });
  }
});

app.get('/hubs/:hubSlug/status', (req, res) => {
  const { hubSlug } = req.params;
  const harmonyHubClient = harmonyHubClients[hubSlug];

  if (harmonyHubClient) {
    res.json(harmonyHubStates[hubSlug]);
  } else {
    res.status(404).json({ message: 'Not Found' });
  }
});

app.get('/hubs/:hubSlug/commands', (req, res) => {
  const { hubSlug } = req.params;
  const activitySlug = harmonyHubStates[hubSlug].current_activity.slug;

  const commands = activityCommandsBySlugs(hubSlug, activitySlug);
  if (commands) {
    res.json({ commands });
  } else {
    res.status(404).json({ message: 'Not Found' });
  }
});

app.post('/hubs/:hubSlug/commands/:commandSlug', (req, res) => {
  const { hubSlug, commandSlug } = req.params;
  const activitySlug = harmonyHubStates[hubSlug].current_activity.slug;

  const activity = activityBySlugs(hubSlug, activitySlug);
  if (activity && commandSlug in activity.commands) {
    sendAction(hubSlug, activity.commands[commandSlug].action, req.query.repeat);

    res.json({ message: 'ok' });
  } else {
    res.status(404).json({ message: 'Not Found' });
  }
});

app.put('/hubs/:hubSlug/off', (req, res) => {
  const { hubSlug } = req.params;
  const harmonyHubClient = harmonyHubClients[hubSlug];

  if (harmonyHubClient) {
    off(hubSlug);
    res.json({ message: 'ok' });
  } else {
    res.status(404).json({ message: 'Not Found' });
  }
});

// DEPRECATED
app.post('/hubs/:hubSlug/start_activity', (req, res) => {
  const activity = activityBySlugs(req.params.hubSlug, req.query.activity);

  if (activity) {
    startActivity(req.params.hubSlug, activity.id);

    res.json({ message: 'ok' });
  } else {
    res.status(404).json({ message: 'Not Found' });
  }
});

app.post('/hubs/:hubSlug/activities/:activitySlug', (req, res) => {
  const activity = activityBySlugs(req.params.hubSlug, req.params.activitySlug);

  if (activity) {
    startActivity(req.params.hubSlug, activity.id);

    res.json({ message: 'ok' });
  } else {
    res.status(404).json({ message: 'Not Found' });
  }
});

app.post('/hubs/:hubSlug/devices/:deviceSlug/commands/:commandSlug', (req, res) => {
  const command = commandBySlugs(req.params.hubSlug, req.params.deviceSlug, req.params.commandSlug);

  if (command) {
    sendAction(req.params.hubSlug, command.action, req.query.repeat);

    res.json({ message: 'ok' });
  } else {
    res.status(404).json({ message: 'Not Found' });
  }
});

app.get('/hubs_for_index', (req, res) => {
  const hubSlugs = Object.keys(harmonyHubClients);
  let output = '';

  hubSlugs.forEach((hubSlug) => {
    output += `<h3 class="hub-name">${hubSlug.replace('-', ' ')}</h3>`;
    output += `<p><span class="method">GET</span> <a href="/hubs/${hubSlug}/status">/hubs/${hubSlug}/status</a></p>`;
    output += `<p><span class="method">GET</span> <a href="/hubs/${hubSlug}/activities">/hubs/${hubSlug}/activities</a></p>`;
    output += `<p><span class="method">GET</span> <a href="/hubs/${hubSlug}/commands">/hubs/${hubSlug}/commands</a></p>`;
    cachedHarmonyActivities(hubSlug).forEach((activity) => {
      const context = `/hubs/${hubSlug}/activities/${activity.slug}/commands`;
      output += `<p><span class="method">GET</span> <a href="${context}">${context}</a></p>`;
    });
    output += `<p><span class="method">GET</span> <a href="/hubs/${hubSlug}/devices">/hubs/${hubSlug}/devices</a></p>`;
    cachedHarmonyDevices(hubSlug).forEach((device) => {
      const context = `/hubs/${hubSlug}/devices/${device.slug}/commands`;
      output += `<p><span class="method">GET</span> <a href="${context}">${context}</a></p>`;
    });
  });

  res.send(output);
});

if (enableHTTPserver) {
  app.listen(process.env.PORT || 8282);
}
