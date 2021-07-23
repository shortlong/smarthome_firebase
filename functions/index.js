/**
 * Copyright 2018 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const functions = require('firebase-functions');
const {smarthome} = require('actions-on-google');
const {google} = require('googleapis');
const util = require('util');
const admin = require('firebase-admin');
// Initialize Firebase
admin.initializeApp();
const firebaseRef = admin.database().ref('/');
// Initialize Homegraph
const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/homegraph'],
});
const homegraph = google.homegraph({
  version: 'v1',
  auth: auth,
});
// Hardcoded user ID
const USER_ID = '123';

exports.login = functions.https.onRequest((request, response) => {
  if (request.method === 'GET') {
    functions.logger.log('Requesting login page');
    response.send(`
    <html>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <body>
        <form action="/login" method="post">
          <input type="hidden"
            name="responseurl" value="${request.query.responseurl}" />
          <button type="submit" style="font-size:14pt">
            Link this service to Google
          </button>
        </form>
      </body>
    </html>
  `);
  } else if (request.method === 'POST') {
    // Here, you should validate the user account.
    // In this sample, we do not do that.
    const responseurl = decodeURIComponent(request.body.responseurl);
    functions.logger.log(`Redirect to ${responseurl}`);
    return response.redirect(responseurl);
  } else {
    // Unsupported method
    response.send(405, 'Method Not Allowed');
  }
});

exports.fakeauth = functions.https.onRequest((request, response) => {
  const responseurl = util.format('%s?code=%s&state=%s',
      decodeURIComponent(request.query.redirect_uri), 'xxxxxx',
      request.query.state);
  functions.logger.log(`Set redirect as ${responseurl}`);
  return response.redirect(
      `/login?responseurl=${encodeURIComponent(responseurl)}`);
});

exports.faketoken = functions.https.onRequest((request, response) => {
  const grantType = request.query.grant_type ?
    request.query.grant_type : request.body.grant_type;
  const secondsInDay = 86400; // 60 * 60 * 24
  const HTTP_STATUS_OK = 200;
  functions.logger.log(`Grant type ${grantType}`);

  let obj;
  if (grantType === 'authorization_code') {
    obj = {
      token_type: 'bearer',
      access_token: '123access',
      refresh_token: '123refresh',
      expires_in: secondsInDay,
    };
  } else if (grantType === 'refresh_token') {
    obj = {
      token_type: 'bearer',
      access_token: '123access',
      expires_in: secondsInDay,
    };
  }
  response.status(HTTP_STATUS_OK)
      .json(obj);
});

const app = smarthome();

/**
 * A SYNC intent
 * occurs when the Assistant wants to know what devices the user has connected.
 * This is sent to your service when the user links an account.
 * You should respond with a JSON payload of all the user's devices and their capabilities.
 */
app.onSync((body) => {
  return {
    requestId: body.requestId,
    payload: {
      agentUserId: USER_ID,
      devices: [{

        id: 'curtain',
        type: 'action.devices.types.SWITCH',
        traits: [
          // OpenClose need secondary user verification
          // see: https://developers.google.com/assistant/smarthome/traits/openclose?hl=ja
          //'action.devices.traits.OpenClose'
          'action.devices.traits.OnOff'
        ],
        name: {
          defaultNames: ['My Curtain'],
          name: 'Curtain',
          nicknames: ['Curtain'],
        },
        deviceInfo: {
          manufacturer: 'My Smart Curtain',
        },
        willReportState: true,
        attributes: {
        },
      }],
    },
  };
});

/**
 * public ディレクトリ（UI）を消したので、代わりにレコードを初回作成する必要がある。
 * instead of below
 * https://github.com/googlecodelabs/smarthome-debug/blob/708016fba05ba43646b8dde864cb4ce12deff04c/washer-done/public/main.js#L91
 */
const setFirebase = async (deviceId) => {
  const OnOffDef = false; // close
  const pkg = {
    OnOff: {on: OnOffDef},
  };
  await firebaseRef.child(deviceId).set(pkg);
  return OnOffDef;
}

// see: https://firebase.google.com/docs/database/web/read-and-write?hl=ja
const queryFirebase = async (deviceId) => {
  const snapshot = await firebaseRef.child(deviceId).once('value');
  const snapshotVal = snapshot.val();
  let on = false;

  if (snapshotVal == null) {
    on = await setFirebase(deviceId);
  } else {
    on = snapshotVal.OnOff.on;
  }

  return {
    on: on
  };
};

const queryDevice = async (deviceId) => {
  const data = await queryFirebase(deviceId);
  return {
    on: data.on,
  };
};

/**
 * A QUERY intent
 * occurs when the Assistant wants to know the current state or status of a device.
 * You should respond with a JSON payload with the state of each requested device.
 */
app.onQuery(async (body) => {
  const {requestId} = body;
  const payload = {
    devices: {},
  };
  const queryPromises = [];
  const intent = body.inputs[0];
  for (const device of intent.payload.devices) {
    const deviceId = device.id;
    queryPromises.push(
        queryDevice(deviceId)
            .then((data) => {
              // Add response to device payload
              payload.devices[deviceId] = data;
            }) );
  }
  // Wait for all promises to resolve
  await Promise.all(queryPromises);
  return {
    requestId: requestId,
    payload: payload,
  };
});

const updateDevice = async (execution, deviceId) => {
  const {params, command} = execution;
  let state; let ref;
  switch (command) {
    // see: https://developers.google.com/assistant/smarthome/traits/onoff?hl=ja
    case 'action.devices.commands.OnOff':
      state = {on: params.on};
      ref = firebaseRef.child(deviceId).child('OnOff');
      break;
  }

  return ref.update(state)
      .then(() => state);
};

/**
 * An EXECUTE intent
 * occurs when the Assistant wants to control a device on a user's behalf.
 * You should respond with a JSON payload with the execution status of each requested device.
 */
app.onExecute(async (body) => {
  const {requestId} = body;
  functions.logger.log(`app.onExecute ${body}`);
  // Execution results are grouped by status
  const result = {
    ids: [],
    status: 'SUCCESS',
    states: {
      online: true,
    },
  };

  const executePromises = [];
  const intent = body.inputs[0];
  for (const command of intent.payload.commands) {
    for (const device of command.devices) {
      for (const execution of command.execution) {
        executePromises.push(
            updateDevice(execution, device.id)
                .then((data) => {
                  result.ids.push(device.id);
                  Object.assign(result.states, data);
                })
                .catch(() => functions.logger.error('EXECUTE', device.id)));
      }
    }
  }

  await Promise.all(executePromises);
  return {
    requestId: requestId,
    payload: {
      commands: [result],
    },
  };
});

/**
 * An DISCONNECT intent
 * occurs when the user unlinks their account from the Assistant.
 * You should stop sending events for this user's devices to the Assistant.
 */
app.onDisconnect((body, headers) => {
  functions.logger.log('User account unlinked from Google Assistant');
  // Return empty response
  return {};
});

exports.smarthome = functions.https.onRequest(app);

exports.requestsync = functions.https.onRequest(async (request, response) => {
  response.set('Access-Control-Allow-Origin', '*');
  functions.logger.info(`Request SYNC for user ${USER_ID}`);
  try {
    const res = await homegraph.devices.requestSync({
      requestBody: {
        agentUserId: USER_ID,
      },
    });
    functions.logger.info('Request sync response:', res.status, res.data);
    response.json(res.data);
  } catch (err) {
    functions.logger.error(err);
    response.status(500).send(`Error requesting sync: ${err}`);
  }
});

/**
 * Send a REPORT STATE call to the homegraph when data for any device id
 * has been changed.
 */
exports.reportstate = functions.database.ref('{deviceId}').onWrite(
    async (change, context) => {
      functions.logger.info('Firebase write event triggered Report State');
      const snapshot = change.after.val();

      const requestBody = {
        requestId: 'ff36a3cc', /* Any unique ID */
        agentUserId: USER_ID,
        payload: {
          devices: {
            states: {
              /* Report the current state of our curtain */
              [context.params.deviceId]: {
                on: snapshot.OnOff.on,
              },
            },
          },
        },
      };

      const res = await homegraph.devices.reportStateAndNotification({
        requestBody,
      });
      functions.logger.info('Report state response:', res.status, res.data);
    });